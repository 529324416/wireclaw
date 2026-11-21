import assert from "node:assert/strict";

import { McpClient } from "../src/tool/mcp/client";
import { FakeTransport, isRequest, requestMethods, respond, setupHandshake } from "./mcp-fakes";

function section(title: string): void {
    console.log(`\n=== ${title} ===`);
}

section("重连");

const transport = new FakeTransport();
setupHandshake(transport);
const client = new McpClient(transport);

await client.connect();
assert.equal(client.isConnected, true);

transport.fail(new Error("network down"));
assert.equal(client.isConnected, false);

const init = await client.reconnect();
assert.equal(init.serverInfo.name, "fake-mcp");
assert.equal(client.isConnected, true);
assert.equal(
    requestMethods(transport).filter((method) => method === "initialize").length,
    2,
    "重连后应重新握手",
);

transport.handler = (message) => {
    if (!isRequest(message)) return;
    if (message.method === "tools/call") {
        respond(transport, message.id, {
            content: [{ type: "text", text: "after reconnect" }],
        });
    }
};

const result = await client.callTool("echo", { text: "hi" });
assert.equal((result.content[0] as { text?: string }).text, "after reconnect");

await client.close();
console.log("PASS 传输关闭后可重连并继续调用");
console.log("\nAll MCP reconnect checks passed.");
