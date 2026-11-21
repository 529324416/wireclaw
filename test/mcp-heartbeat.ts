import assert from "node:assert/strict";

import { McpClient } from "../src/tool/mcp/client";
import { FakeTransport, isRequest, respond, setupHandshake } from "./mcp-fakes";

function section(title: string): void {
    console.log(`\n=== ${title} ===`);
}

section("心跳");

const transport = new FakeTransport();
setupHandshake(transport);

let pings = 0;
const handshakeHandler = transport.handler;
transport.handler = (message) => {
    if (!isRequest(message)) return;

    if (message.method === "initialize") {
        handshakeHandler?.(message);
        return;
    }

    if (message.method === "ping") {
        pings += 1;
        respond(transport, message.id, {});
    }
};

const client = new McpClient(transport, { heartbeatIntervalMs: 20 });

try {
    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.ok(pings >= 2, `expected heartbeat pings, got ${pings}`);
    assert.equal(client.isHealthy, true);
    assert.ok(client.lastPongAt !== null);

    console.log(`PASS 心跳正常（${pings} 次 ping）`);
} finally {
    await client.close();
}

const pingsAfterClose = pings;
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(pings, pingsAfterClose, "关闭后不应继续发送 ping");
console.log("PASS 关闭后停止心跳");

console.log("\nAll MCP heartbeat checks passed.");
