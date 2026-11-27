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
 * MergeNode（旧）：保留给已保存的图与旧 run 快照。
 *
 * 新图请使用 FilterNode（`core.filter`）；两者行为一致：有 a 取 a，否则 b。
 * 两个输入都可选；调度器在“所有上游都 skipped”时直接跳过本节点。
 */
export class MergeNode extends GraphNode{

    override readonly type = HarnessBuiltinNodeType.Merge;

    override get inputs(): readonly InputPortSpec[]{
        return [
            { name: "a", type: "any" },
            { name: "b", type: "any" },
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
        const selected: HarnessValue | undefined = inputs.a ?? inputs.b;
        if (selected === undefined){
            throw new HarnessError(
                HarnessErrorCode.MissingValue,
                `${this.type} has no branch value to merge`,
                { nodeId: this.id },
            );
        }
        return { value: selected };
    }
}
