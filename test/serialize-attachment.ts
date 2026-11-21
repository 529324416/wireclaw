import assert from "node:assert/strict";

import { DeserializationError, SerializationError } from "../src/base";
import type { StoredAttachmentMeta } from "../src/session/attachment";
import { AssistantMessage, ToolMessage, UserMessage } from "../src/session/message";
import {
    MessageSerializer,
    SESSION_DATA_VERSION,
    SessionAttachmentManifestSerializer,
    SessionSerializer,
} from "../src/session/serialize";
import { SessionHistory } from "../src/session/session";
import { ChatStopReason } from "../src/session/type";

const userContent = [
    { type: "text" as const, text: "look" },
    { type: "attachment" as const, attachment: { contentHash: "hash-user" } },
];

/* ---------------------------------------------------------------------------
 * 1. 用户消息 owner -> contentHash round-trip
 * ------------------------------------------------------------------------- */
{
    const message = new UserMessage(userContent);
    const data = MessageSerializer.serialize(message);
    assert.deepEqual(data.content, userContent);

    const restored = MessageSerializer.deserialize(JSON.parse(JSON.stringify(data)) as unknown);
    assert.ok(restored instanceof UserMessage);
    assert.deepEqual(restored.content, userContent);
    console.log("PASS 用户附件 contentHash round-trip");
}

/* ---------------------------------------------------------------------------
 * 2. assistant / tool 消息也支持附件引用
 * ------------------------------------------------------------------------- */
{
    const assistantContent = [
        { type: "text" as const, text: "see file" },
        { type: "attachment" as const, attachment: { contentHash: "hash-assistant" } },
    ];
    const assistant = new AssistantMessage(
        assistantContent,
        false,
        "thought",
        { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        [{ id: "call-1", name: "read", params: { path: "a.txt" } }],
        ChatStopReason.ToolCall,
    );

    const restoredAssistant = MessageSerializer.deserialize(
        JSON.parse(JSON.stringify(MessageSerializer.serialize(assistant))) as unknown,
    ) as AssistantMessage;
    assert.deepEqual(restoredAssistant.content, assistantContent);
    assert.equal(restoredAssistant.thinking, "thought");
    assert.deepEqual(restoredAssistant.toolCalls, assistant.toolCalls);

    const toolContent = [
        { type: "text" as const, text: "result" },
        { type: "attachment" as const, attachment: { contentHash: "hash-tool" } },
    ];
    const tool = new ToolMessage(
        toolContent,
        "local__readFile",
        "call-1",
        { isSuccess: true, duration: 3 },
    );
    const restoredTool = MessageSerializer.deserialize(
        JSON.parse(JSON.stringify(MessageSerializer.serialize(tool))) as unknown,
    ) as ToolMessage;
    assert.deepEqual(restoredTool.content, toolContent);
    assert.equal(restoredTool.toolName, "local__readFile");
    assert.equal(restoredTool.callId, "call-1");
    console.log("PASS assistant / tool 附件 contentHash round-trip");
}

/* ---------------------------------------------------------------------------
 * 3. SessionSerializer 整体 round-trip
 * ------------------------------------------------------------------------- */
{
    const history = new SessionHistory("serialize-attachment-session", [
        new UserMessage(userContent),
        new AssistantMessage(
            "done",
            false,
            undefined,
            { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            undefined,
            ChatStopReason.Stop,
        ),
    ], false);

    const data = SessionSerializer.serialize(history);
    const restored = SessionSerializer.deserialize(JSON.parse(JSON.stringify(data)) as unknown);
    assert.equal(restored.id, history.id);
    assert.deepEqual(restored.messages[0]?.content, userContent);
    assert.deepEqual(
        JSON.parse(JSON.stringify(SessionSerializer.serialize(restored))),
        JSON.parse(JSON.stringify(data)),
        "session round-trip should be stable",
    );
    console.log("PASS SessionSerializer 附件 round-trip");
}

/* ---------------------------------------------------------------------------
 * 4. 旧 { id } 字段不再兼容
 * ------------------------------------------------------------------------- */
{
    assert.throws(
        () => MessageSerializer.deserialize({
            role: "user",
            isCompressed: false,
            content: [
                { type: "attachment", attachment: { id: "legacy-hash" } },
            ],
        }),
        (error: unknown): boolean =>
            error instanceof DeserializationError
            && /contentHash should be a string/.test(error.message),
    );
    console.log("PASS 旧 { id } 字段被拒绝");
}

/* ---------------------------------------------------------------------------
 * 5. 非法附件结构
 * ------------------------------------------------------------------------- */
{
    function isDeserializeError(pattern: RegExp): (error: unknown) => boolean {
        return (error: unknown): boolean =>
            error instanceof DeserializationError && pattern.test(error.message);
    }

    assert.throws(
        () => MessageSerializer.deserialize({
            role: "user",
            isCompressed: false,
            content: [{ type: "attachment", attachment: { contentHash: "" } }],
        }),
        isDeserializeError(/contentHash should be a non-empty string/),
    );

    assert.throws(
        () => MessageSerializer.deserialize({
            role: "user",
            isCompressed: false,
            content: [{ type: "attachment", attachment: {} }],
        }),
        isDeserializeError(/contentHash should be a string/),
    );

    assert.throws(
        () => MessageSerializer.deserialize({
            role: "user",
            isCompressed: false,
            content: [{ type: "attachment", attachment: { contentHash: 42 } }],
        }),
        isDeserializeError(/contentHash should be a string/),
    );

    assert.throws(
        () => MessageSerializer.deserialize({
            role: "user",
            isCompressed: false,
            content: [{ type: "text", text: "x", attachment: { contentHash: "h" } }],
        }),
        isDeserializeError(/attachment is not allowed for a text part/),
    );

    assert.throws(
        () => MessageSerializer.deserialize({
            role: "user",
            isCompressed: false,
            content: [{ type: "attachment", text: "x", attachment: { contentHash: "h" } }],
        }),
        isDeserializeError(/text is not allowed for an attachment part/),
    );

    assert.throws(
        () => MessageSerializer.deserialize({
            role: "system",
            isCompressed: false,
            content: [{ type: "text", text: "x" }],
        }),
        isDeserializeError(/content should be a string/),
    );

    assert.throws(
        () => new UserMessage([
            { type: "attachment", attachment: { contentHash: "" } },
        ]),
        (error: unknown): boolean =>
            error instanceof SerializationError
            && /contentHash should be a non-empty string/.test(error.message),
    );

    console.log("PASS 非法附件结构被拒绝");
}

/* ---------------------------------------------------------------------------
 * 附件元数据清单与会话 schema 版本
 * ------------------------------------------------------------------------- */
{
    const metas: StoredAttachmentMeta[] = [{
        contentHash: "a".repeat(64),
        name: "reference.png",
        mimeType: "image/png",
        size: 123,
        sourcePaths: ["C:\\images\\reference.png"],
    }];

    const manifest = SessionAttachmentManifestSerializer.serialize(metas);
    assert.equal(manifest.version, 1);
    assert.deepEqual(SessionAttachmentManifestSerializer.deserialize(manifest), metas);

    assert.throws(
        () => SessionAttachmentManifestSerializer.deserialize({
            version: 2,
            attachments: [],
        }),
        (error: unknown) => error instanceof DeserializationError
            && /unsupported version/.test(error.message),
    );

    const history = new SessionHistory("versioned", []);
    const data = SessionSerializer.serialize(history);
    assert.equal(data.version, SESSION_DATA_VERSION);

    // 旧文件没有 version；按 v1 继续接受
    const legacy = SessionSerializer.deserialize({
        id: "legacy",
        messages: [],
        isArchived: false,
    });
    assert.equal(legacy.id, "legacy");

    assert.throws(
        () => SessionSerializer.deserialize({
            version: 99,
            id: "future",
            messages: [],
            isArchived: false,
        }),
        (error: unknown) => error instanceof DeserializationError
            && /unsupported version/.test(error.message),
    );

    console.log("PASS attachment manifest and session schema version");
}

console.log("\nAll attachment serializer checks passed.");
