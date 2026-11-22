import { HarnessBuiltinNodeType } from "../definition";
import { GraphNode } from "../graph/node";
import type { NodeContext } from "../graph/node";
import type {
    InputPortSpec,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "../graph/type";

/** Graph 的最终输出汇点；Runner 读取它返回的值作为 run.outputs */
export class OutputNode extends GraphNode{

    override readonly type = HarnessBuiltinNodeType.Output;

    override get inputs(): readonly InputPortSpec[]{
        return [
            { name: "text", type: "text" },
            { name: "attachments", type: "attachments" },
            { name: "json", type: "json" },
        ];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [];
    }

    override async execute(
        _ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        return inputs;
    }
}
