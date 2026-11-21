import assert from "node:assert/strict";

import { ToolErrorType } from "../src/session/error";
import { assistant, ToolMessage } from "../src/session/message";
import { AIProvider, ProtocolAdapter } from "../src/session/protocol";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { ToolRegistry } from "../src/session/tool";
import { ChatStopReason } from "../src/session/type";
import type { AssistantMessage, Message } from "../src/session/message";
import type { ChatOptions, ChatResult, ChatUsage, SessionRuntimeOptions, StreamChunk, ToolCall, ToolCallResult, ToolDefinition } from "../src/session/type";
import type { ToolProvider } from "../src/session/tool";

function section(title: string): void {
    console.log(`\n=== ${title} ===`);
}

function usage(): ChatUsage {
    return { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function provider(
    id: string,
    tools: ToolDefinition[],
    onCall?: (call: ToolCall) => Promise<ToolCallResult> | ToolCallResult,
): ToolProvider {
    return {
        id,
        name: id,
        description: id,
        async fetchTools() {
            return tools;
        },
        async call(call) {
            if (onCall !== undefined) return await onCall(call);
            return { content: "ok", status: { isSuccess: true, duration: 0 } };
        },
    };
}

/* ---------------------------------------------------------------------------
 * 1. 工具结果体量上限（契约层统一处理�? * ------------------------------------------------------------------------- */
section("结果截断");

{
    const tool: ToolDefinition = {
        name: "long",
        description: "returns a long text",
        inputSchema: { type: "object" },
    };

    const registry = new ToolRegistry({ maxResultChars: 20 });
    registry.registerProvider(provider("p", [tool], () => ({
        content: "x".repeat(100),
        status: { isSuccess: true, duration: 0 },
    })));

    const result = await registry.invoke({ id: "c1", name: "p__long", params: {} });
    assert.equal(typeof result.content, "string");
    assert.match(String(result.content), /truncated: 80 chars omitted/);
    console.log("PASS 超长结果被截断并标记");
}

/* ---------------------------------------------------------------------------
 * 2. outputSchema 校验
 * ------------------------------------------------------------------------- */
section("outputSchema");

{
    const tool: ToolDefinition = {
        name: "sum",
        description: "returns { sum }",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
            type: "object",
            properties: { sum: { type: "number" } },
            required: ["sum"],
        },
    };

    const good = new ToolRegistry();
    good.registerProvider(provider("p", [tool], () => ({
        content: "7",
        status: { isSuccess: true, duration: 0 },
        structuredContent: { sum: 7 },
    })));
    const goodResult = await good.invoke({ id: "c1", name: "p__sum", params: {} });
    assert.equal(goodResult.status.isSuccess, true);

    const bad = new ToolRegistry();
    bad.registerProvider(provider("p", [tool], () => ({
        content: "bad",
        status: { isSuccess: true, duration: 0 },
        structuredContent: { sum: "not a number" },
    })));
    const badResult = await bad.invoke({ id: "c2", name: "p__sum", params: {} });
    assert.equal(badResult.status.isSuccess, false);
    assert.equal(badResult.status.error?.type, ToolErrorType.ProviderError);
    assert.match(String(badResult.content), /outputSchema/);
    console.log("PASS 结构不匹配时作为失败结果回传");
}

/* ---------------------------------------------------------------------------
 * 3. 工具列表缓存 TTL
 * ------------------------------------------------------------------------- */
section("缓存 TTL");

{
    const tool: ToolDefinition = {
        name: "t",
        description: "t",
        inputSchema: { type: "object" },
    };

    let fetches = 0;
    const registry = new ToolRegistry({ toolCacheTtlMs: 20 });
    registry.registerProvider({
        id: "p",
        name: "p",
        description: "p",
        async fetchTools() {
            fetches += 1;
            return [tool];
        },
        async call() {
            return { content: "ok", status: { isSuccess: true, duration: 0 } };
        },
    });

    await registry.listTools();
    const afterFirst = fetches;
    await registry.listTools();
    assert.equal(fetches, afterFirst, "TTL 内应命中缓存");

    await sleep(30);
    await registry.listTools();
    assert.equal(fetches, afterFirst + 1, "TTL 过期后应重新拉取");
    console.log("PASS TTL 内命中缓存、过期后刷新");
}

/* ---------------------------------------------------------------------------
 * 4. adviceTimeout
 * ------------------------------------------------------------------------- */
section("adviceTimeout");

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

{
    const slowTool: ToolDefinition = {
        name: "slow",
        description: "never resolves",
        inputSchema: { type: "object" },
        adviceTimeout: 40,
    };

    const registry = new ToolRegistry();
    registry.registerProvider({
        id: "p",
        name: "p",
        description: "p",
        async fetchTools() {
            return [slowTool];
        },
        async call() {
            return new Promise<ToolCallResult>(() => {
                // 永不返回，等�?Registry 超时
            });
        },
    });

    const llm = new ScriptedLLM([
        assistant("", undefined, usage(), [{ id: "c1", name: "p__slow", params: {} }], ChatStopReason.ToolCall),
        assistant("done", undefined, usage(), undefined, ChatStopReason.Stop),
    ]);
    const session = new Session(llm, new SessionHistory(), {});

    const startedAt = Date.now();
    const run = await session.run("x", { tools: registry });
    const elapsed = Date.now() - startedAt;

    assert.equal(run.status, RunStatus.Completed);
    const toolMessage = session.history?.messages[2] as ToolMessage;
    assert.equal(toolMessage.isSuccess, false);
    assert.equal(toolMessage.error?.type, ToolErrorType.Timeout);
    assert.ok(elapsed < 2_000, `超时耗时异常: ${elapsed}ms`);
    console.log(`PASS adviceTimeout=40ms 生效（实�?${elapsed}ms）`);
}

console.log("\nAll tool contract checks passed.");
