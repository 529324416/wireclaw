import assert from "node:assert/strict";

import { McpClient } from "../src/tool/mcp/client";
import { McpHttpTransport } from "../src/tool/mcp/http";
import type { JsonRpcMessage } from "../src/tool/mcp/type";

function section(title: string): void {
    console.log(`\n=== ${title} ===`);
}

type RecordedCall = {
    method: string;
    headers: Record<string, string>;
};

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error("waitFor timeout");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const calls: RecordedCall[] = [];
let getCalls = 0;
let toolsChanged = 0;

const fakeFetch: typeof fetch = async (_input, init) => {
    const method = init?.method ?? "GET";
    calls.push({
        method,
        headers: (init?.headers ?? {}) as Record<string, string>,
    });

    if (method === "POST") {
        const message = JSON.parse(String(init?.body)) as JsonRpcMessage;

        if (!("method" in message) || !("id" in message)) {
            return new Response("", { status: 202 });
        }

        if (message.method === "initialize") {
            return new Response(JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                    protocolVersion: "2025-06-18",
                    capabilities: { tools: { listChanged: true } },
                    serverInfo: { name: "http-fake", version: "1.0.0" },
                },
            }), {
                status: 200,
                headers: {
                    "content-type": "application/json",
                    "mcp-session-id": "session-123",
                },
            });
        }

        return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {},
        }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }

    if (method === "DELETE") {
        return new Response("", { status: 204 });
    }

    if (method === "GET") {
        getCalls += 1;

        if (getCalls === 1) {
            const body = [
                "id: evt-1",
                'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}',
                "",
                "",
            ].join("\n");

            return new Response(body, {
                status: 200,
                headers: { "content-type": "text/event-stream" },
            });
        }

        // 第二次 GET 之后不再支持通知流，避免测试无限重连
        return new Response("", { status: 405 });
    }

    return new Response("", { status: 404 });
};

section("Last-Event-ID 断线恢复");

const transport = new McpHttpTransport({
    url: "http://fake.local/mcp",
    fetch: fakeFetch,
    eventStreamRetryMs: 10,
});

const client = new McpClient(transport);
client.onToolsChanged(() => {
    toolsChanged += 1;
});

try {
    await client.connect();
    await waitFor(() => getCalls >= 2 && toolsChanged >= 1);

    const getHeaders = calls.filter((call) => call.method === "GET");
    assert.equal(getHeaders.length >= 2, true);
    assert.equal(getHeaders[1].headers["last-event-id"], "evt-1");
    assert.equal(getHeaders[0].headers["last-event-id"], undefined);
    assert.equal(getHeaders[0].headers["mcp-session-id"], "session-123");
    assert.equal(getHeaders[1].headers["mcp-session-id"], "session-123");
    assert.equal(toolsChanged >= 1, true);

    console.log(`PASS 通知流收到事件并在重连时携带 Last-Event-ID（GET 次数 ${getCalls}）`);
} finally {
    await client.close();
}

console.log("\nAll MCP HTTP resume checks passed.");
