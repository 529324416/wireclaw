import { HarnessError, HarnessErrorCode } from "../base/error";
import { isRecord } from "../base/utils";
import { HarnessBuiltinNodeType } from "../definition";
import { GraphNode } from "../graph/node";
import type { EmbeddedGraph, NodeContext } from "../graph/node";
import type { NodeTypeRegistry } from "../graph/registry";
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
import { attachmentRefs, errorText, readConfig } from "./helpers";
import { runSubgraph } from "./subgraph-runner";

/**
 * SubgraphNode：用一张内嵌 Graph 作为节点。
 *
 * - 外层输入映射到内层 `core.input` 的 text / attachments；
 * - 内层 `core.output` 的 text / attachments / json 映射回外层输出；
 * - 内层 EventTrigger 的 custom 事件以 `subgraph.<nodeId>.<event>` 转发；
 * - 内层 node:skipped 事件以 `subgraph.<nodeId>.node:skipped` 转发；
 * - 内层 Graph 必须能由同一个 NodeTypeRegistry 反序列化。
 */
export class SubgraphNode extends GraphNode{

    override readonly type = HarnessBuiltinNodeType.Subgraph;

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
            `subgraph.${this.id}`,
        )];
    }

    override get inputs(): readonly InputPortSpec[]{
        return [
            { name: "input", type: "text" },
            { name: "attachments", type: "attachments" },
        ];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [
            {
                name: "text",
                type: "text",
                supportedModes: ["value", "stream"],
                defaultMode: "value",
            },
            {
                name: "attachments",
                type: "attachments",
                supportedModes: ["value"],
                defaultMode: "value",
            },
            {
                name: "json",
                type: "json",
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

        const text = inputs.input?.type === "text" ? inputs.input.text : "";
        let result: GraphRunResult;
        try{
            result = await runSubgraph({
                registry: this._registry,
                ctx,
                document: graphDocument,
                input: {
                    text,
                    attachments: attachmentRefs(inputs.attachments),
                },
                prefix: `subgraph.${this.id}`,
            });
        }catch(error){
            throw new HarnessError(
                HarnessErrorCode.InvalidNode,
                `Subgraph "${this.id}" has an invalid graph: ${errorText(error)}`,
                { nodeId: this.id, origin: error },
            );
        }

        if (result.status !== "completed"){
            throw new HarnessError(
                HarnessErrorCode.NodeExecutionFailed,
                `Subgraph "${this.id}" failed: ${errorText(result.error ?? result.status)}`,
                { nodeId: this.id, origin: result.error },
            );
        }

        const outputs: Record<string, HarnessValue> = {};
        for (const port of this.outputs){
            const value = result.outputs[port.name];
            if (value !== undefined) outputs[port.name] = value;
        }
        return outputs;
    }
}
