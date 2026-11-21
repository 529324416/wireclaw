import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { McpClient } from "../src/tool/mcp/client";
import { McpHttpTransport } from "../src/tool/mcp/http";
import type { JsonRpcMessage, JsonRpcRequest } from "../src/tool/mcp/type";

function section(title: string): void {
    console.log(`\n=== ${title} ===`);
}

type Recorded = {
    headers: IncomingMessage["headers"];
    message: JsonRpcMessage;
};

type TestServer = {
    url: string;
    requests: Recorded[];
    deletes: () => number;
    close: () => Promise<void>;
};

function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
    return "method" in message && "id" in message;
}

function buildReply(message: JsonRpcMessage): unknown {
    if (!isRequest(message)) return undefined;

    switch (message.method) {
        case "initialize":
            return {
                protocolVersion: "2025-06-18",
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: "http-mcp", version: "0.1.0" },
            };

        case "tools/list":
            return {
                tools: [{
                    name: "echo",
                    description: "echo text",
                    inputSchema: { type: "object", properties: { text: { type: "string" } } },
                    annotations: { readOnlyHint: true },
                }],
            };

        case "tools/call": {
            const params = (message.params ?? {}) as { arguments?: { text?: string } };
            return {
                content: [{ type: "text", text: `echo:${params.arguments?.text ?? ""}` }],
            };
        }

        case "ping":
            return {};

        default:
            return undefined;
    }
}

async function startServer(mode: "json" | "sse"): Promise<TestServer> {
    const requests: Recorded[] = [];
    let deletes = 0;

    const server = createServer(async (req, res) => {
        if (req.method === "DELETE") {
            deletes += 1;
            res.statusCode = 204;
            res.end();
            return;
        }

        // 测试服务器不支持后台通知流
        if (req.method === "GET") {
            res.statusCode = 405;
            res.end();
            return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(Buffer.from(chunk as Buffer));
        }

        const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRpcMessage;
        requests.push({ headers: req.headers, message });

        const reply = buildReply(message);
        if (reply === undefined || !isRequest(message)) {
            res.statusCode = 202;
            res.end();
            return;
        }

        const payload = { jsonrpc: "2.0", id: message.id, result: reply };
        res.setHeader("mcp-session-id", "session-123");

        if (mode === "sse") {
            res.setHeader("content-type", "text/event-stream");
            res.end(`data: ${JSON.stringify(payload)}\n\n`);
            return;
        }

        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(payload));
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${address.port}/mcp`,
        requests,
        deletes: () => deletes,
        close: () => new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
        }),
    };
}

/* ---------------------------------------------------------------------------
 * 1. JSON 响应 + session/version 头
 * ------------------------------------------------------------------------- */
section("HTTP JSON");

{
    const server = await startServer("json");
    const client = new McpClient(new McpHttpTransport({ url: server.url }));

    try {
        const init = await client.connect();
        assert.equal(init.serverInfo.name, "http-mcp");
        assert.equal(init.protocolVersion, "2025-06-18");

        const tools = await client.listTools();
        assert.deepEqual(tools.map((tool) => tool.name), ["echo"]);
        assert.equal(tools[0].annotations?.readOnlyHint, true);

        const result = await client.callTool("echo", { text: "hi" });
        assert.equal((result.content[0] as { text?: string }).text, "echo:hi");

        const last = server.requests[server.requests.length - 1];
        assert.equal(last.headers["mcp-session-id"], "session-123", "后续请求应回传 session id");
        assert.equal(last.headers["mcp-protocol-version"], "2025-06-18", "握手后应附加协议版本头");
    } finally {
        await client.close();
        assert.equal(server.deletes(), 1, "关闭时应发送 DELETE 终止会话");
        await server.close();
    }

    console.log("PASS JSON 响应、session id、协议版本头、DELETE 关闭");
}

/* ---------------------------------------------------------------------------
 * 2. SSE 响应
 * ------------------------------------------------------------------------- */
section("HTTP SSE");

{
    const server = await startServer("sse");
    const client = new McpClient(new McpHttpTransport({ url: server.url }));

    try {
        const init = await client.connect();
        assert.equal(init.serverInfo.name, "http-mcp");

        const tools = await client.listTools();
        assert.deepEqual(tools.map((tool) => tool.name), ["echo"]);

        const result = await client.callTool("echo", { text: "sse" });
        assert.equal((result.content[0] as { text?: string }).text, "echo:sse");
    } finally {
        await client.close();
        await server.close();
    }

    console.log("PASS text/event-stream 响应解析");
}

/* ---------------------------------------------------------------------------
 * 3. 非法 URL
 * ------------------------------------------------------------------------- */
section("URL 校验");

{
    const transport = new McpHttpTransport({ url: "ftp://example.com/mcp" });
    await assert.rejects(() => transport.start(), /Unsupported MCP HTTP protocol/);
    console.log("PASS 非法协议被拒绝");
}

console.log("\nAll MCP HTTP checks passed.");
