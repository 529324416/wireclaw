import assert from "node:assert/strict";
import { toBase64 } from "../src/base";
import { AttachmentFile } from "../src/session/attachment";
import {
    OllamaCloudFileManager,
    OllamaProvider,
    OllamaModelProvider,
    OllamaProtocolAdapter,
} from "../src/platform/index";
import { AssistantMessage, SystemMessage, ToolMessage, UserMessage } from "../src/session/message";
import { ChatStopReason } from "../src/session/type";
import type { AttachmentWireMap, SessionRuntimeOptions } from "../src/session/type";

/**
 * Ollama 协议模块 QA�? *
 * 前置条件�? *   本机 Ollama 正在 http://127.0.0.1:11434 运行�? *
 * 可选环境变量：
 *   OLLAMA_BASE_URL  默认 http://127.0.0.1:11434
 *   OLLAMA_MODEL     指定测试模型；不填时自动选择第一个支�?completion 的非 embedding 模型
 *
 * 运行�? *   npx tsx test/ollama-protocol.ts
 */
const BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";

function printSection(title: string): void{
    console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// 1. ProtocolAdapter：纯转换测试，不依赖网络
// ---------------------------------------------------------------------------
printSection("OllamaProtocolAdapter");

const adapter = new OllamaProtocolAdapter();

assert.deepStrictEqual(
    adapter.toPayload(new SystemMessage("You are helpful.")),
    { role: "system", content: "You are helpful." },
    "system message payload mismatch",
);

assert.deepStrictEqual(
    adapter.toPayload(new UserMessage("hello")),
    { role: "user", content: "hello" },
    "user message payload mismatch",
);

const assistantWithTool = new AssistantMessage(
    "checking",
    false,
    "need a tool",
    { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    [{ id: "call-1", name: "read", params: { path: "a.txt" } }],
    ChatStopReason.ToolCall,
);
const assistantPayload = adapter.toPayload(assistantWithTool);
assert.equal(assistantPayload.role, "assistant");
assert.equal(assistantPayload.content, "checking");
assert.equal(assistantPayload.thinking, "need a tool");
assert.ok(Array.isArray(assistantPayload.tool_calls));
assert.equal(assistantPayload.tool_calls?.length, 1);

const toolPayload = adapter.toPayload(
    new ToolMessage("result", "read", "call-1", { isSuccess: true, duration: 5 }),
);
assert.equal(toolPayload.role, "tool");
assert.equal(toolPayload.content, "result");
assert.equal(toolPayload.tool_name, "read");
assert.equal(toolPayload.tool_call_id, "call-1");

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const imageRefs: AttachmentWireMap = new Map([
    ["sha256:test", { kind: "inline", data: pngBytes, mimeType: "image/png" }],
]);

const imagePayload = adapter.toPayload(new UserMessage([
    { type: "text", text: "look" },
    { type: "attachment", attachment: { contentHash: "sha256:test" } },
]), imageRefs);
assert.equal(imagePayload.role, "user");
assert.equal(imagePayload.content, "look");
assert.deepEqual(imagePayload.images, [toBase64(pngBytes)]);

assert.throws(
    () => adapter.toPayload(new UserMessage([
        { type: "attachment", attachment: { contentHash: "sha256:test" } },
    ])),
    /Missing attachment wire map/,
    "Ollama adapter should require the resolved attachment map",
);

assert.throws(
    () => adapter.toPayload(new UserMessage([
        { type: "attachment", attachment: { contentHash: "sha256:test" } },
    ]), new Map([
        ["sha256:test", { kind: "remote-id", fileId: "file-1", mimeType: "image/png" }],
    ])),
    /only supports inline attachments/,
    "Ollama should reject remote file IDs",
);

assert.throws(
    () => adapter.toPayload(new UserMessage([
        { type: "attachment", attachment: { contentHash: "sha256:test" } },
    ]), new Map([
        ["sha256:test", { kind: "inline", data: new TextEncoder().encode("not an image"), mimeType: "image/png" }],
    ])),
    /only supports image attachments/,
    "Ollama should reject non-image bytes",
);

const cloudFiles = new OllamaCloudFileManager();
const imageFile = await AttachmentFile.create("pixel.png", pngBytes, "image/png");
const inlineRef = await cloudFiles.ensureFile(imageFile);
assert.equal(inlineRef.kind, "inline");
assert.equal(inlineRef.mimeType, "image/png");

const textFile = await AttachmentFile.create(
    "note.txt",
    new TextEncoder().encode("hello"),
    "text/plain",
);
await assert.rejects(() => cloudFiles.ensureFile(textFile), /only supports image attachments/);

const fullResponse = adapter.toAssistantMessage({
    message: {
        role: "assistant",
        content: "hello",
        thinking: "thinking...",
    },
    prompt_eval_count: 7,
    eval_count: 3,
    done_reason: "stop",
});
assert.equal(fullResponse.content, "hello");
assert.equal(fullResponse.thinking, "thinking...");
assert.equal(fullResponse.stopReason, ChatStopReason.Stop);
assert.deepStrictEqual(fullResponse.usage, {
    promptTokens: 7,
    completionTokens: 3,
    totalTokens: 10,
});

const streamChunks = adapter.parseStreamChunk({
    message: {
        role: "assistant",
        content: "he",
        thinking: "th",
    },
    prompt_eval_count: 2,
    eval_count: 1,
    done: false,
});
assert.deepStrictEqual(streamChunks, [
    { type: "text_delta", text: "he" },
    { type: "thinking_delta", text: "th" },
    { type: "usage", usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } },
]);

const doneChunks = adapter.parseStreamChunk({
    done: true,
    done_reason: "stop",
    prompt_eval_count: 2,
    eval_count: 1,
});
assert.ok(doneChunks.some(chunk => chunk.type === "usage"));
assert.ok(doneChunks.some(chunk => chunk.type === "done" && chunk.stopReason === ChatStopReason.Stop));

const errorChunks = adapter.parseStreamChunk({ error: "boom" });
assert.deepStrictEqual(errorChunks, [
    { type: "error", failureReason: "unknown", message: "boom" },
]);

console.log("PASS ProtocolAdapter conversion/stream parsing");

// ---------------------------------------------------------------------------
// 2. ModelProvider：网�?+ /api/tags + /api/show
// ---------------------------------------------------------------------------
printSection("OllamaModelProvider");

const modelProvider = new OllamaModelProvider(BASE_URL);
await modelProvider.validateNetwork();
console.log(`PASS validateNetwork: ${BASE_URL}`);

const models = await modelProvider.initModels();
assert.ok(models.length > 0, "Ollama should expose at least one model");
assert.equal(modelProvider.modelCount, models.length);
assert.ok(modelProvider.isModelsInitialized, "model provider should be initialized");
assert.ok(modelProvider.availableModelBriefs !== null, "model briefs should be available");
assert.equal(modelProvider.availableModelBriefs?.length, models.length);

const completionModels = models.filter(model => model.supportCompletion && !model.isEmbeddingModel);
assert.ok(completionModels.length > 0, "at least one completion model is required for the LLM test");

const configuredModel = process.env.OLLAMA_MODEL;
const model = configuredModel && configuredModel.length > 0
    ? configuredModel
    : completionModels[0].name;

assert.ok(model.length > 0, "test model should not be empty");
console.log(`PASS initModels: ${models.length} models, selected "${model}"`);
console.log(`  briefs: ${modelProvider.availableModelBriefs?.length ?? 0}`);
console.log(`  fetchCount=${modelProvider.fetchCount}, failedCount=${modelProvider.failedCount}`);

// ---------------------------------------------------------------------------
// 3. LLMProvider：真�?/api/chat 流式请求
// ---------------------------------------------------------------------------
printSection("OllamaProvider");

const provider = new OllamaProvider(BASE_URL);
assert.equal(provider.title, "Ollama");
assert.ok(provider.modelProvider instanceof OllamaModelProvider);
assert.ok(provider.protocolAdapter instanceof OllamaProtocolAdapter);

const runtimeOptions: SessionRuntimeOptions = {
    model,
    temperature: 0.1,
    think: false,
};

let tokenCount = 0;
let thinkingTokenCount = 0;
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 180_000);

try{
    const result = await provider.chat(
        [
            new SystemMessage("You are a concise assistant."),
            new UserMessage("Reply with exactly: ok"),
        ],
        runtimeOptions,
        {
            signal: controller.signal,
            onToken: (_token, isThinking) => {
                if (isThinking) thinkingTokenCount += 1;
                else tokenCount += 1;
            },
        },
    );

    assert.equal(result.message.role, "assistant");
    assert.equal(typeof result.message.content, "string");
    assert.ok((result.message.content as string).length > 0, "assistant output should not be empty");
    assert.ok(result.message.usage.totalTokens > 0, "usage should be populated");
    assert.ok(tokenCount > 0, "streaming should emit at least one text token");

    console.log("PASS /api/chat");
    console.log(`  content: ${JSON.stringify(result.message.content)}`);
    console.log(`  stopReason: ${result.message.stopReason ?? "undefined"}`);
    console.log(`  usage: ${JSON.stringify(result.message.usage)}`);
    console.log(`  tokens: text=${tokenCount}, thinking=${thinkingTokenCount}`);
}finally{
    clearTimeout(timeout);
}

console.log("\nAll Ollama protocol checks passed.");
