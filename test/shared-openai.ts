import assert from "node:assert/strict";

import { UserMessage, assistant } from "../src/session/message";
import { ToolMessage } from "../src/session/message";
import { ChatStopReason } from "../src/session/type";
import type { ChatOptions, SessionRuntimeOptions } from "../src/session/type";
import { OpenAIProtocolAdapter } from "../src/platform/shared/openai/adapter";
import { OpenAICompatibleProvider } from "../src/platform/shared/openai/provider";
import { consumeChatStream } from "../src/platform/shared/stream";
import { ModelProvider } from "../src/session/protocol";
import type { ModelInfo } from "../src/session/protocol";

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sseResponse(lines: readonly string[]): Response {
    return new Response(`${lines.join("\n")}\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
    });
}

class TestModelProvider extends ModelProvider {
    async validateNetwork(): Promise<void> {
        // no-op
    }

    protected async fetchModels(): Promise<ModelInfo[]> {
        return [];
    }
}

class TestProvider extends OpenAICompatibleProvider {
    constructor(fetchImpl: typeof fetch, timeoutMs?: number) {
        super({
            label: "Test",
            baseUrl: "https://example.test",
            apiKey: "test-key",
            fetch: fetchImpl,
            timeoutMs,
            modelProvider: new TestModelProvider(),
            protocolAdapter: new OpenAIProtocolAdapter({ label: "Test" }),
        });
    }
}

/* ---------------------------------------------------------------------------
 * 1. 适配器：消息、附件、assistant、tool
 * ------------------------------------------------------------------------- */
{
    const adapter = new OpenAIProtocolAdapter({ label: "Test" });

    assert.deepEqual(adapter.toPayload(new UserMessage("hello")), {
        role: "user",
        content: "hello",
    });

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

    const chunks = adapter.parseStreamChunk({
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
    assert.ok(chunks.some((chunk) => chunk.type === "text_delta"));
    assert.ok(chunks.some((chunk) => chunk.type === "thinking_delta"));
    assert.ok(chunks.some((chunk) => chunk.type === "tool_call_delta"));
    assert.ok(chunks.some((chunk) => chunk.type === "usage"));
    assert.ok(chunks.some((chunk) => chunk.type === "done"));

    console.log("PASS shared OpenAI adapter message/attachment/stream mapping");
}

/* ---------------------------------------------------------------------------
 * 2. Provider：请求体、SSE 聚合、错误映射
 * ------------------------------------------------------------------------- */
{
    let requestBody: Record<string, unknown> | undefined;
    let requestUrl = "";

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sseResponse([
            'data: {"choices":[{"delta":{"reasoning_content":"think"},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read","arguments":"{\\"path\\":\\"a"}}]}}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"}"}}]}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}',
            "data: [DONE]",
        ]);
    }) as typeof fetch;

    const provider = new TestProvider(fetchImpl);
    const tokens: string[] = [];
    const turn: ChatOptions = {
        signal: new AbortController().signal,
        onToken: (token, isThinking) => {
            tokens.push(`${isThinking ? "thinking" : "text"}:${String(token)}`);
        },
    };
    const options: SessionRuntimeOptions = { model: "test-model", temperature: 0.5 };

    const result = await provider.chat([new UserMessage("hello")], options, turn);

    assert.equal(requestUrl, "https://example.test/chat/completions");
    assert.equal(requestBody?.model, "test-model");
    assert.equal(requestBody?.stream, true);
    assert.deepEqual(requestBody?.stream_options, { include_usage: true });
    assert.equal(requestBody?.temperature, 0.5);
    assert.equal(result.message.content, "hello");
    assert.equal(result.message.thinking, "think");
    assert.equal(result.message.stopReason, ChatStopReason.ToolCall);
    assert.equal(result.message.usage.totalTokens, 7);
    assert.equal(result.message.toolCalls.length, 1);
    assert.deepEqual(result.message.toolCalls[0]?.params, { path: "a" });
    assert.deepEqual(tokens, ["thinking:think", "text:hello"]);

    console.log("PASS shared OpenAI provider request/SSE aggregation");
}

/* ---------------------------------------------------------------------------
 * 3. Provider：HTTP 错误与 NDJSON 流
 * ------------------------------------------------------------------------- */
{
    const errorFetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
    const errorProvider = new TestProvider(errorFetch);
    await assert.rejects(
        () => errorProvider.chat([new UserMessage("hello")], { model: "test-model" }),
        /HTTP 401/,
    );

    const ndjson = new Response([
        '{"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
        '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
    ].join("\n"), {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
    });

    const result = await consumeChatStream(ndjson, {
        format: "ndjson",
        label: "NDJSON",
        adapter: new OpenAIProtocolAdapter({ label: "NDJSON" }),
    });
    assert.equal(result.message.content, "hi");
    assert.equal(result.message.stopReason, ChatStopReason.Stop);
    assert.equal(result.message.usage.totalTokens, 2);

    console.log("PASS shared OpenAI provider HTTP error + shared NDJSON stream");
}

/* ---------------------------------------------------------------------------
 * 4. Provider 级工具门禁：模型声明 tools:false 时不下发工具定义
 * ------------------------------------------------------------------------- */
{
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (
        _input: string | URL | Request,
        init?: RequestInit,
    ): Promise<Response> => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sseResponse(["data: [DONE]"]);
    }) as typeof fetch;

    const provider = new TestProvider(fetchImpl);
    provider.overwrite("no-tools", {
        capabilities: {
            chat: {
                input: ["text"],
                output: ["text"],
                streaming: true,
                tools: false,
            },
        },
    });

    await provider.chat(
        [new UserMessage("hello")],
        { model: "no-tools" },
        {
            signal: new AbortController().signal,
            tools: [{
                name: "ping",
                description: "ping",
                inputSchema: { type: "object" },
            }],
        },
    );

    assert.ok(requestBody !== undefined);
    assert.equal(requestBody.tools, undefined);
    console.log("PASS shared OpenAI provider gates tools by model capabilities");
}

/* ---------------------------------------------------------------------------
 * 5. 请求超时/取消必须覆盖响应正文，而不只是响应头
 * ------------------------------------------------------------------------- */
function stalledSseResponse(signal: AbortSignal | null | undefined): Response {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            signal?.addEventListener("abort", () => {
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
        headers: { "content-type": "text/event-stream" },
    });
}

{
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) =>
        stalledSseResponse(init?.signal)) as typeof fetch;
    const provider = new TestProvider(fetchImpl, 40);
    const error = await provider.chat(
        [new UserMessage("hello")],
        { model: "test-model" },
        { signal: new AbortController().signal },
    ).then(() => undefined, (reason: unknown) => reason);

    assert.ok(error instanceof Error);
    assert.match(String(error.message), /chat stream timed out after 40ms/);
    console.log("PASS shared OpenAI timeout covers the response body");
}

{
    const controller = new AbortController();
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) =>
        stalledSseResponse(init?.signal)) as typeof fetch;
    const provider = new TestProvider(fetchImpl);

    setTimeout(() => controller.abort(), 20);
    await assert.rejects(
        () => provider.chat(
            [new UserMessage("hello")],
            { model: "test-model" },
            { signal: controller.signal },
        ),
        /Abort/,
    );
    assert.equal(controller.signal.aborted, true);
    console.log("PASS shared OpenAI abort covers the response body");
}

console.log("\nAll shared OpenAI checks passed.");
