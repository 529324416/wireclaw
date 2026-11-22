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
        const selected: HarnessValue | undefined = readCondition(inputs.condition)
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

function readCondition(value: HarnessValue | undefined): boolean{
    if (value?.type === "json" && typeof value.value === "boolean"){
        return value.value;
    }
    if (value?.type === "text"){
        const normalized = value.text.trim().toLowerCase();
        if (normalized === "true") return true;
        if (normalized === "false") return false;
    }

    throw new HarnessError(
        HarnessErrorCode.InvalidValue,
        "ChoiceNode condition must be a boolean json value (or \"true\"/\"false\" text)",
    );
}
