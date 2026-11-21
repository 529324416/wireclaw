import type { UserQuestionOption } from "../src/session/type";

/** ask_user 一次选择解析结果 */
export type ParsedQuestionChoice = {
    selected: string[];
    other?: string;
    requiresNote: boolean;
};

/** 判断某个选项是否表示“其他 / 备注 / 自由输入” */
export function isOtherLikeOption(option: UserQuestionOption): boolean {
    const text = `${option.id} ${option.label}`.toLowerCase();
    return /其他|其它|备注|说明|自由输入|自定义|补充|other|specify|custom|note/.test(text);
}

/**
 * 解析 ask_user 的一行输入。
 *
 * 支持：
 * - `1` / `1,2`：普通选项；
 * - `4, 内容`：选项 4 + 备注；
 * - `1,2, 内容`：多选 + 备注；
 * - 直接输入文字：allowOther 时作为 other；
 * - `pseudoOtherIndex`：客户端追加的“其他（自由输入）”槽位。
 *
 * 返回 undefined 表示输入非法。
 */
export function parseQuestionChoice(
    raw: string,
    options: readonly UserQuestionOption[],
    allowOther: boolean,
    multiSelect: boolean,
    pseudoOtherIndex: number | undefined,
): ParsedQuestionChoice | undefined {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;

    const parts = trimmed
        .split(/[,，]/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    if (parts.length === 0) return undefined;

    // 不以数字开头：allowOther 时整段作为自由输入
    if (!/^\d+$/.test(parts[0])) {
        return allowOther
            ? { selected: [], other: trimmed, requiresNote: false }
            : undefined;
    }

    const indexes: number[] = [];
    let cursor = 0;
    while (cursor < parts.length && /^\d+$/.test(parts[cursor])) {
        indexes.push(Number(parts[cursor]));
        cursor += 1;
    }

    const rest = parts.slice(cursor).join(",").trim();
    const optionCount = options.length + (pseudoOtherIndex === undefined ? 0 : 1);

    if (indexes.length === 0
        || indexes.some((index) => !Number.isInteger(index) || index < 1 || index > optionCount)
        || new Set(indexes).size !== indexes.length
        || (!multiSelect && indexes.length > 1)
        || (rest.length > 0 && !allowOther)) {
        return undefined;
    }

    const selected: string[] = [];
    let requiresNote = false;

    for (const index of indexes) {
        if (pseudoOtherIndex !== undefined && index === pseudoOtherIndex) {
            requiresNote = true;
            continue;
        }

        const option = options[index - 1];
        if (option === undefined) return undefined;

        selected.push(option.id);
        if (isOtherLikeOption(option)) requiresNote = true;
    }

    return {
        selected,
        ...(rest.length > 0 ? { other: rest } : {}),
        requiresNote,
    };
}
