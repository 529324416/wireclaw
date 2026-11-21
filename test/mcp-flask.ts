import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";

import { ToolRegistry } from "../src/session/tool";
import { createMcpProvider } from "../src/client";

/**
 * MCP 实机测试：连接 examples/mcp_server.py（Flask）。
 *
 * 前置条件：
 *   python examples/mcp_server.py
 *
 * 运行：
 *   npx tsx test/mcp-flask.ts
 */
const MCP_URL = process.env.WIRECLAW_MCP_URL ?? "http://127.0.0.1:5000/mcp";

function section(title: string): void {
    console.log(`\n=== ${title} ===`);
}

const registry = new ToolRegistry({
    onProviderError: (providerId, error) => {
        console.error(`[provider:${providerId}]`, error);
    },
});

registry.registerProvider(createMcpProvider({
    id: "mcp",
    name: "Flask MCP",
    transport: { type: "http", url: MCP_URL },
}));

try {
    section("工具发现");
    const tools = await registry.listTools();
    const names = tools.map((tool) => tool.name);

    assert.ok(names.includes("mcp__echo"), `missing mcp__echo: ${names.join(", ")}`);
    assert.ok(names.includes("mcp__add"));
    assert.ok(names.includes("mcp__python_env"));
    assert.ok(names.includes("mcp__write_temp_file"));
    assert.ok(names.includes("mcp__divide"));

    const echo = tools.find((tool) => tool.name === "mcp__echo");
    assert.equal(echo?.annotations?.readOnlyHint, true);
    assert.equal(echo?.annotations?.requiresApproval, false);

    const write = tools.find((tool) => tool.name === "mcp__write_temp_file");
    assert.equal(write?.annotations?.destructiveHint, true);
    assert.equal(write?.annotations?.requiresApproval, true);
    assert.equal(write?.source?.serverName, "wireclaw-python-mcp");
    console.log(`PASS 发现 ${tools.length} 个 MCP 工具，注解与审批推导正确`);

    section("只读调用");
    const echoResult = await registry.invoke({
        id: "call-echo",
        name: "mcp__echo",
        params: { text: "hello" },
    });
    assert.equal(echoResult.status.isSuccess, true);
    assert.match(String(echoResult.content), /echo: hello/);

    const addResult = await registry.invoke({
        id: "call-add",
        name: "mcp__add",
        params: { a: 3, b: 4 },
    });
    assert.equal(addResult.status.isSuccess, true);
    assert.match(String(addResult.content), /7/);
    assert.deepEqual(addResult.structuredContent, { sum: 7 });

    const envResult = await registry.invoke({
        id: "call-env",
        name: "mcp__python_env",
        params: {},
    });
    assert.equal(envResult.status.isSuccess, true);
    assert.match(String(envResult.content), /Python 3\./);
    console.log(`PASS echo / add / python_env：${String(envResult.content)}`);

    section("isError 映射");
    const divideResult = await registry.invoke({
        id: "call-divide",
        name: "mcp__divide",
        params: { a: 1, b: 0 },
    });
    assert.equal(divideResult.status.isSuccess, false);
    assert.match(String(divideResult.content), /division by zero/);
    console.log("PASS 除零返回 isError");

    section("破坏性调用（Provider 层）");
    const fileName = `wireclaw-test-${Date.now()}.txt`;
    const writeResult = await registry.invoke({
        id: "call-write",
        name: "mcp__write_temp_file",
        params: { name: fileName, content: "written by wireclaw" },
    });
    assert.equal(writeResult.status.isSuccess, true);

    const structured = writeResult.structuredContent as { path?: string } | undefined;
    assert.ok(structured?.path, "should return file path");
    const written = await readFile(structured.path, "utf8");
    assert.equal(written, "written by wireclaw");
    console.log(`PASS write_temp_file -> ${structured.path}`);

    await rm(structured.path, { force: true });
} finally {
    await registry.closeAll();
}

console.log("\nAll MCP Flask checks passed.");
