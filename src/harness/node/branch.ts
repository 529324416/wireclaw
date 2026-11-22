import { HarnessError, HarnessErrorCode } from "../base/error";
import { HarnessBuiltinNodeType } from "../definition";
import { GraphNode } from "../graph/node";
import type { NodeContext } from "../graph/node";
import type {
    HarnessValue,
    InputPortSpec,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "../graph/type";
import { readBooleanCondition } from "./helpers";

/**
 * BranchNode：调度级分支。
 *
 * 只在一个输出端口产出 value；另一个输出端口不产出，运行时会把该端口标记为
 * skipped，并沿下游传播。下游用 MergeNode 汇合。
 */
export class BranchNode extends GraphNode{

    override readonly type = HarnessBuiltinNodeType.Branch;

    override get inputs(): readonly InputPortSpec[]{
        return [
            { name: "value", type: "any", required: true },
            { name: "condition", type: "json", required: true },
        ];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [
            {
                name: "true",
                type: "any",
                supportedModes: ["value"],
                defaultMode: "value",
                exclusiveGroup: "branch",
            },
            {
                name: "false",
                type: "any",
                supportedModes: ["value"],
                defaultMode: "value",
                exclusiveGroup: "branch",
            },
        ];
    }

    override async execute(
        _ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const value: HarnessValue | undefined = inputs.value;
        if (value === undefined){
            throw new HarnessError(
                HarnessErrorCode.MissingValue,
                `${this.type} requires a value`,
                { nodeId: this.id },
            );
        }

        const condition = readBooleanCondition(inputs.condition);
        return condition ? { true: value } : { false: value };
    }
}
