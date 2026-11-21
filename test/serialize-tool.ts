import assert from "node:assert/strict";

import { DeserializationError } from "../src/base";
import { ToolError, ToolErrorType } from "../src/session/error";
import { AssistantMessage, ToolMessage, UserMessage } from "../src/session/message";
import { MessageSerializer, SessionSerializer } from "../src/session/serialize";
import { SessionHistory } from "../src/session/session";
import { ChatStopReason } from "../src/session/type";
import type { MessageDataTool } from "../src/session/type";

function section(title: string): void {
    console.log(`\n=== ${title} ===`);
}

/* ---------------------------------------------------------------------------
 * 1. 工具错误：ToolError 实例 -> plain data
 * ------------------------------------------------------------------------- */
section("工具错误序列化");

const circular: Record<string, unknown> = {};
circular.self = circular;

const error = new ToolError(ToolErrorType.NetworkError, true, "socket reset", circular);
const toolMessage = new ToolMessage(
    "socket reset",
    "local__writeFile",
    "call-1",
    { isSuccess: false, error, duration: 42 },
);

const data = MessageSerializer.serialize(toolMessage) as MessageDataTool;

assert.deepEqual(data.details, {
    isSuccess: false,
    duration: 42,
    error: {
        type: ToolErrorType.NetworkError,
        retryable: true,
        message: "socket reset",
    },
});
assert.equal("retryable" in data.details, false, "status 上不应再重复 retryable");
assert.equal("failureInfo" in data.details, false, "failureInfo 已移除");

const json = JSON.stringify(data);
assert.equal(json.includes("socket reset"), true);
assert.equal(json.includes("circular"), false, "origin 不应被持久化");
assert.equal(json.includes("self"), false);

const restored = MessageSerializer.deserialize(JSON.parse(json) as unknown) as ToolMessage;
assert.ok(restored instanceof ToolMessage);
assert.equal(restored.toolName, "local__writeFile");
assert.equal(restored.callId, "call-1");
assert.equal(restored.isSuccess, false);
assert.equal(restored.duration, 42);
assert.ok(restored.error instanceof ToolError);
assert.equal(restored.error?.type, ToolErrorType.NetworkError);
assert.equal(restored.error?.retryable, true);
assert.equal(restored.error?.message, "socket reset");

assert.deepEqual(
    JSON.parse(JSON.stringify(MessageSerializer.serialize(restored))),
    JSON.parse(json),
    "反序列化后再序列化应保持一致",
);
console.log("PASS ToolError 存为 plain data、origin 不落盘、round-trip 稳定");

/* ---------------------------------------------------------------------------
 * 2. 成功结果不产生 error 字段
 * ------------------------------------------------------------------------- */
section("成功结果");

const okMessage = new ToolMessage("ok", "local__readFile", "call-2", {
    isSuccess: true,
    duration: 3,
});
const okData = MessageSerializer.serialize(okMessage) as MessageDataTool;
assert.deepEqual(okData.details, { isSuccess: true, duration: 3 });
assert.equal("error" in okData.details, false);
console.log("PASS 成功结果不产生 error 字段");

/* ---------------------------------------------------------------------------
 * 2.1 工具 structuredContent 持久化
 * ------------------------------------------------------------------------- */
{
    const structured = { contentHash: "abc", items: [{ id: 1, ok: true }] };
    const message = new ToolMessage(
        "ok",
        "local__readFile",
        "call-structured",
        { isSuccess: true, duration: 1 },
        false,
        structured,
    );
    const serialized = MessageSerializer.serialize(message) as MessageDataTool;
    assert.deepEqual(serialized.structuredContent, structured);

    const restoredMessage = MessageSerializer.deserialize(
        JSON.parse(JSON.stringify(serialized)) as unknown,
    ) as ToolMessage;
    assert.deepEqual(restoredMessage.structuredContent, structured);
    console.log("PASS 工具 structuredContent round-trip");
}

/* ---------------------------------------------------------------------------
 * 2.2 工具信任标记持久化
 * ------------------------------------------------------------------------- */
{
    const message = new ToolMessage(
        "external page",
        "mcp__fetch",
        "call-trust",
        { isSuccess: true, duration: 1 },
        false,
        undefined,
        "untrusted",
        "external MCP content",
    );
    const serialized = MessageSerializer.serialize(message) as MessageDataTool;
    assert.equal(serialized.trust, "untrusted");
    assert.equal(serialized.trustReason, "external MCP content");

    const restoredMessage = MessageSerializer.deserialize(
        JSON.parse(JSON.stringify(serialized)) as unknown,
    ) as ToolMessage;
    assert.equal(restoredMessage.trust, "untrusted");
    assert.equal(restoredMessage.trustReason, "external MCP content");

    assert.throws(
        () => MessageSerializer.deserialize({
            role: "tool",
            isCompressed: false,
            content: "x",
            toolName: "t",
            callId: "c",
            details: { isSuccess: true, duration: 1 },
            trust: "bogus",
        }),
        (error: unknown) => error instanceof DeserializationError
            && /trust is invalid/.test(error.message),
    );
    console.log("PASS 工具信任标记 round-trip");
}

/* ---------------------------------------------------------------------------
 * 3. 整个会话 round-trip
 * ------------------------------------------------------------------------- */
section("会话 round-trip");

const history = new SessionHistory("session-1", [
    new UserMessage("write a file"),
    new AssistantMessage(
        "",
        false,
        undefined,
        { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        [{ id: "call-1", name: "local__writeFile", params: { path: "a.txt" } }],
        ChatStopReason.ToolCall,
    ),
    toolMessage,
    new AssistantMessage(
        "done",
        false,
        undefined,
        { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        undefined,
        ChatStopReason.Stop,
    ),
], false);

const sessionData = SessionSerializer.serialize(history);
const sessionJson = JSON.stringify(sessionData);
const restoredHistory = SessionSerializer.deserialize(JSON.parse(sessionJson) as unknown);

assert.equal(restoredHistory.id, "session-1");
assert.equal(restoredHistory.messages.length, 4);
assert.equal(restoredHistory.isArchived, false);

const restoredToolMessage = restoredHistory.messages[2] as ToolMessage;
assert.ok(restoredToolMessage.error instanceof ToolError);
assert.equal(restoredToolMessage.error?.type, ToolErrorType.NetworkError);

const assistant = restoredHistory.messages[1] as AssistantMessage;
assert.equal(assistant.hasToolCall, true);
assert.deepEqual(assistant.toolCalls[0]?.params, { path: "a.txt" });

assert.deepEqual(
    JSON.parse(JSON.stringify(SessionSerializer.serialize(restoredHistory))),
    JSON.parse(sessionJson),
    "SessionSerializer 反序列化后再序列化应保持一致",
);
console.log("PASS SessionSerializer 完整 round-trip");

/* ---------------------------------------------------------------------------
 * 4. 非法 error 字段
 * ------------------------------------------------------------------------- */
section("非法数据");

function isDeserializeErrorWith(pattern: RegExp): (error: unknown) => boolean {
    return (error: unknown): boolean => {
        return error instanceof DeserializationError && pattern.test(error.message);
    };
}

assert.throws(
    () => MessageSerializer.deserialize({
        role: "tool",
        content: "x",
        isCompressed: false,
        toolName: "t",
        callId: "c",
        details: {
            isSuccess: false,
            duration: 1,
            error: { type: "nope", retryable: true, message: "m" },
        },
    }),
    isDeserializeErrorWith(/details\.error\.type is invalid/),
);

assert.throws(
    () => MessageSerializer.deserialize({
        role: "tool",
        content: "x",
        isCompressed: false,
        toolName: "t",
        callId: "c",
        details: {
            isSuccess: false,
            duration: 1,
            error: { type: ToolErrorType.Denied, retryable: "yes", message: "m" },
        },
    }),
    isDeserializeErrorWith(/details\.error\.retryable should be a boolean/),
);

assert.throws(
    () => MessageSerializer.deserialize({
        role: "tool",
        content: "x",
        isCompressed: false,
        toolName: "t",
        callId: "c",
        details: {
            isSuccess: false,
            duration: 1,
            error: { type: ToolErrorType.Denied, retryable: true },
        },
    }),
    isDeserializeErrorWith(/details\.error\.message should be a string/),
);
console.log("PASS 非法 error 字段被拒绝");

console.log("\nAll serializer checks passed.");
