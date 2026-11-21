import assert from "node:assert/strict";

import { assistant, ToolMessage } from "../src/session/message";
import { AIProvider, ProtocolAdapter } from "../src/session/protocol";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { ToolRegistry } from "../src/session/tool";
import { ChatStopReason, SessionEventType } from "../src/session/type";
import type { AssistantMessage, Message } from "../src/session/message";
import type { ChatOptions, ChatResult, ChatUsage, SessionEvent, SessionRuntimeOptions, StreamChunk } from "../src/session/type";
import { McpToolProvider } from "../src/tool/mcp/provider";
import type { McpServerConfig } from "../src/tool/mcp/config";
import type { McpTool } from "../src/tool/mcp/type";
import { FakeTransport, isRequest, respond, setupHandshake } from "./mcp-fakes";

function section(title: string): void {
    console.log(`\n=== ${title} ===`);
}

function usage(): ChatUsage {
    return { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
}

class NoopAdapter extends ProtocolAdapter {
    toAssistantMessage(_payload: unknown): AssistantMessage {
        throw new Error("not used");
    }
    toPayload(_msg: Message): unknown {
        return {};
    }
    parseStreamChunk(_raw: unknown): StreamChunk[] {
        return [];
    }
}

class ScriptedLLM extends AIProvider {
    private readonly _script: AssistantMessage[];
    private readonly _adapter = new NoopAdapter();

    constructor(script: readonly AssistantMessage[]) {
        super();
        this._script = [...script];
    }

    override get modelProvider(): null {
        return null;
    }
    get protocolAdapter(): ProtocolAdapter {
        return this._adapter;
    }
    get title(): string {
        return "scripted";
    }
    override get supportsTools(): boolean {
        return true;
    }

    async chat(
        _messages: readonly Message[],
        _options: SessionRuntimeOptions,
        turn?: ChatOptions,
    ): Promise<ChatResult> {
        const next = this._script.shift();
        if (next === undefined) throw new Error("script exhausted");
        turn?.onToken?.(next.content, false);
        return { message: next };
    }
}

section("进度探针");

const slowTool: McpTool = {
    name: "slow",
    description: "slow tool with progress",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
};

const transport = new FakeTransport();
setupHandshake(transport);

const handshakeHandler = transport.handler;
transport.handler = (message) => {
    if (!isRequest(message)) return;

    if (message.method === "initialize") {
        handshakeHandler?.(message);
        return;
    }

    if (message.method === "tools/list") {
        respond(transport, message.id, { tools: [slowTool] });
        return;
    }

    if (message.method === "tools/call") {
        const params = message.params as {
            _meta?: { progressToken?: string | number };
        };
        const token = params._meta?.progressToken;

        const sendProgress = (progress: number): void => {
            if (token === undefined) return;
            transport.receive({
                jsonrpc: "2.0",
                method: "notifications/progress",
                params: { progressToken: token, progress, total: 3 },
            });
        };

        sendProgress(1);
        setTimeout(() => sendProgress(2), 60);
        setTimeout(() => {
            respond(transport, message.id, {
                content: [{ type: "text", text: "done" }],
            });
        }, 120);
    }
};

const config: McpServerConfig = {
    id: "mcp",
    heartbeatIntervalMs: 0,
};

const provider = new McpToolProvider(config, transport);
const registry = new ToolRegistry();
registry.registerProvider(provider);

const llm = new ScriptedLLM([
    assistant("", undefined, usage(), [{ id: "c1", name: "mcp__slow", params: {} }], ChatStopReason.ToolCall),
    assistant("finished", undefined, usage(), undefined, ChatStopReason.Stop),
]);
const session = new Session(llm, new SessionHistory(), {});

const progressEvents: SessionEvent[] = [];
session.subscribe((event) => {
    if (event.type === SessionEventType.TOOL_PROGRESS) progressEvents.push(event);
});

try {
    const run = await session.run("go", {
        tools: registry,
        toolProgressDelayMs: 30,
    });

    assert.equal(run.status, RunStatus.Completed);

    const toolMessage = session.history?.messages[2] as ToolMessage;
    assert.equal(toolMessage.isSuccess, true);

    const latest = run.getToolProgress("c1");
    assert.ok(latest !== undefined);
    assert.equal(latest.progress, 2);

    const emitted = progressEvents
        .filter((event) => event.type === SessionEventType.TOOL_PROGRESS)
        .map((event) => event.progress.progress);
    assert.ok(emitted.includes(2), `expected progress 2 event, got ${JSON.stringify(emitted)}`);

    console.log(`PASS 进度回调可用，事件�?${JSON.stringify(emitted)}`);
} finally {
    await registry.closeAll();
}

console.log("\nAll MCP progress checks passed.");
