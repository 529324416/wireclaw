import assert from "node:assert/strict";

import { McpClient } from "../src/tool/mcp/client";
import { MCP_PROTOCOL_VERSION, MCP_SUPPORTED_VERSIONS } from "../src/tool/mcp/type";
import { FakeTransport, setupHandshake } from "./mcp-fakes";

assert.equal(MCP_PROTOCOL_VERSION, "2025-11-25");
assert.deepEqual([...MCP_SUPPORTED_VERSIONS], ["2025-11-25", "2025-06-18"]);

{
    const transport = new FakeTransport();
    setupHandshake(transport, "2025-11-25");
    const client = new McpClient(transport);
    const init = await client.connect();
    assert.equal(init.protocolVersion, "2025-11-25");
    await client.close();
}

{
    const transport = new FakeTransport();
    setupHandshake(transport, "2025-06-18");
    const client = new McpClient(transport);
    const init = await client.connect();
    assert.equal(init.protocolVersion, "2025-06-18");
    await client.close();
}

{
    const transport = new FakeTransport();
    setupHandshake(transport, "2024-11-05");
    const client = new McpClient(transport);
    await assert.rejects(() => client.connect(), /Unsupported MCP protocol version/);
    await client.close();
}

console.log("PASS MCP 协议版本窗口与旧版本拒绝");
