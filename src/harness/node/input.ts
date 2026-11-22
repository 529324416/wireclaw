import { HarnessBuiltinNodeType } from "../definition";
import { GraphNode } from "../graph/node";
import type { NodeContext } from "../graph/node";
import type {
    InputPortSpec,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "../graph/type";

/** Graph 的输入源；Step 2 读取 run input 的 text / attachments */
export class InputNode extends GraphNode{

    override readonly type = HarnessBuiltinNodeType.Input;

    override get inputs(): readonly InputPortSpec[]{
        return [];
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
        ];
    }

    override async execute(
        ctx: NodeContext,
        _inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        return {
            text: { type: "text", text: ctx.input.text ?? "" },
            attachments: {
                type: "attachments",
                attachments: ctx.input.attachments ?? [],
            },
        };
    }
}
