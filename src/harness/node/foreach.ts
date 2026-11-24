import { HarnessError, HarnessErrorCode } from "../base/error";
import { isRecord } from "../base/utils";
import { HarnessBuiltinNodeType } from "../definition";
import { GraphNode } from "../graph/node";
import type { EmbeddedGraph, NodeContext } from "../graph/node";
import type { NodeTypeRegistry } from "../graph/registry";
import {
    harnessValueToJson,
} from "../graph/type";
import type {
    HarnessValue,
    InputPortSpec,
    JsonObject,
    JsonValue,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "../graph/type";
import type { GraphRunResult } from "../runtime/types";
import { readEmbeddedGraph } from "./embedded-graph";
import { errorText, readConfig, readOptionalString } from "./helpers";
import { runSubgraph } from "./subgraph-runner";

/**
 * ForEachNode：对内层子图做数组遍历。
 *
 * 内层图通过 `core.value` 读取：
 * - item：当前 JSON 元素
 * - iteration：当前下标
 *
 * 每个元素执行一次；结果按顺序放入 results JSON 数组。
 */
export class ForEachNode extends GraphNode{

    override readonly type = HarnessBuiltinNodeType.ForEach;

    constructor(
        private readonly _registry: NodeTypeRegistry,
        id: string,
        config: JsonValue | undefined = undefined,
        inputDefaults: NodeInputValues = {},
        ui: JsonObject | undefined = undefined,
    ){
        super(id, config, inputDefaults, ui);
    }

    override get embeddedGraphs(): readonly EmbeddedGraph[]{
        return [readEmbeddedGraph(
            this.config,
            this.type,
            this._registry,
            `forEach.${this.id}`,
        )];
    }

    override get inputs(): readonly InputPortSpec[]{
        return [{ name: "items", type: "json", required: true }];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [
            {
                name: "results",
                type: "json",
                supportedModes: ["value"],
                defaultMode: "value",
            },
            {
                name: "count",
                type: "json",
                supportedModes: ["value"],
                defaultMode: "value",
            },
            {
                name: "attachments",
                type: "attachments",
                supportedModes: ["value"],
                defaultMode: "value",
            },
        ];
    }

    override async execute(
        ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const config = readConfig(this.config, this.type);
        const graphDocument = config.graph;
        if (!isRecord(graphDocument)){
            throw new HarnessError(
                HarnessErrorCode.InvalidNode,
                `${this.type} requires config.graph to be a GraphDocument`,
                { nodeId: this.id },
            );
        }

        const items = inputs.items;
        if (items?.type !== "json" || !Array.isArray(items.value)){
            throw new HarnessError(
                HarnessErrorCode.InvalidValue,
                `${this.type} requires a JSON array in items`,
                { nodeId: this.id },
            );
        }

        const resultPort = readOptionalString(config, "resultPort", this.type) ?? "text";
        const results: JsonValue[] = [];
        type AttachmentValue = Extract<HarnessValue, { type: "attachments" }>;
        const attachments: AttachmentValue["attachments"][number][] = [];
        const seenAttachments = new Set<string>();

        for (const [index, item] of items.value.entries()){
            ctx.publish(`forEach.${this.id}.iteration`, {
                index,
                total: items.value.length,
            });
            if (ctx.signal.aborted){
                throw new HarnessError(
                    HarnessErrorCode.NodeExecutionFailed,
                    `${this.type} was aborted`,
                    { nodeId: this.id },
                );
            }

            let result: GraphRunResult;
            try{
                result = await runSubgraph({
                    registry: this._registry,
                    ctx,
                    document: graphDocument,
                    prefix: `forEach.${this.id}.${String(index)}`,
                    input: {
                        values: {
                            item: { type: "json", value: item },
                            iteration: { type: "json", value: index },
                        },
                    },
                });
            }catch(error){
                throw new HarnessError(
                    HarnessErrorCode.InvalidNode,
                    `${this.type} has an invalid graph: ${errorText(error)}`,
                    { nodeId: this.id, origin: error },
                );
            }

            if (result.status !== "completed"){
                throw new HarnessError(
                    HarnessErrorCode.NodeExecutionFailed,
                    `${this.type} iteration ${String(index)} failed: `
                        + errorText(result.error ?? result.status),
                    { nodeId: this.id, origin: result.error },
                );
            }

            const output: HarnessValue | undefined = result.outputs[resultPort];
            results.push(output === undefined ? null : harnessValueToJson(output));

            const iterationAttachments = result.outputs.attachments;
            if (iterationAttachments?.type === "attachments"){
                for (const attachment of iterationAttachments.attachments){
                    if (seenAttachments.has(attachment.contentHash)) continue;
                    seenAttachments.add(attachment.contentHash);
                    attachments.push(attachment);
                }
            }
        }

        return {
            results: { type: "json", value: results },
            count: { type: "json", value: results.length },
            attachments: { type: "attachments", attachments },
        };
    }
}
