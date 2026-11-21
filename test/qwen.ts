import assert from "node:assert/strict";

import { MemoryFileHost } from "../src/file/memory";
import { QwenChatProvider, QwenImageProvider, QwenProtocolAdapter } from "../src/platform/qwen";
import { AttachmentFileManager } from "../src/session/attachment-manager";
import { SessionErrorType } from "../src/session/error";
import { validateMediaInputLimit } from "../src/session/media";
import { UserMessage } from "../src/session/message";
import { isChatProvider, isGenerationProvider } from "../src/session/protocol";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { ChatStopReason } from "../src/session/type";
import type { ChatOptions, SessionRuntimeOptions } from "../src/session/type";

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeWav(): Uint8Array {
    const buffer = new Uint8Array(44);
    const view = new DataView(buffer.buffer);
    const write = (offset: number, text: string): void => {
        for (let index = 0; index < text.length; index += 1) {
            buffer[offset + index] = text.charCodeAt(index);
        }
    };
    write(0, "RIFF");
    view.setUint32(4, 36, true);
    write(8, "WAVE");
    write(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, "data");
    return buffer;
}

const wavBytes = makeWav();
const mp4Bytes = new Uint8Array([
    0x00, 0x00, 0x00, 0x20,
    0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d,
]);

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function sseResponse(lines: readonly string[]): Response {
    return new Response(`${lines.join("\n")}\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
    });
}

/* ---------------------------------------------------------------------------
 * 1. 适配器：图片输入编码
 * ------------------------------------------------------------------------- */
{
    const adapter = new QwenProtocolAdapter();
    const payload = adapter.toPayload(new UserMessage([
        { type: "text", text: "look" },
        { type: "attachment", attachment: { contentHash: "hash" } },
    ]), new Map([
        ["hash", { kind: "inline", data: pngBytes, mimeType: "image/png" }],
    ]));

    assert.deepEqual(payload.content, [
        { type: "text", text: "look" },
        {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${Buffer.from(pngBytes).toString("base64")}` },
        },
    ]);

    const mediaPayload = adapter.toPayload(new UserMessage([
        { type: "text", text: "listen" },
        { type: "attachment", attachment: { contentHash: "audio" } },
        { type: "attachment", attachment: { contentHash: "video" } },
    ]), new Map([
        ["audio", { kind: "inline", data: wavBytes, mimeType: "audio/wav" }],
        ["video", { kind: "inline", data: mp4Bytes, mimeType: "video/mp4" }],
    ]));

    assert.deepEqual(mediaPayload.content, [
        { type: "text", text: "listen" },
        {
            type: "input_audio",
            input_audio: {
                data: `data:audio/wav;base64,${Buffer.from(wavBytes).toString("base64")}`,
                format: "wav",
            },
        },
        {
            type: "video_url",
            video_url: {
                url: `data:video/mp4;base64,${Buffer.from(mp4Bytes).toString("base64")}`,
            },
        },
    ]);

    console.log("PASS Qwen adapter image/audio/video input");
}

/* ---------------------------------------------------------------------------
 * 2. 模型目录：生图模型必须是 generation-only
 * ------------------------------------------------------------------------- */
let modelsPayload: unknown = {
    data: [
        { id: "qwen-plus" },
        { id: "qwen3-vl-plus" },
        { id: "qwen-image-2.0" },
    ],
};

{
    const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/models")) return jsonResponse(modelsPayload);
        throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const provider = new QwenChatProvider({ apiKey: "test-key", fetch: fetchImpl });

    // Qwen /models 不返回模态；由宿主探测后覆盖
    provider.overwrite("qwen3-vl-plus", {
        capabilities: {
            chat: {
                input: ["text", "image"],
                output: ["text"],
                streaming: true,
                tools: true,
            },
        },
    });

    const models = await provider.modelProvider.initModels();

    const vision = models.find((model) => model.id === "qwen3-vl-plus");
    assert.deepEqual(vision?.capabilities?.chat?.input, ["text", "image"]);
    assert.equal(vision?.supportCompletion, true);

    const image = models.find((model) => model.id === "qwen-image-2.0");
    assert.ok(image !== undefined);
    assert.equal(image.supportCompletion, false, "image model must not be treated as chat");
    assert.equal(image.capabilities?.chat, undefined);
    assert.equal(image.capabilities?.generate?.image, true);

    const imageProvider = new QwenImageProvider({ apiKey: "test-key" });
    assert.equal(isChatProvider(imageProvider), false);
    assert.equal(isGenerationProvider(imageProvider), true);
    assert.equal(imageProvider.modelInfo.capabilities?.generate?.image, true);
    assert.equal(imageProvider.modelInfo.supportCompletion, false);

    console.log("PASS Qwen model catalog capability split");
}

/* ---------------------------------------------------------------------------
 * 3. 对话：普通模型流式对话；生图模型被 chat 入口拒绝
 * ------------------------------------------------------------------------- */
{
    let chatUrl = "";
    let chatBody: Record<string, unknown> | undefined;
    let chatCalls = 0;

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);

        if (url.endsWith("/models")) return jsonResponse(modelsPayload);

        if (url.endsWith("/chat/completions")) {
            chatCalls += 1;
            chatUrl = url;
            chatBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
            return sseResponse([
                'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}',
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
                "data: [DONE]",
            ]);
        }

        throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const provider = new QwenChatProvider({ apiKey: "test-key", fetch: fetchImpl });
    await provider.modelProvider.initModels();

    const options: SessionRuntimeOptions = { model: "qwen-plus" };
    const tokens: string[] = [];
    const turn: ChatOptions = {
        signal: new AbortController().signal,
        onToken: (token, isThinking) => {
            tokens.push(`${isThinking ? "thinking" : "text"}:${String(token)}`);
        },
    };

    const result = await provider.chat([new UserMessage("hi")], options, turn);
    assert.equal(chatUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    assert.equal(chatBody?.model, "qwen-plus");
    assert.equal(chatBody?.stream, true);
    assert.deepEqual(chatBody?.stream_options, { include_usage: true });
    assert.equal(result.message.content, "hello");
    assert.equal(result.message.stopReason, ChatStopReason.Stop);
    assert.equal(result.message.usage.totalTokens, 2);
    assert.deepEqual(tokens, ["text:hello"]);

    const callsBeforeImage = chatCalls;
    await assert.rejects(
        () => provider.chat([new UserMessage("你好？")], { model: "qwen-image-2.0" }),
        /image generation model and cannot be used for chat/,
    );
    assert.equal(chatCalls, callsBeforeImage, "image model must not reach chat endpoint");

    console.log("PASS Qwen chat stream + image model rejection");
}

/* ---------------------------------------------------------------------------
 * 4. 独立生图 GenerationCapability
 * ------------------------------------------------------------------------- */
{
    let imageUrl = "";
    let imageBody: Record<string, unknown> | undefined;

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        imageUrl = String(input);
        imageBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return jsonResponse({
            request_id: "req-1",
            output: {
                choices: [{
                    message: {
                        role: "assistant",
                        content: [{ image: "https://example.test/generated.png" }],
                    },
                }],
            },
            usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        });
    }) as typeof fetch;

    const provider = new QwenImageProvider({ apiKey: "test-key", fetch: fetchImpl });
    const task = await provider.generate({
        modality: "image",
        prompt: "draw a cat",
    });
    const media = await task.wait();

    assert.equal(
        imageUrl,
        "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    assert.equal(imageBody?.model, "qwen-image-2.0");
    assert.deepEqual(imageBody?.input, {
        messages: [{ role: "user", content: [{ text: "draw a cat" }] }],
    });
    assert.equal(task.status, "succeeded");
    assert.equal(media.length, 1);
    assert.equal(media[0]?.kind, "url");
    assert.equal(
        media[0]?.kind === "url" ? media[0].url : "",
        "https://example.test/generated.png",
    );

    await assert.rejects(
        () => provider.generate({ modality: "image", prompt: "edit", references: [{ contentHash: "x" }] }),
        /reference\/editing is not implemented/,
    );

    console.log("PASS Qwen standalone image GenerationCapability");
}

/* ---------------------------------------------------------------------------
 * Qwen 生图超时必须覆盖响应正文，而不只是响应头
 * ------------------------------------------------------------------------- */
{
    const fetchImpl = (async (
        _input: string | URL | Request,
        init?: RequestInit,
    ): Promise<Response> => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                init?.signal?.addEventListener("abort", () => {
                    try {
                        controller.error(new DOMException("Aborted", "AbortError"));
                    } catch {
                        // 流已关闭时忽略
                    }
                }, { once: true });
            },
        });

        return new Response(stream, {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }) as typeof fetch;

    const provider = new QwenImageProvider({
        apiKey: "test-key",
        timeoutMs: 30,
        fetch: fetchImpl,
    });

    await assert.rejects(
        () => provider.generate({ modality: "image", prompt: "draw a cat" }),
        /timed out after 30ms/,
    );
    console.log("PASS Qwen image timeout covers the response body");
}

/* ---------------------------------------------------------------------------
 * Qwen 默认媒体输入限制：模型目录未加载也保留 10MB 内联编码上限
 * ------------------------------------------------------------------------- */
{
    const fetchImpl = (async () => jsonResponse({ data: [] })) as typeof fetch;
    const provider = new QwenChatProvider({ apiKey: "test-key", fetch: fetchImpl });
    const limits = provider.defaultModelLimits;

    assert.equal(limits?.input?.audio?.maxEncodedBytes, 10 * 1024 * 1024);
    assert.equal(limits?.input?.video?.maxEncodedBytes, 10 * 1024 * 1024);

    const tooLarge = validateMediaInputLimit(
        { mimeType: "audio/wav", size: 7_900_000 },
        limits?.input?.audio,
    );
    assert.ok(tooLarge.some((problem) => problem.includes("encoded media is too large")));

    const withinLimit = validateMediaInputLimit(
        { mimeType: "audio/wav", size: 7_800_000 },
        limits?.input?.audio,
    );
    assert.equal(withinLimit.length, 0);
    console.log("PASS Qwen 默认 10MB 内联编码上限");
}

/* ---------------------------------------------------------------------------
 * Qwen 10MB 上限在 Session 中前置生效（模型目录未初始化）
 * ------------------------------------------------------------------------- */
{
    const fetchImpl = (async () => jsonResponse({ data: [] })) as typeof fetch;
    const provider = new QwenChatProvider({ apiKey: "test-key", fetch: fetchImpl });
    const manager = new AttachmentFileManager(new MemoryFileHost());

    // 7.9MB 原始字节经 base64 编码后约为 10.53MB，超过 Qwen 的 10MB 上限
    const audioBytes = new Uint8Array(7_900_000);
    const file = await manager.put("large.wav", audioBytes, "audio/wav");
    const session = new Session(
        provider,
        new SessionHistory(),
        { model: "qwen3.5-omni-flash" },
        manager,
    );

    const run = await session.run([
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ], { enableUserInput: false });

    assert.equal(run.status, RunStatus.Failed);
    assert.equal((run.error as { type?: string }).type, SessionErrorType.InputLimitExceeded);
    assert.match(String(run.error), /encoded media is too large/);
    console.log("PASS Qwen 10MB 上限在 Session 前置生效");
}

console.log("\nAll Qwen checks passed.");
