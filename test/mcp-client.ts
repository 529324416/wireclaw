import assert from "node:assert/strict";

import { McpClient } from "../src/tool/mcp/client";
import {
    McpAbortError,
    McpProtocolError,
    McpResponseError,
    McpTimeoutError,
    McpTransportError,
} from "../src/tool/mcp/error";
import { McpErrorCode } from "../src/tool/mcp/type";
import { FakeTransport, isRequest, requestMethods, respond, respondError, setupHandshake } from "./mcp-fakes";

function section(title: string): void {
    console.log(`\n=== ${title} ===`);
}

function newClient(version = "2025-06-18"): { client: McpClient; transport: FakeTransport } {
    const transport = new FakeTransport();
    setupHandshake(transport, version);
    return { client: new McpClient(transport), transport };
}

/* ---------------------------------------------------------------------------
 * 1. 握手
 * ------------------------------------------------------------------------- */
section("握手");

{
    const { client, transport } = newClient();

    const init = await client.connect();
    assert.equal(init.protocolVersion, "2025-06-18");
    assert.equal(init.serverInfo.name, "fake-mcp");
    assert.equal(init.serverInfo.version, "1.2.3");
    assert.equal(init.capabilities.tools?.listChanged, true);
    assert.equal(client.isConnected, true);
    assert.deepEqual(requestMethods(transport), ["initialize"]);
    assert.equal(
        transport.sent.some((message) => "method" in message && message.method === "notifications/initialized"),
        true,
        "握手后应发送 notifications/initialized",
    );

    await client.connect();
    assert.deepEqual(requestMethods(transport), ["initialize"], "重复 connect 不应重新握手");
    console.log("PASS 握手、能力、幂等");
}

/* ---------------------------------------------------------------------------
 * 2. 版本不支持
 * ------------------------------------------------------------------------- */
section("版本协商");

{
    const { client } = newClient("1999-01-01");
    await assert.rejects(() => client.connect(), (error: unknown) => {
        return error instanceof McpProtocolError && /Unsupported MCP protocol version/.test(error.message);
    });
    console.log("PASS 不支持的版本被拒绝");
}

/* ---------------------------------------------------------------------------
 * 3. tools/list 分页与去重
 * ------------------------------------------------------------------------- */
section("tools/list");

{
    const transport = new FakeTransport();
    setupHandshake(transport);
    transport.handler = ((previous) => (message) => {
        if (!isRequest(message)) return;
        if (message.method === "initialize") { previous?.(message); return; }

        if (message.method === "tools/list") {
            const params = message.params as { cursor?: string } | undefined;
            if (params?.cursor === undefined) {
                respond(transport, message.id, {
                    tools: [
                        { name: "alpha", description: "a", inputSchema: { type: "object" } },
                        { name: "alpha", description: "duplicate", inputSchema: { type: "object" } },
                    ],
                    nextCursor: "page-2",
                });
            } else {
                respond(transport, message.id, {
                    tools: [
                        { name: "beta", description: "b", inputSchema: { type: "object" } },
                    ],
                });
            }
        }
    })(transport.handler);

    const client = new McpClient(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["alpha", "beta"]);
    assert.equal(requestMethods(transport).filter((method) => method === "tools/list").length, 2);
    console.log("PASS 自动翻页、按名称去重");
}

/* ---------------------------------------------------------------------------
 * 4. tools/call 与 JSON-RPC 错误
 * ------------------------------------------------------------------------- */
section("tools/call");

{
    const transport = new FakeTransport();
    setupHandshake(transport);
    transport.handler = ((previous) => (message) => {
        if (!isRequest(message)) return;
        if (message.method === "initialize") { previous?.(message); return; }

        if (message.method === "tools/call") {
            const params = message.params as { name: string; arguments: Record<string, unknown> };
            if (params.name === "boom") {
                respondError(transport, message.id, { code: McpErrorCode.InvalidParams, message: "bad args" });
                return;
            }
            respond(transport, message.id, {
                content: [{ type: "text", text: `hello ${String(params.arguments.name)}` }],
            });
        }
    })(transport.handler);

    const client = new McpClient(transport);
    const result = await client.callTool("greet", { name: "wireclaw" });
    assert.equal(result.content.length, 1);
    assert.deepEqual(result.content[0], { type: "text", text: "hello wireclaw" });

    await assert.rejects(
        () => client.callTool("boom", {}),
        (error: unknown) => error instanceof McpResponseError
            && error.rpcCode === McpErrorCode.InvalidParams
            && /bad args/.test(error.message),
    );
    console.log("PASS 工具调用与 JSON-RPC 错误映射");
}

/* ---------------------------------------------------------------------------
 * 5. 超时
 * ------------------------------------------------------------------------- */
section("超时");

{
    const { client, transport } = newClient();
    await client.connect();

    // tools/call 永不响应
    transport.handler = (message) => {
        if (isRequest(message) && message.method === "tools/call") return;
    };

    const startedAt = Date.now();
    await assert.rejects(
        () => client.callTool("slow", {}, { timeoutMs: 40 }),
        (error: unknown) => error instanceof McpTimeoutError,
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 30 && elapsed < 2_000, `超时耗时异常: ${elapsed}ms`);

    const cancelled = transport.sent.find(
        (message) => "method" in message && message.method === "notifications/cancelled",
    );
    assert.ok(cancelled !== undefined, "超时后应发送 notifications/cancelled");
    console.log("PASS 请求超时与取消通知");
}

/* ---------------------------------------------------------------------------
 * 6. AbortSignal
 * ------------------------------------------------------------------------- */
section("取消");

{
    const { client, transport } = newClient();
    await client.connect();
    transport.handler = (message) => {
        if (isRequest(message) && message.method === "tools/call") return;
    };

    const controller = new AbortController();
    const pending = client.callTool("slow", {}, { signal: controller.signal, timeoutMs: 5_000 });
    const expectation = assert.rejects(pending, (error: unknown) => error instanceof McpAbortError);
    setTimeout(() => controller.abort(), 10);
    await expectation;

    const cancelled = transport.sent.find(
        (message) => "method" in message && message.method === "notifications/cancelled",
    );
    assert.ok(cancelled !== undefined, "取消后应发送 notifications/cancelled");
    console.log("PASS AbortSignal 取消与通知");
}

/* ---------------------------------------------------------------------------
 * 7. 服务端通知与反向请求
 * ------------------------------------------------------------------------- */
section("通知与反向请求");

{
    const { client, transport } = newClient();
    await client.connect();

    let toolsChanged = 0;
    client.onToolsChanged(() => {
        toolsChanged += 1;
    });

    transport.receive({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    assert.equal(toolsChanged, 1);

    transport.receive({ jsonrpc: "2.0", id: "server-1", method: "sampling/createMessage", params: {} });
    const reply = transport.sent.find(
        (message) => !("method" in message) && message.id === "server-1",
    );
    assert.ok(reply !== undefined && !("method" in reply));
    assert.equal(reply.error?.code, McpErrorCode.MethodNotFound);
    console.log("PASS list_changed 通知、服务端能力请求被拒绝");
}

/* ---------------------------------------------------------------------------
 * 8. 传输关闭
 * ------------------------------------------------------------------------- */
section("关闭");

{
    const { client, transport } = newClient();
    await client.connect();
    transport.handler = (message) => {
        if (isRequest(message) && message.method === "tools/call") return;
    };

    const pending = client.callTool("slow", {}, { timeoutMs: 10_000 });
    const expectation = assert.rejects(pending, (error: unknown) => error instanceof McpTransportError);

    await client.close();
    await expectation;

    assert.equal(transport.closed, true);
    assert.equal(client.isConnected, false);
    console.log("PASS 关闭时拒绝等待中的请求");
}

console.log("\nAll MCP client checks passed.");
