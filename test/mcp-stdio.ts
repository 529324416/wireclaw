import assert from "node:assert/strict";
import { resolve } from "node:path";

import { McpClient } from "../src/tool/mcp/client";
import { McpStdioTransport } from "../src/client";

/**
 * stdio 传输实机测试：启动 Python 子进程，通过 NDJSON 走 MCP 协议。
 *
 * 运行：
 *   npx tsx test/mcp-stdio.ts
 */
const script = resolve(process.cwd(), "test/fixtures/mcp_stdio_server.py");
const python = process.env.PYTHON ?? "python";

const transport = new McpStdioTransport({
    command: python,
    args: [script],
    onStderr: (chunk) => process.stderr.write(chunk),
});

const client = new McpClient(transport);

try {
    const init = await client.connect();
    assert.equal(init.serverInfo.name, "wireclaw-stdio-mcp");
    assert.equal(init.protocolVersion, "2025-06-18");

    const tools = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["echo", "stdio_env"]);

    const echo = await client.callTool("echo", { text: "hello" });
    assert.match(String((echo.content[0] as { text?: string }).text), /stdio echo: hello/);

    const env = await client.callTool("stdio_env", {});
    assert.match(String((env.content[0] as { text?: string }).text), /Python 3\./);

    console.log("PASS stdio 握手 / 工具列表 / 工具调用");
} finally {
    await client.close();
}

console.log("\nAll MCP stdio checks passed.");
