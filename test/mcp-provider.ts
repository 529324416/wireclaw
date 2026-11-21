import assert from "node:assert/strict";

import { isToolError, ToolErrorType } from "../src/session/error";
import { ToolRegistry } from "../src/session/tool";
import type { McpServerConfig } from "../src/tool/mcp/config";
import { MAX_TOOL_ID_LENGTH, sanitizeToolId } from "../src/tool/mcp/naming";
import { McpToolProvider } from "../src/tool/mcp/provider";
import { McpErrorCode } from "../src/tool/mcp/type";
import type { McpTool } from "../src/tool/mcp/type";
import { FakeTransport, isRequest, respond, respondError, setupHandshake } from "./mcp-fakes";

function section(title: string): void {
    console.log(`\n=== ${title} ===`);
}

const tools: McpTool[] = [
    {
        name: "fs.read",
        description: "read a file",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
        },
        annotations: { readOnlyHint: true },
    },
    {
        name: "fs__write",
        description: "write a file",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
        },
        annotations: { destructiveHint: true },
    },
    {
        name: "dup.a",
        description: "collision one",
        inputSchema: { type: "object" },
    },
    {
        name: "dup_a",
        description: "collision two",
        inputSchema: { type: "object" },
    },
];

const config: McpServerConfig = {
    id: "mcp",
};

let toolListCalls = 0;

const transport = new FakeTransport();
setupHandshake(transport);
transport.handler = ((previous) => (message) => {
    if (!isRequest(message)) return;
    if (message.method === "initialize") {
        previous?.(message);
        return;
    }

    if (message.method === "tools/list") {
        toolListCalls += 1;
        respond(transport, message.id, { tools });
        return;
    }

    if (message.method === "tools/call") {
        const params = message.params as { name: string; arguments: Record<string, unknown> };

        if (params.arguments.path === "missing") {
            respondError(transport, message.id, {
                code: McpErrorCode.InvalidParams,
                message: "bad args",
            });
            return;
        }

        if (params.name.endsWith("write")) {
            respond(transport, message.id, {
                content: [{ type: "text", text: "write failed" }],
                isError: true,
            });
            return;
        }

        respond(transport, message.id, {
            content: [{ type: "text", text: `body:${String(params.arguments.path ?? "")}` }],
        });
    }
})(transport.handler);

const provider = new McpToolProvider(config, transport);

/* ---------------------------------------------------------------------------
 * 1. 工具名消毒与注解映射
 * ------------------------------------------------------------------------- */
section("工具定义映射");

{
    assert.equal(sanitizeToolId("a.b"), "a_b");
    assert.equal(sanitizeToolId("a__b"), "a_b");
    assert.equal(sanitizeToolId(""), "tool");
    assert.ok(sanitizeToolId("x".repeat(100)).length <= MAX_TOOL_ID_LENGTH);

    const definitions = await provider.fetchTools();
    assert.deepEqual(definitions.map((definition) => definition.name), [
        "fs_read",
        "fs_write",
        "dup_a",
        "dup_a_2",
    ]);

    const readDefinition = definitions[0];
    assert.equal(readDefinition.title, "fs.read");
    assert.equal(readDefinition.annotations?.readOnlyHint, true);
    assert.equal(readDefinition.annotations?.requiresApproval, false);
    assert.equal(readDefinition.annotations?.concurrencySafe, false);
    assert.equal(readDefinition.source?.serverName, "fake-mcp");
    assert.equal(readDefinition.source?.version, "1.2.3");

    const writeDefinition = definitions[1];
    assert.equal(writeDefinition.name, "fs_write");
    assert.equal(writeDefinition.title, "fs__write", "title 保留原始工具名");
    assert.equal(writeDefinition.annotations?.destructiveHint, true);
    assert.equal(writeDefinition.annotations?.requiresApproval, true);

    assert.equal(definitions[2].annotations?.requiresApproval, true, "非只读工具默认需要审批");
    console.log("PASS 消毒、冲突后缀、注解/审批推导、source 填充");
}

/* ---------------------------------------------------------------------------
 * 2. 调用：安全名 -> 原始名
 * ------------------------------------------------------------------------- */
section("调用映射");

{
    const result = await provider.call({
        id: "c1",
        name: "fs_read",
        params: { path: "a" },
    });

    assert.equal(result.status.isSuccess, true);
    assert.equal(result.content, "body:a");

    const request = transport.sent
        .filter(isRequest)
        .find((message) => message.method === "tools/call");
    assert.ok(request !== undefined);
    assert.deepEqual(request.params, {
        name: "fs.read",
        arguments: { path: "a" },
    });
    console.log("PASS safe id 反向映射为 MCP 原始名");
}

/* ---------------------------------------------------------------------------
 * 3. isError 与 JSON-RPC 错误
 * ------------------------------------------------------------------------- */
section("结果与错误");

{
    const failed = await provider.call({
        id: "c2",
        name: "fs_write",
        params: { path: "b" },
    });
    assert.equal(failed.status.isSuccess, false);
    assert.equal(failed.status.error?.type, ToolErrorType.ProviderError);
    assert.equal(failed.content, "write failed");

    await assert.rejects(
        () => provider.call({ id: "c3", name: "fs_read", params: { path: "missing" } }),
        (error: unknown) => isToolError(error)
            && error.type === ToolErrorType.ProviderError
            && /MCP error -32602/.test(error.message),
    );

    await assert.rejects(
        () => provider.call({ id: "c4", name: "unknown_tool", params: {} }),
        (error: unknown) => isToolError(error) && error.type === ToolErrorType.NotFound,
    );
    console.log("PASS isError / JSON-RPC 错误 / NotFound");
}

/* ---------------------------------------------------------------------------
 * 4. Registry 联动：缓存失效与 closeAll
 * ------------------------------------------------------------------------- */
section("Registry 联动");

{
    const registry = new ToolRegistry();
    registry.registerProvider(provider);

    const listed = await registry.listTools();
    assert.deepEqual(listed.map((tool) => tool.name), [
        "mcp__fs_read",
        "mcp__fs_write",
        "mcp__dup_a",
        "mcp__dup_a_2",
    ]);
    assert.equal(listed[0].source.providerId, "mcp");

    const before = toolListCalls;
    transport.receive({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    await registry.listTools();
    assert.equal(toolListCalls, before + 1, "list_changed 后 Registry 应重新拉取工具");

    await registry.closeAll();
    assert.equal(transport.closed, true);
    assert.deepEqual(await registry.listTools(), []);
    console.log("PASS list_changed 失效缓存、closeAll 关闭 Provider");
}

console.log("\nAll MCP provider checks passed.");
