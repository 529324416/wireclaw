import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
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
import type { Message } from "../session/index";
import type { MessageDataAssistant } from "../session/index";

/**
 * 构造一组覆盖全部消息角色与助手字段组合的虚拟消息，序列化到 test/messages.json。
 * 该脚本同时是 fixtures 生成器：message-deserialize.ts 依赖这里产出的 messages.json。
 *
 * 运行：
 *   npx tsx test/message-serialize.ts
 */
const messages: Message[] = [
    // 系统消息：纯文本
    new SystemMessage("You are a helpful assistant."),

    // 用户消息：文本 + 附件引用
    new UserMessage(
        [
            { type: "text", text: "Please review this file." },
            { type: "attachment", attachment: { id: "sha256:user-file-001" } },
        ],
        false,
    ),

    // 助手消息：带 thinking 与工具调用，停止原因为 tool_call
    new AssistantMessage(
        "I will inspect the attachment.",
        false,
        "I need to read the attached file first.",
        { promptTokens: 120, completionTokens: 45, totalTokens: 165 },
        [
            {
                id: "call-001",
                name: "read_attachment",
                params: {
                    attachmentId: "sha256:user-file-001",
                    maxBytes: 4096,
                },
            },
        ],
        ChatStopReason.ToolCall,
    ),

    // 工具消息：成功结果 + 输出附件
    new ToolMessage(
        [
            { type: "text", text: "Attachment read successfully." },
            { type: "attachment", attachment: { id: "sha256:tool-output-001" } },
        ],
        "read_attachment",
        "call-001",
        { isSuccess: true, duration: 42 },
        false,
    ),

    // 助手消息：自然结束
    new AssistantMessage(
        "The file contains three sections.",
        false,
        undefined,
        { promptTokens: 200, completionTokens: 80, totalTokens: 280 },
        undefined,
        ChatStopReason.Stop,
    ),

    // 助手消息：生成失败（仅 failureReason，无 stopReason）
    new AssistantMessage(
        "Partial response before failure.",
        true,
        undefined,
        { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        undefined,
        undefined,
        ChatFailureReason.InternalError,
    ),
];

// ---- QA：写出前先校验序列化结果 ----
const serialized = messages.map((message) => MessageSerializer.serialize(message));

assert.equal(serialized.length, 6, "fixture should contain 6 messages");
assert.doesNotThrow(() => JSON.stringify(serialized), "serialized data should be JSON-safe");

for (const data of serialized){
    assert.ok(
        typeof data.content === "string" || Array.isArray(data.content),
        `${data.role}: content should be a string or an array`,
    );
    assert.equal(typeof data.isCompressed, "boolean", `${data.role}: isCompressed should be a boolean`);
}

const assistantMessages = serialized.filter(
    (data): data is MessageDataAssistant => data.role === "assistant",
);
assert.equal(assistantMessages.length, 3, "fixture should contain 3 assistant messages");

for (const data of assistantMessages){
    assert.ok(data.usage, `${data.role}: assistant message should carry usage`);
    if (data.stopReason !== undefined){
        assert.ok(
            (Object.values(ChatStopReason) as string[]).includes(data.stopReason),
            `${data.role}: stopReason should be a valid ChatStopReason`,
        );
    }
    if (data.failureReason !== undefined){
        assert.ok(
            (Object.values(ChatFailureReason) as string[]).includes(data.failureReason),
            `${data.role}: failureReason should be a valid ChatFailureReason`,
        );
    }
}

const failed = assistantMessages.find((data) => data.failureReason !== undefined);
assert.ok(failed, "fixture should contain a failed assistant message");
assert.equal(failed.stopReason, undefined, "failed message should not carry stopReason");
assert.equal(failed.isCompressed, true, "failed message should preserve isCompressed");

const outputPath = new URL("./messages.json", import.meta.url);
await writeFile(outputPath, JSON.stringify(serialized, null, 2) + "\n", "utf8");

const summary = serialized.map((data) => `${data.role}:${data.isCompressed}`).join(", ");
console.log(`Serialized ${serialized.length} messages to ${fileURLToPath(outputPath)}`);
console.log(`Roles: ${summary}`);
