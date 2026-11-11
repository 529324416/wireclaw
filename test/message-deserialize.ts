import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
    AssistantMessage,
    ChatFailureReason,
    ChatStopReason,
    MessageSerializer,
    SystemMessage,
    ToolMessage,
    UserMessage,
} from "../session/index";

/**
 * 从 test/messages.json（由 message-serialize.ts 生成）反序列化，并验证：
 * 1. 每条记录恢复为正确的消息子类，字段值一一对应；
 * 2. 重新序列化后与原始 JSON 完全一致（round-trip）。
 *
 * 运行：
 *   npx tsx test/message-deserialize.ts
 */
const inputPath = new URL("./messages.json", import.meta.url);
const raw = await readFile(inputPath, "utf8");
const data: unknown = JSON.parse(raw);

assert.ok(Array.isArray(data), "messages.json should contain an array");
assert.equal(data.length, 6, "fixture should contain 6 messages");

const messages = data.map((item) => MessageSerializer.deserialize(item));
const [system, user, assistantToolCall, tool, assistantStop, assistantFailed] = messages;

// ---- 1. 子类与基础字段 ----
assert.ok(system instanceof SystemMessage, "message 0 should be SystemMessage");
assert.ok(user instanceof UserMessage, "message 1 should be UserMessage");
assert.ok(assistantToolCall instanceof AssistantMessage, "message 2 should be AssistantMessage");
assert.ok(tool instanceof ToolMessage, "message 3 should be ToolMessage");
assert.ok(assistantStop instanceof AssistantMessage, "message 4 should be AssistantMessage");
assert.ok(assistantFailed instanceof AssistantMessage, "message 5 should be AssistantMessage");

assert.equal(system.content, "You are a helpful assistant.");
assert.equal(system.isCompressed, false);

assert.deepStrictEqual(user.content, [
    { type: "text", text: "Please review this file." },
    { type: "attachment", attachment: { id: "sha256:user-file-001" } },
]);
assert.equal(user.isCompressed, false);

// ---- 2. 助手消息的回合字段 ----
const withToolCall = assistantToolCall as AssistantMessage;
assert.equal(withToolCall.thinking, "I need to read the attached file first.");
assert.equal(withToolCall.stopReason, ChatStopReason.ToolCall);
assert.equal(withToolCall.failureReason, undefined);
assert.deepStrictEqual(withToolCall.usage, { promptTokens: 120, completionTokens: 45, totalTokens: 165 });
assert.equal(withToolCall.hasToolCall, true);
assert.deepStrictEqual(withToolCall.toolCalls, [
    {
        id: "call-001",
        name: "read_attachment",
        params: { attachmentId: "sha256:user-file-001", maxBytes: 4096 },
    },
]);

const stopped = assistantStop as AssistantMessage;
assert.equal(stopped.stopReason, ChatStopReason.Stop);
assert.equal(stopped.thinking, undefined);
assert.equal(stopped.isCompressed, false);

// ---- 3. 工具消息 ----
const toolMessage = tool as ToolMessage;
assert.equal(toolMessage.toolName, "read_attachment");
assert.equal(toolMessage.callId, "call-001");
assert.deepStrictEqual(toolMessage.details, { isSuccess: true, duration: 42, failureInfo: undefined });
assert.equal(toolMessage.isCompressed, false);

// ---- 4. 失败消息：failureReason 存在、stopReason 为空 ----
const failed = assistantFailed as AssistantMessage;
assert.equal(failed.failureReason, ChatFailureReason.InternalError);
assert.equal(failed.stopReason, undefined);
assert.equal(failed.isCompressed, true);

// ---- 5. round-trip：反序列化 -> 序列化 与原始数据一致 ----
const roundTrip = messages.map((message) => {
    return JSON.parse(JSON.stringify(MessageSerializer.serialize(message)));
});
assert.deepStrictEqual(roundTrip, data, "deserialize -> serialize should preserve the data");

console.log(`Deserialized ${messages.length} messages from ${fileURLToPath(inputPath)}`);
console.log("Field checks and round-trip check passed.");
