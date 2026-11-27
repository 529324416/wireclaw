import { HarnessError, HarnessErrorCode } from "../base/error";
import { HarnessBuiltinNodeType } from "../definition";
import { GraphNode } from "../graph/node";
import type { NodeContext } from "../graph/node";
import type {
    InputPortSpec,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "../graph/type";
import { readConfig, readOptionalString, requireText } from "./helpers";

const COMBINE = HarnessBuiltinNodeType.Combine;

/**
 * CombineNode：把两个文本输入按顺序合并成一个文本。
 *
 * - 输入 a / b 都可选；只连接一路时直接输出该文本；
 * - config.separator 作为两段文本之间的分隔符（默认空串）；
 * - 两路都未连接时执行期报错。
 */
export class CombineNode extends GraphNode{

    override readonly type = COMBINE;

    override get inputs(): readonly InputPortSpec[]{
        return [
            { name: "a", type: "text" },
            { name: "b", type: "text" },
        ];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{
            name: "text",
            type: "text",
            supportedModes: ["value"],
            defaultMode: "value",
        }];
    }

    override async execute(
        _ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const a = inputs.a === undefined
            ? undefined
            : requireText(inputs.a, "a");
        const b = inputs.b === undefined
            ? undefined
            : requireText(inputs.b, "b");

        if (a === undefined && b === undefined){
            throw new HarnessError(
                HarnessErrorCode.MissingValue,
                `${COMBINE} requires at least one text input`,
                { nodeId: this.id },
            );
        }

        const config = readConfig(this.config, COMBINE);
        const separator = readOptionalString(config, "separator", COMBINE) ?? "";
        const text = a !== undefined && b !== undefined
            ? `${a}${separator}${b}`
            : (a ?? b ?? "");

        return { text: { type: "text", text } };
    }
}
