import assert from "node:assert/strict";

import { isOtherLikeOption, parseQuestionChoice } from "../tools/ask-user-choice";
import type { UserQuestionOption } from "../src/session/type";

const options: UserQuestionOption[] = [
    { id: "talk", label: "1 说话（微张嘴+胸前手势）" },
    { id: "think", label: "2 思考v2（托下巴+歪头+红唇）" },
    { id: "happy", label: "3 开心（露齿笑容）" },
    { id: "angry", label: "4 愤怒v2（咬牙+握拳+低头）" },
];

const optionsWithOther: UserQuestionOption[] = [
    { id: "yes", label: "通过，出高清" },
    { id: "no", label: "还不行，备注说明问题" },
];

/* ---------------------------------------------------------------------------
 * 1. 普通选项与多选
 * ------------------------------------------------------------------------- */
{
    const single = parseQuestionChoice("4", options, true, false, undefined);
    assert.deepEqual(single, { selected: ["angry"], requiresNote: false });

    const multi = parseQuestionChoice("1,2", options, true, true, undefined);
    assert.deepEqual(multi, { selected: ["talk", "think"], requiresNote: false });

    assert.equal(parseQuestionChoice("1,2", options, true, false, undefined), undefined);
    assert.equal(parseQuestionChoice("9", options, true, false, undefined), undefined);
    console.log("PASS ask_user normal/multi selection");
}

/* ---------------------------------------------------------------------------
 * 2. allowOther：直接文字、选项后附文字
 * ------------------------------------------------------------------------- */
{
    const direct = parseQuestionChoice("保持愤怒但嘴角收一点", options, true, false, undefined);
    assert.deepEqual(direct, {
        selected: [],
        other: "保持愤怒但嘴角收一点",
        requiresNote: false,
    });

    const inline = parseQuestionChoice("4, 嘴角再收一点", options, true, false, undefined);
    assert.deepEqual(inline, {
        selected: ["angry"],
        other: "嘴角再收一点",
        requiresNote: false,
    });

    const multiNote = parseQuestionChoice("1,2, 手部再修一下", options, true, true, undefined);
    assert.deepEqual(multiNote, {
        selected: ["talk", "think"],
        other: "手部再修一下",
        requiresNote: false,
    });

    const chineseComma = parseQuestionChoice("4，嘴角再收一点", options, true, false, undefined);
    assert.deepEqual(chineseComma, {
        selected: ["angry"],
        other: "嘴角再收一点",
        requiresNote: false,
    });

    assert.equal(
        parseQuestionChoice("4, 备注", options, false, false, undefined),
        undefined,
        "allowOther=false must reject inline notes",
    );
    console.log("PASS ask_user allowOther free text and inline note");
}

/* ---------------------------------------------------------------------------
 * 3. “其他/备注说明”选项必须要求补充文字
 * ------------------------------------------------------------------------- */
{
    assert.equal(isOtherLikeOption(optionsWithOther[1]!), true);
    assert.equal(isOtherLikeOption(options[0]!), false);

    const selectedOther = parseQuestionChoice("2", optionsWithOther, true, false, undefined);
    assert.deepEqual(selectedOther, {
        selected: ["no"],
        requiresNote: true,
    });

    const inlineOther = parseQuestionChoice("2, 嘴部线条太硬", optionsWithOther, true, false, undefined);
    assert.deepEqual(inlineOther, {
        selected: ["no"],
        other: "嘴部线条太硬",
        requiresNote: true,
    });
    console.log("PASS ask_user other-like option requires a note");
}

/* ---------------------------------------------------------------------------
 * 4. 客户端追加的“其他（自由输入）”槽位
 * ------------------------------------------------------------------------- */
{
    const pseudo = parseQuestionChoice("4", options.slice(0, 3), true, false, 4);
    assert.deepEqual(pseudo, { selected: [], requiresNote: true });

    const pseudoInline = parseQuestionChoice("4, 自由描述", options.slice(0, 3), true, false, 4);
    assert.deepEqual(pseudoInline, {
        selected: [],
        other: "自由描述",
        requiresNote: true,
    });
    console.log("PASS ask_user pseudo other slot");
}

console.log("\nAll ask_user choice checks passed.");
