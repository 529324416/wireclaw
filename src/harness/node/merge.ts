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
 * MergeNode：显式汇合节点。
 *
 * 设计状态：保留 / 实验。
 * - 普通单值输入已经支持隐式 exclusive join，因此 BranchNode 的两条路径
 *   不再必须手动放一个 MergeNode；
 * - MergeNode 仍适合需要可见汇合点、自定义选择策略，或未来由可视化编辑器
 *   做显式控制的场景；
 * - 它是否仍应作为默认推荐，等进入 GraphEditor 阶段后再用真实交互验证。
 *   预留脚本位见 tools/merge-future-check.mjs。
 *
 * 两个输入都可选；调度器在“所有上游都 skipped”时直接跳过 MergeNode。
 * 若两边都有值，默认取 a。
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
