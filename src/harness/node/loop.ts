import { HarnessError, HarnessErrorCode } from "../base/error";
import { isRecord } from "../base/utils";
import { HarnessBuiltinNodeType } from "../definition";
import { GraphNode } from "../graph/node";
import type { NodeContext } from "../graph/node";
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
import {
    errorText,
    readConfig,
    readOptionalPositiveInteger,
} from "./helpers";
import { runSubgraph } from "./subgraph-runner";

/**
 * LoopNode：有界循环。
 *
 * 内层图通过 `core.value` 读取：
 * - state：当前 JSON 状态
 * - iteration：当前下标
 *
 * 内层 `core.output.json` 约定为 `{ state, done? }`：
 * - state 写回下一轮；
 * - done === true 时提前结束；
 * - 最多执行 config.maxIterations 次。
 */
export class LoopNode extends GraphNode{

    override readonly type = HarnessBuiltinNodeType.Loop;

    constructor(
        private readonly _registry: NodeTypeRegistry,
        id: string,
        config: JsonValue | undefined = undefined,
        inputDefaults: NodeInputValues = {},
        ui: JsonObject | undefined = undefined,
    ){
        super(id, config, inputDefaults, ui);
    }

    override get inputs(): readonly InputPortSpec[]{
        return [{ name: "initial", type: "any" }];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [
            {
                name: "value",
                type: "any",
                supportedModes: ["value"],
                defaultMode: "value",
            },
            {
                name: "iterations",
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

        const maxIterations = readOptionalPositiveInteger(
            config,
            "maxIterations",
            this.type,
        );
        if (maxIterations === undefined){
            throw new HarnessError(
                HarnessErrorCode.InvalidNode,
                `${this.type}.maxIterations is required`,
                { nodeId: this.id },
            );
        }

        let state: HarnessValue = inputs.initial ?? { type: "json", value: null };
        let iterations = 0;

        for (let index = 0; index < maxIterations; index += 1){
            ctx.publish(`loop.${this.id}.iteration`, {
                index,
                maxIterations,
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
                    prefix: `loop.${this.id}.${String(index)}`,
                    input: {
                        values: {
                            state,
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

            iterations = index + 1;
            const output = result.outputs.json;
            if (output?.type === "json"){
                const container = output.value;
                if (isRecord(container)){
                    if (container.state !== undefined){
                        state = { type: "json", value: container.state };
                    }
                    if (container.done === true) break;
                }
            }
        }

        return {
            value: state,
            iterations: { type: "json", value: iterations },
        };
    }
}
