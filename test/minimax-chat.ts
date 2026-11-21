import assert from "node:assert/strict";

import { UserMessage } from "../src/session/message";
import { MiniMaxChatProvider, MiniMaxProtocolAdapter } from "../src/platform/minimax";
import { isChatProvider, isGenerationProvider } from "../src/session/protocol";
import { ChatStopReason } from "../src/session/type";
import type { ChatOptions, SessionRuntimeOptions } from "../src/session/type";

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function sseResponse(lines: readonly string[]): Response {
    return new Response(lines.join("\n\n") + "\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
    });
}

{
    const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/v1/models")) {
            return jsonResponse({
                data: [
                    { id: "MiniMax-M3.1-Flash" },
                    { id: "MiniMax-M2.7" },
                ],
            });
        }
        throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    const provider = new MiniMaxChatProvider({
        apiKey: "test-key",
        baseUrl: "https://api.minimax.cn",
        fetch: fetchImpl,
    });

    assert.equal(isChatProvider(provider), true);
    assert.equal(isGenerationProvider(provider), false);
    assert.equal(provider.supportsTools, true);

    const models = await provider.modelProvider.initModels();
    assert.equal(models.length, 2);
    assert.equal(models[0]?.id, "MiniMax-M3.1-Flash");
    assert.equal(models[0]?.capabilities?.chat?.streaming, true);
    assert.equal(models[0]?.capabilities?.chat?.tools, true);
    assert.equal(models[0]?.isVisionModel, false);
    console.log("PASS MiniMax Chat model catalog");
}

{
    let capturedBody: Record<string, unknown> | undefined;
    let capturedUrl = "";
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return sseResponse([
            'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}',
            'data: {"choices":[{"delta":{"content":"hello"}}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read","arguments":"{\\"path\\":\\"a"}}]}}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"}"}}]}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}',
            "data: [DONE]",
        ]);
    }) as typeof fetch;

    const provider = new MiniMaxChatProvider({
        apiKey: "test-key",
        baseUrl: "https://api.minimax.cn",
        fetch: fetchImpl,
    });

    const tokens: string[] = [];
    const turn: ChatOptions = {
        signal: new AbortController().signal,
        onToken: (token, isThinking) => {
            tokens.push(`${isThinking ? "thinking" : "text"}:${String(token)}`);
        },
    };
    const options: SessionRuntimeOptions = { model: "MiniMax-M3.1-Flash" };
    const result = await provider.chat([new UserMessage("hello")], options, turn);

    assert.equal(capturedUrl, "https://api.minimax.cn/v1/chat/completions");
    assert.equal(capturedBody?.model, "MiniMax-M3.1-Flash");
    assert.equal(capturedBody?.stream, true);
    assert.deepEqual(capturedBody?.stream_options, { include_usage: true });
    assert.equal(result.message.content, "hello");
    assert.equal(result.message.thinking, "think");
    assert.equal(result.message.stopReason, ChatStopReason.ToolCall);
    assert.equal(result.message.usage.totalTokens, 7);
    assert.equal(result.message.toolCalls.length, 1);
    assert.equal(result.message.toolCalls[0]?.id, "call-1");
    assert.equal(result.message.toolCalls[0]?.name, "read");
    assert.deepEqual(result.message.toolCalls[0]?.params, { path: "a" });
    assert.deepEqual(tokens, ["thinking:think", "text:hello"]);
    console.log("PASS MiniMax Chat SSE text + thinking + tool calls");
}

{
    const adapter = new MiniMaxProtocolAdapter();
    const result = adapter.toAssistantMessage({
        choices: [{
            message: { content: "ok", reasoning_content: "why" },
            finish_reason: "stop",
        }],
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    });
    assert.equal(result.content, "ok");
    assert.equal(result.thinking, "why");
    assert.equal(result.usage.totalTokens, 5);
    console.log("PASS MiniMax non-stream assistant mapping");
}

{
    const fetchImpl = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
    const provider = new MiniMaxChatProvider({
        apiKey: "test-key",
        fetch: fetchImpl,
    });
    await assert.rejects(
        () => provider.chat([new UserMessage("hello")], { model: "MiniMax-M3.1-Flash" }),
        /HTTP 401/,
    );
    console.log("PASS MiniMax Chat HTTP error");
}

console.log("\nAll MiniMax Chat checks passed.");
