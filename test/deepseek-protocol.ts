import assert from "node:assert/strict";

import { AttachmentFile } from "../src/session/attachment";
import { AttachmentFileManager } from "../src/session/attachment-manager";
import { MemoryFileHost } from "../src/file/memory";
import {
    DeepSeekCloudFileManager,
    DeepSeekProvider,
    DeepSeekModelProvider,
    DeepSeekProtocolAdapter,
} from "../src/platform";
import { assistant, ToolMessage, UserMessage } from "../src/session/message";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { ChatStopReason } from "../src/session/type";
import type {
    AttachmentWireMap,
    ChatOptions,
    SessionRuntimeOptions,
} from "../src/session/type";

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const imageRefs: AttachmentWireMap = new Map([
    ["hash-inline", { kind: "inline", data: pngBytes, mimeType: "image/png" }],
    ["hash-remote", { kind: "remote-id", fileId: "file-api-test", mimeType: "image/png" }],
]);

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function sseResponse(lines: readonly string[]): Response {
    return new Response(`${lines.join("\n")}\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
    });
}

/* ---------------------------------------------------------------------------
 * 1. ProtocolAdapter：文�?/ 图片 / file_id / tool calls / 流式片段
 * ------------------------------------------------------------------------- */
{
    const adapter = new DeepSeekProtocolAdapter();

    assert.deepEqual(
        adapter.toPayload(new UserMessage("hello")),
        { role: "user", content: "hello" },
    );

    const imagePayload = adapter.toPayload(new UserMessage([
        { type: "text", text: "look" },
        { type: "attachment", attachment: { contentHash: "hash-inline" } },
    ]), imageRefs);
    assert.equal(imagePayload.role, "user");
    assert.deepEqual(imagePayload.content, [
        { type: "text", text: "look" },
        {
            type: "image_url",
            image_url: {
                url: `data:image/png;base64,${Buffer.from(pngBytes).toString("base64")}`,
            },
        },
    ]);

    const remotePayload = adapter.toPayload(new UserMessage([
        { type: "attachment", attachment: { contentHash: "hash-remote" } },
    ]), imageRefs);
    assert.deepEqual(remotePayload.content, [
        { type: "file", file_id: "file-api-test" },
    ]);

    const assistantMessage = assistant(
        "checking",
        "think",
        { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        [{ id: "call-1", name: "read", params: { path: "a.txt" } }],
        ChatStopReason.ToolCall,
    );
    const assistantPayload = adapter.toPayload(assistantMessage);
    assert.equal(assistantPayload.role, "assistant");
    assert.equal(assistantPayload.content, "checking");
    assert.equal(assistantPayload.reasoning_content, "think");
    assert.equal(
        (assistantPayload.tool_calls as Array<{ function: { arguments: string } }>)[0]
            ?.function.arguments,
        JSON.stringify({ path: "a.txt" }),
    );

    const toolPayload = adapter.toPayload(
        new ToolMessage("result", "read", "call-1", { isSuccess: true, duration: 5 }),
    );
    assert.deepEqual(toolPayload, {
        role: "tool",
        content: "result",
        tool_call_id: "call-1",
    });

    const restored = adapter.toAssistantMessage({
        choices: [{
            message: {
                content: "done",
                reasoning_content: "thought",
                tool_calls: [{
                    id: "call-2",
                    function: { name: "write", arguments: "{\"path\":\"b.txt\"}" },
                }],
            },
            finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    });
    assert.equal(restored.content, "done");
    assert.equal(restored.thinking, "thought");
    assert.equal(restored.toolCalls[0]?.params.path, "b.txt");
    assert.equal(restored.stopReason, ChatStopReason.ToolCall);
    assert.equal(restored.usage.totalTokens, 7);

    const streamChunks = adapter.parseStreamChunk({
        choices: [{
            delta: {
                content: "he",
                reasoning_content: "th",
                tool_calls: [{
                    index: 0,
                    id: "call-3",
                    function: { name: "read", arguments: "{\"path\"" },
                }],
            },
            finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
    assert.ok(streamChunks.some((chunk) => chunk.type === "text_delta"));
    assert.ok(streamChunks.some((chunk) => chunk.type === "thinking_delta"));
    assert.ok(streamChunks.some((chunk) => chunk.type === "tool_call_delta"));
    assert.ok(streamChunks.some((chunk) => chunk.type === "usage"));
    assert.ok(streamChunks.some((chunk) => chunk.type === "done"));

    console.log("PASS DeepSeek ProtocolAdapter 文本/图片/file_id/tool/stream");
}

/* ---------------------------------------------------------------------------
 * 2. ModelProvider：模型能力解�? * ------------------------------------------------------------------------- */
{
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
        calls += 1;
        return jsonResponse({
            object: "list",
            data: [
                {
                    id: "deepseek-flash",
                    object: "model",
                    owned_by: "deepseek",
                    name: "DeepSeek-V4.1-Flash",
                    context_window: 1048576,
                    max_output_tokens: 393216,
                    input_modalities: ["text", "image"],
                    effort: { supported_levels: ["low", "high", "max"], default_level: "high" },
                },
                {
                    id: "deepseek-v4-pro",
                    object: "model",
                    owned_by: "deepseek",
                    name: "DeepSeek-V4-Pro",
                    input_modalities: ["text"],
                    effort: { supported_levels: ["low", "high", "max"] },
                },
            ],
        });
    };

    const models = new DeepSeekModelProvider({ apiKey: "test-key", fetch: fetchImpl });
    const list = await models.initModels();

    assert.equal(calls, 2, "validateNetwork + fetchModels");
    assert.equal(list.length, 2);
    assert.equal(list[0]?.id, "deepseek-flash");
    assert.equal(list[0]?.isVisionModel, true);
    assert.equal(list[0]?.supportToolCall, true);
    assert.deepEqual(list[0]?.thinkingLevels, ["low", "high", "max"]);
    assert.equal(list[1]?.isVisionModel, false);
    console.log("PASS DeepSeek ModelProvider 能力解析");
}

/* ---------------------------------------------------------------------------
 * 3. CloudFileManager：上传、缓存校验�?04 重传、TTL
 * ------------------------------------------------------------------------- */
{
    let uploads = 0;
    let verifies = 0;
    let verifyStatus = 200;
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const headers = init?.headers as Record<string, string> | undefined;
        assert.equal(headers?.Authorization, "Bearer test-key");

        if (url.endsWith("/files") && init?.method === "POST") {
            uploads += 1;
            const form = init.body;
            assert.ok(form instanceof FormData);
            assert.equal(form.get("purpose"), "user_data");
            assert.equal(form.get("expires_after[anchor]"), "created_at");
            assert.equal(form.get("expires_after[seconds]"), "10800");

            const file = form.get("file");
            assert.ok(file instanceof Blob);
            assert.equal(file.size, pngBytes.length);

            return jsonResponse({
                id: `file-api-${uploads}`,
                object: "file",
                bytes: pngBytes.length,
                created_at: expiresAt - 10800,
                filename: "pixel.png",
                purpose: "user_data",
                expires_at: expiresAt,
            });
        }

        if (url.includes("/files/")) {
            verifies += 1;
            return new Response("", { status: verifyStatus });
        }

        throw new Error(`unexpected request: ${url}`);
    };

    const file = await AttachmentFile.create("pixel.png", pngBytes, "image/png");
    const manager = new DeepSeekCloudFileManager({
        apiKey: "test-key",
        fetch: fetchImpl,
        expiresAfterSeconds: 10800,
    });

    const first = await manager.ensureFile(file);
    assert.equal(first.kind, "remote-id");
    assert.equal(first.kind === "remote-id" ? first.fileId : "", "file-api-1");
    assert.equal(first.kind === "remote-id" ? first.expiresAt : undefined, expiresAt * 1000);
    assert.equal(uploads, 1);

    const second = await manager.ensureFile(file);
    assert.equal(second.kind, "remote-id");
    assert.equal(uploads, 1, "cache hit should not upload again");
    assert.equal(verifies, 1);

    verifyStatus = 404;
    const third = await manager.ensureFile(file);
    assert.equal(third.kind, "remote-id");
    assert.equal(uploads, 2, "404 should trigger re-upload");
    assert.equal(verifies, 2);

    const textFile = await AttachmentFile.create(
        "note.txt",
        new TextEncoder().encode("not image"),
        "text/plain",
    );
    await assert.rejects(() => manager.ensureFile(textFile), /only supports JPEG\/PNG\/GIF\/WebP/);

    assert.throws(
        () => new DeepSeekCloudFileManager({ apiKey: "test-key", fetch: fetchImpl, expiresAfterSeconds: 1 }),
        /expiresAfterSeconds/,
    );
    console.log("PASS DeepSeek CloudFileManager 上传/缓存/404 重传/TTL");
}

/* ---------------------------------------------------------------------------
 * 4. LLMProvider：请求体、thinking、SSE 累积
 * ------------------------------------------------------------------------- */
{
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sseResponse([
            'data: {"id":"x","choices":[{"index":0,"delta":{"reasoning_content":"think"},"finish_reason":null}],"usage":null}',
            'data: {"id":"x","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}],"usage":null}',
            'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
            "data: [DONE]",
        ]);
    };

    const provider = new DeepSeekProvider({ apiKey: "test-key", fetch: fetchImpl });
    const options: SessionRuntimeOptions = {
        model: "deepseek-flash",
        think: false,
        temperature: 0.2,
    };
    const tokens: string[] = [];
    const turn: ChatOptions = {
        signal: new AbortController().signal,
        attachmentRefs: imageRefs,
        onToken: (token, isThinking) => {
            tokens.push(`${isThinking ? "thinking" : "text"}:${String(token)}`);
        },
    };

    const result = await provider.chat([
        new UserMessage([
            { type: "text", text: "look" },
            { type: "attachment", attachment: { contentHash: "hash-remote" } },
        ]),
    ], options, turn);

    assert.equal(result.message.content, "hello");
    assert.equal(result.message.thinking, "think");
    assert.equal(result.message.stopReason, ChatStopReason.Stop);
    assert.equal(result.message.usage.totalTokens, 5);
    assert.deepEqual(tokens, ["thinking:think", "text:hello"]);

    assert.equal(requestBody?.model, "deepseek-flash");
    assert.equal(requestBody?.stream, true);
    assert.deepEqual(requestBody?.stream_options, { include_usage: true });
    assert.equal(requestBody?.temperature, 0.2);
    assert.deepEqual(requestBody?.thinking, { type: "disabled" });

    const messages = requestBody?.messages as Array<{ content: unknown }>;
    assert.deepEqual(messages[0]?.content, [
        { type: "text", text: "look" },
        { type: "file", file_id: "file-api-test" },
    ]);
    console.log("PASS DeepSeek AIProvider 请求�?+ SSE 累积");
}

/* ---------------------------------------------------------------------------
 * 5. Session 集成：AttachmentFileManager -> CloudFileManager -> ProtocolAdapter
 * ------------------------------------------------------------------------- */
{
    let uploadedFileId = "";
    let chatBody: Record<string, unknown> | undefined;

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);

        if (url.endsWith("/files") && init?.method === "POST") {
            uploadedFileId = "file-api-session";
            return jsonResponse({
                id: uploadedFileId,
                object: "file",
                bytes: pngBytes.length,
                created_at: Math.floor(Date.now() / 1000),
                filename: "pixel.png",
                purpose: "user_data",
            });
        }

        if (url.includes("/files/")) {
            return new Response("", { status: 200 });
        }

        if (url.endsWith("/chat/completions")) {
            chatBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return sseResponse([
                'data: {"choices":[{"index":0,"delta":{"content":"seen"},"finish_reason":null}],"usage":null}',
                'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}',
                "data: [DONE]",
            ]);
        }

        throw new Error(`unexpected request: ${url}`);
    };

    const provider = new DeepSeekProvider({ apiKey: "test-key", fetch: fetchImpl });
    const attachmentManager = new AttachmentFileManager(new MemoryFileHost());
    const file = await attachmentManager.put("pixel.png", pngBytes, "image/png");
    const session = new Session(
        provider,
        new SessionHistory("deepseek-session"),
        { model: "deepseek-flash", think: false },
        attachmentManager,
    );

    const run = await session.run([
        { type: "text", text: "describe" },
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ], { enableUserInput: false });

    assert.equal(run.status, RunStatus.Completed);
    assert.equal(uploadedFileId, "file-api-session");
    assert.equal(session.attachmentRefs.get(file.contentHash)?.kind, "remote-id");

    const messages = chatBody?.messages as Array<{ content: unknown }>;
    assert.deepEqual(messages[0]?.content, [
        { type: "text", text: "describe" },
        { type: "file", file_id: "file-api-session" },
        { type: "text", text: `[media:${file.contentHash}]` },
    ]);

    assert.deepEqual(session.history?.messages[0]?.content, [
        { type: "text", text: "describe" },
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ]);
console.log("PASS DeepSeek Session integration (history keeps contentHash)");
}

console.log("\nAll DeepSeek protocol checks passed.");

