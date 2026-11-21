import assert from "node:assert/strict";

import { AIProvider } from "../src/session/protocol";
import { ToolRegistry } from "../src/session/tool";
import type { ToolProvider } from "../src/session/tool";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { SessionEventType, ChatStopReason, SessionPermission } from "../src/session/type";
import type {
    ChatOptions,
    ChatResult,
    ChatUsage,
    SessionEvent,
    SessionRuntimeOptions,
    ToolCall,
    ToolCallResult,
    ToolDefinition,
} from "../src/session/type";
import { ToolMessage, assistant } from "../src/session/message";
import type { Message } from "../src/session/message";

function usage(prompt = 1, completion = 1): ChatUsage {
    return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
}

function toolProvider(): ToolProvider {
    const definitions: ToolDefinition[] = [
        { name: "read", description: "read", inputSchema: { type: "object" }, defaultTrust: "untrusted" },
        { name: "write", description: "write", inputSchema: { type: "object" }, defaultTrust: "trusted" },
        { name: "fallback", description: "fallback", inputSchema: { type: "object" } },
        {
            name: "danger",
            description: "danger",
            inputSchema: { type: "object" },
            defaultTrust: "untrusted",
            annotations: { destructiveHint: true, requiresApproval: true },
        },
    ];

    return {
        id: "p",
        name: "p",
        description: "p",
        defaultTrust: "unknown",
        async fetchTools(): Promise<ToolDefinition[]> {
            return definitions;
        },
        async call(call: ToolCall): Promise<ToolCallResult> {
            return {
                content: `ok:${call.name}`,
                status: { isSuccess: true, duration: 0 },
            };
        },
    };
}

/* ---------------------------------------------------------------------------
 * 1. Tool / Provider 双层默认值
 * ------------------------------------------------------------------------- */
{
    const registry = new ToolRegistry();
    registry.registerProvider(toolProvider());

    const read = await registry.invoke({ id: "1", name: "p__read", params: {} });
    const write = await registry.invoke({ id: "2", name: "p__write", params: {} });
    const fallback = await registry.invoke({ id: "3", name: "p__fallback", params: {} });

    assert.equal(read.trust, "untrusted");
    assert.equal(write.trust, "trusted");
    assert.equal(fallback.trust, "unknown", "provider default should be used");
    console.log("PASS tool/provider default trust");
}

/* ---------------------------------------------------------------------------
 * 2. trustHandle 覆盖、undefined 回退与异常 fail-closed
 * ------------------------------------------------------------------------- */
{
    const seen: string[] = [];
    const providerErrors: unknown[] = [];
    const registry = new ToolRegistry({
        onProviderError: (_id, error) => providerErrors.push(error),
        trustHandle: async (call, _result, definition) => {
            seen.push(`${call.name}:${definition?.name ?? "null"}`);
            if (call.name === "p__read") return { trust: "trusted", reason: "workspace whitelist" };
            if (call.name === "p__fallback") return undefined;
            throw new Error("trust backend unavailable");
        },
    });
    registry.registerProvider(toolProvider());

    const read = await registry.invoke({ id: "1", name: "p__read", params: {} });
    const fallback = await registry.invoke({ id: "2", name: "p__fallback", params: {} });
    const write = await registry.invoke({ id: "3", name: "p__write", params: {} });

    assert.equal(read.trust, "trusted");
    assert.equal(read.trustReason, "workspace whitelist");
    assert.equal(fallback.trust, "unknown");
    assert.equal(write.trust, "untrusted");
    assert.match(String(write.trustReason), /trust handle failed/);
    assert.equal(providerErrors.length, 1);
    assert.deepEqual(seen, ["p__read:p__read", "p__fallback:p__fallback", "p__write:p__write"]);
    console.log("PASS trustHandle override/fallback/fail-closed");
}

{
    const registry = new ToolRegistry({
        trustHandle: () => ({ trust: "bogus" as never }),
    });
    registry.registerProvider(toolProvider());

    const result = await registry.invoke({ id: "1", name: "p__read", params: {} });
    assert.equal(result.trust, "untrusted");
    assert.match(String(result.trustReason), /invalid decision/);
    console.log("PASS trustHandle invalid decision fails closed");
}

/* ---------------------------------------------------------------------------
 * 3. full 模式不因 untrusted 进入审批
 * ------------------------------------------------------------------------- */
{
    class ScriptedLLM extends AIProvider {
        private readonly _script: ReturnType<typeof assistant>[];

        constructor(script: ReturnType<typeof assistant>[]) {
            super();
            this._script = [...script];
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
            _turn?: ChatOptions,
        ): Promise<ChatResult> {
            const next = this._script.shift();
            if (next === undefined) throw new Error("script exhausted");
            return { message: next };
        }
    }

    const registry = new ToolRegistry();
    registry.registerProvider(toolProvider());

    const llm = new ScriptedLLM([
        assistant(
            "",
            undefined,
            usage(),
            [{ id: "call-danger", name: "p__danger", params: {} }],
            ChatStopReason.ToolCall,
        ),
        assistant("done", undefined, usage(), undefined, ChatStopReason.Stop),
    ]);
    const session = new Session(llm, new SessionHistory(), { model: "scripted" });
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));

    const run = await session.run("do it", {
        tools: registry,
        permission: SessionPermission.Full,
    });

    assert.equal(run.status, RunStatus.Completed);
    assert.equal(
        events.some((event) => event.type === SessionEventType.TOOL_APPROVAL_REQUIRED),
        false,
        "full must not ask for approval because of trust",
    );
    assert.equal(
        events.some((event) => event.type === SessionEventType.TOOL_PERMISSION_WARNING),
        true,
    );

    const end = events.find((event) => event.type === SessionEventType.TOOL_CALL_END);
    assert.ok(end !== undefined && end.type === SessionEventType.TOOL_CALL_END);
    assert.equal(end.result.trust, "untrusted");

    const toolMessage = session.history?.messages.find(
        (message): message is ToolMessage => message instanceof ToolMessage,
    );
    assert.ok(toolMessage !== undefined);
    assert.equal(toolMessage.trust, "untrusted");
    console.log("PASS full executes untrusted tool without approval and persists trust");
}

console.log("\nAll tool trust checks passed.");
