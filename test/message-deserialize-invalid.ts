import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DeserializationError } from "../base";
import { MessageSerializer } from "../session/index";

/**
 * 无效数据反序列化 QA：MessageSerializer.deserialize 必须对每一条损坏数据
 * 抛出 DeserializationError，且错误信息指向出错的字段。
 *
 * 覆盖范围：
 * 1. 顶层结构错误（非对象、缺失/非法基础字段）；
 * 2. content 及 content part 的各类损坏；
 * 3. 助手消息的 usage / toolCalls / stopReason / failureReason 损坏；
 * 4. 工具消息的 toolName / callId / details 损坏；
 * 5. test/messages.invalid.json 文件驱动用例。
 *
 * 运行：
 *   npx tsx test/message-deserialize-invalid.ts
 */
const baseUser = (): Record<string, unknown> => ({
    role: "user",
    content: "hi",
    isCompressed: false,
});

const baseAssistant = (): Record<string, unknown> => ({
    role: "assistant",
    content: "hi",
    isCompressed: false,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    toolCalls: [],
});

const baseTool = (): Record<string, unknown> => ({
    role: "tool",
    content: "output",
    isCompressed: false,
    toolName: "read",
    callId: "call-1",
    details: { isSuccess: true, duration: 1 },
});

type InvalidCase = {
    name: string;
    data: unknown;
    pattern: RegExp;
};

const cases: InvalidCase[] = [
    // ---- 顶层结构 ----
    { name: "data is null", data: null, pattern: /data should be an object/ },
    { name: "data is a number", data: 42, pattern: /data should be an object/ },
    { name: "data is an array", data: [], pattern: /data should be an object/ },
    {
        name: "role is missing",
        data: { content: "hi", isCompressed: false },
        pattern: /role should be a string/,
    },
    {
        name: "role is unknown",
        data: { ...baseUser(), role: "bot" },
        pattern: /unknown role "bot"/,
    },
    {
        name: "isCompressed is not a boolean",
        data: { ...baseUser(), isCompressed: "no" },
        pattern: /isCompressed should be a boolean/,
    },

    // ---- content 及其 content part ----
    {
        name: "content is not a string or array",
        data: { ...baseUser(), content: 42 },
        pattern: /content should be a string or an array/,
    },
    {
        name: "system content is not a string",
        data: { ...baseUser(), role: "system", content: [{ type: "text", text: "hi" }] },
        pattern: /content should be a string/,
    },
    {
        name: "content part is not an object",
        data: { ...baseUser(), content: [null] },
        pattern: /content\[0\] should be an object/,
    },
    {
        name: "content part type is missing",
        data: { ...baseUser(), content: [{ text: "hi" }] },
        pattern: /content\[0\]\.type should be a string/,
    },
    {
        name: "content part type is unsupported",
        data: { ...baseUser(), content: [{ type: "image", url: "x" }] },
        pattern: /content\[0\]\.type "image" is not supported/,
    },
    {
        name: "text part text is not a string",
        data: { ...baseUser(), content: [{ type: "text", text: 123 }] },
        pattern: /content\[0\]\.text should be a string/,
    },
    {
        name: "text part carries attachment",
        data: { ...baseUser(), content: [{ type: "text", text: "hi", attachment: { id: "a" } }] },
        pattern: /content\[0\]\.attachment is not allowed for a text part/,
    },
    {
        name: "attachment part misses id",
        data: { ...baseUser(), content: [{ type: "attachment", attachment: {} }] },
        pattern: /content\[0\]\.attachment\.id should be a string/,
    },
    {
        name: "attachment part carries text",
        data: { ...baseUser(), content: [{ type: "attachment", attachment: { id: "a" }, text: "hi" }] },
        pattern: /content\[0\]\.text is not allowed for an attachment part/,
    },

    // ---- 助手消息：usage / toolCalls / stopReason / failureReason ----
    {
        name: "usage is not an object",
        data: { ...baseAssistant(), usage: "heavy" },
        pattern: /usage should be an object/,
    },
    {
        name: "usage promptTokens is negative",
        data: {
            ...baseAssistant(),
            usage: { promptTokens: -1, completionTokens: 0, totalTokens: 0 },
        },
        pattern: /usage\.promptTokens should be a non-negative number/,
    },
    {
        name: "toolCalls is not an array",
        data: { ...baseAssistant(), toolCalls: {} },
        pattern: /toolCalls should be an array/,
    },
    {
        name: "toolCall item is not an object",
        data: { ...baseAssistant(), toolCalls: [null] },
        pattern: /toolCalls\[0\] should be an object/,
    },
    {
        name: "toolCall name is missing",
        data: { ...baseAssistant(), toolCalls: [{ id: "c1", params: {} }] },
        pattern: /toolCalls\[0\]\.name should be a string/,
    },
    {
        name: "toolCall params is not an object",
        data: { ...baseAssistant(), toolCalls: [{ id: "c1", name: "n", params: "x" }] },
        pattern: /toolCalls\[0\]\.params should be an object/,
    },
    {
        name: "stopReason is invalid",
        data: { ...baseAssistant(), stopReason: "error" },
        pattern: /stopReason is invalid/,
    },
    {
        name: "failureReason is invalid",
        data: { ...baseAssistant(), failureReason: "boom" },
        pattern: /failureReason is invalid/,
    },

    // ---- 工具消息：toolName / callId / details ----
    {
        name: "toolName is missing",
        data: { ...baseTool(), toolName: undefined },
        pattern: /toolName should be a string/,
    },
    {
        name: "callId is missing",
        data: { ...baseTool(), callId: undefined },
        pattern: /callId should be a string/,
    },
    {
        name: "details is not an object",
        data: { ...baseTool(), details: null },
        pattern: /details should be an object/,
    },
    {
        name: "details.isSuccess is not a boolean",
        data: { ...baseTool(), details: { isSuccess: "yes", duration: 1 } },
        pattern: /details\.isSuccess should be a boolean/,
    },
    {
        name: "details.duration is negative",
        data: { ...baseTool(), details: { isSuccess: true, duration: -1 } },
        pattern: /details\.duration should be a non-negative number/,
    },
    {
        name: "details.failureInfo is not a string",
        data: { ...baseTool(), details: { isSuccess: false, duration: 1, failureInfo: 42 } },
        pattern: /details\.failureInfo should be a string/,
    },
];

// ---- 文件驱动用例：test/messages.invalid.json ----
const fixturePath = new URL("./messages.invalid.json", import.meta.url);
const fixtureRaw = await readFile(fixturePath, "utf8");
const fixtureData: unknown = JSON.parse(fixtureRaw);
assert.ok(
    Array.isArray(fixtureData) && fixtureData.length > 0,
    "messages.invalid.json should contain at least one record",
);
cases.push({
    name: "fixture: text part text is not a string (messages.invalid.json)",
    data: fixtureData[0],
    pattern: /content\[0\]\.text should be a string/,
});

// ---- 执行全部用例 ----
let passed = 0;
for (const item of cases){
    let caught: unknown;
    try{
        MessageSerializer.deserialize(item.data);
    }catch (error){
        caught = error;
    }

    assert.ok(
        caught instanceof DeserializationError,
        `${item.name}: expected DeserializationError`,
    );
    assert.match(caught.message, item.pattern, `${item.name}: error message mismatch`);

    passed += 1;
    console.log(`PASS ${item.name}`);
}

console.log(`All ${passed} invalid cases rejected as expected.`);
