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
 * ChoiceNode：值选择。
 *
 * @note 它不是调度级分支；whenTrue / whenFalse 两条上游都会执行。
 *       调度级 BranchNode 在后续运行时步骤实现。
 */
export class ChoiceNode extends GraphNode{

    override readonly type = HarnessBuiltinNodeType.Choice;

    override get inputs(): readonly InputPortSpec[]{
        return [
            { name: "condition", type: "json", required: true },
            { name: "whenTrue", type: "any", required: true },
            { name: "whenFalse", type: "any", required: true },
        ];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{
            name: "value",
            type: "any",
            supportedModes: ["value"],
            defaultMode: "value",
        }];
    }

    override async execute(
        _ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const selected: HarnessValue | undefined = readBooleanCondition(inputs.condition)
            ? inputs.whenTrue
            : inputs.whenFalse;

        if (selected === undefined){
            throw new HarnessError(
                HarnessErrorCode.MissingValue,
                `${this.type} selected branch has no value`,
                { nodeId: this.id },
            );
        }

        return { value: selected };
    }
}
