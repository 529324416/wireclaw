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
 * FilterNode：两路可选分支的过滤 / 汇合点。
 *
 * 行为与旧 MergeNode 一致（有 a 取 a，否则 b），但名称表达的是「从分支里
 * 过滤出一路值」，而不是把两个值合并——文本合并由 CombineNode 负责。
 *
 * 两个输入都可选；调度器在“所有上游都 skipped”时直接跳过本节点。
 */
export class FilterNode extends GraphNode{

    override readonly type = HarnessBuiltinNodeType.Filter;

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
                `${this.type} has no branch value to filter`,
                { nodeId: this.id },
            );
        }
        return { value: selected };
    }
}
