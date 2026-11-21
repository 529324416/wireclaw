import assert from "node:assert/strict";

import { OllamaProvider } from "../src/platform/ollama";
import { UserMessage } from "../src/session/message";
import { ChatStopReason } from "../src/session/type";
import type { ChatOptions, SessionRuntimeOptions } from "../src/session/type";

function ndjsonResponse(lines: readonly string[]): Response {
    return new Response(`${lines.join("\n")}\n`, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
    });
}

const originalFetch = globalThis.fetch;

try {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | undefined;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return ndjsonResponse([
            '{"message":{"role":"assistant","content":"hel"},"done":false}',
            '{"message":{"role":"assistant","content":"lo","thinking":"th"},"done":false}',
            '{"message":{"role":"assistant","tool_calls":[{"id":"call-1","function":{"name":"read","arguments":"{\\"path\\":\\"a\\"}"}}]},"done":false}',
            '{"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":3,"eval_count":2}',
        ]);
    }) as typeof fetch;

    const provider = new OllamaProvider("http://ollama.test");
    const tokens: string[] = [];
    const turn: ChatOptions = {
        signal: new AbortController().signal,
        onToken: (token, isThinking) => {
            tokens.push(`${isThinking ? "thinking" : "text"}:${String(token)}`);
        },
    };
    const options: SessionRuntimeOptions = { model: "test-model", think: true };

    const result = await provider.chat([new UserMessage("hello")], options, turn);

    assert.equal(capturedUrl, "http://ollama.test/api/chat");
    assert.equal(capturedBody?.model, "test-model");
    assert.equal(capturedBody?.stream, true);
    assert.equal(capturedBody?.think, true);
    assert.equal(result.message.content, "hello");
    assert.equal(result.message.thinking, "th");
    assert.equal(result.message.stopReason, ChatStopReason.Stop);
    assert.equal(result.message.usage.totalTokens, 5);
    assert.equal(result.message.toolCalls.length, 1);
    assert.equal(result.message.toolCalls[0]?.name, "read");
    assert.deepEqual(result.message.toolCalls[0]?.params, { path: "a" });
    assert.deepEqual(tokens, ["text:hel", "text:lo", "thinking:th"]);

    console.log("PASS Ollama provider NDJSON aggregation");
} finally {
    globalThis.fetch = originalFetch;
}

console.log("\nAll Ollama offline checks passed.");
