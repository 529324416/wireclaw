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
import { readConfig, readOptionalString, textInputValue } from "./helpers";

const REPLACE = HarnessBuiltinNodeType.Replace;

/**
 * ReplaceNode：按 keyword 把 raw_text 中的文本替换为 replacement。
 *
 * - raw_text / keyword / replacement 都可以由端口传入；未连接时回退本地 config；
 * - config.count 为最大替换次数：-1 表示全部（默认），0 表示不替换，正数表示上限；
 * - keyword 为空时不做替换，原样返回 raw_text；
 * - 只做字面量替换，不解析正则或 `$&` 之类的替换语法。
 */
export class ReplaceNode extends GraphNode{

    override readonly type = REPLACE;

    override get inputs(): readonly InputPortSpec[]{
        return [
            { name: "raw_text", type: "text" },
            { name: "keyword", type: "text" },
            { name: "replacement", type: "text" },
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
        const config = readConfig(this.config, REPLACE);
        const rawText = inputs.raw_text === undefined
            ? readOptionalString(config, "rawText", REPLACE)
            : textInputValue(inputs.raw_text, "raw_text");
        if (rawText === undefined){
            throw new HarnessError(
                HarnessErrorCode.MissingValue,
                `${REPLACE} requires raw_text`,
                { nodeId: this.id },
            );
        }

        const keyword = inputs.keyword === undefined
            ? readOptionalString(config, "keyword", REPLACE)
            : textInputValue(inputs.keyword, "keyword");
        if (keyword === undefined){
            throw new HarnessError(
                HarnessErrorCode.MissingValue,
                `${REPLACE} requires keyword`,
                { nodeId: this.id },
            );
        }

        const replacement = inputs.replacement === undefined
            ? readOptionalString(config, "replacement", REPLACE) ?? ""
            : textInputValue(inputs.replacement, "replacement");

        const count = readCount(config);
        return {
            text: {
                type: "text",
                text: replaceText(rawText, keyword, replacement, count),
            },
        };
    }
}

function readCount(config: Record<string, unknown>): number{
    const value = config.count;
    if (value === undefined) return -1;
    if (typeof value !== "number" || !Number.isInteger(value) || value < -1){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${REPLACE}.count must be an integer >= -1`,
        );
    }
    return value;
}

function replaceText(
    text: string,
    keyword: string,
    replacement: string,
    count: number,
): string{
    if (keyword.length === 0 || count === 0) return text;
    if (count < 0) return text.split(keyword).join(replacement);

    let result = "";
    let cursor = 0;
    let remaining = count;
    while (remaining > 0){
        const index = text.indexOf(keyword, cursor);
        if (index < 0) break;
        result += text.slice(cursor, index) + replacement;
        cursor = index + keyword.length;
        remaining -= 1;
    }
    return result + text.slice(cursor);
}
