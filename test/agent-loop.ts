import assert from "node:assert/strict";

import { OllamaProvider, OllamaProtocolAdapter } from "../src/platform/ollama";
import { ToolError, ToolErrorType } from "../src/session/error";
import {
    AssistantMessage,
    ToolMessage,
    UserMessage,
    assistant,
} from "../src/session/message";
import { AIProvider, ProtocolAdapter } from "../src/session/protocol";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { ToolRegistry } from "../src/session/tool";
import { ChatStopReason, SessionEventType } from "../src/session/type";
import type { Message } from "../src/session/message";
import type { ChatOptions, ChatResult, ChatUsage, MessageContent, SessionRuntimeOptions, StreamChunk, ToolCall, ToolDefinition } from "../src/session/type";
import type { ToolCallOptions, ToolProvider } from "../src/session/tool";
import type { ToolCallResult } from "../src/session/type";

/* ---------------------------------------------------------------------------
 * 测试替身
 * ------------------------------------------------------------------------- */

class NoopAdapter extends ProtocolAdapter {
    toAssistantMessage(_payload: unknown): AssistantMessage {
        throw new Error("NoopAdapter.toAssistantMessage is not used by the tests");
    }
    toPayload(_msg: Message): unknown {
        return {};
    }
    parseStreamChunk(_raw: unknown): StreamChunk[] {
        return [];
    }
}

type LlmRequest = { messages: readonly Message[]; tools?: ToolDefinition[] };

class ScriptedLLM extends AIProvider {
    readonly requests: LlmRequest[] = [];

    private readonly _script: AssistantMessage[];
    private readonly _supportsTools: boolean;
    private readonly _adapter = new NoopAdapter();

    constructor(script: readonly AssistantMessage[], supportsTools = true) {
        super();
        this._script = [...script];
        this._supportsTools = supportsTools;
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
        return this._supportsTools;
    }

    async chat(
        messages: readonly Message[],
        _options: SessionRuntimeOptions,
        turn?: ChatOptions,
    ): Promise<ChatResult> {
        this.requests.push({ messages: [...messages], tools: turn?.tools });

        const next = this._script.shift();
        if (next === undefined) throw new Error("script exhausted");

        turn?.onToken?.(next.content, false);
        return { message: next };
    }
}

const readTool: ToolDefinition = {
    name: "readFile",
    description: "read a file",
    inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
    },
};

type FakeOptions = {
    tools?: ToolDefinition[];
    fetchCount?: { value: number };
    onCall?: (call: ToolCall, options?: ToolCallOptions) => Promise<ToolCallResult> | ToolCallResult;
};

function fakeProvider(id: string, options: FakeOptions = {}): ToolProvider {
    return {
        id,
        name: id,
        description: id,
        async fetchTools() {
            if (options.fetchCount !== undefined) options.fetchCount.value += 1;
            return options.tools ?? [];
        },
        async call(call, callOptions) {
            if (options.onCall !== undefined) return await options.onCall(call, callOptions);
            return { content: `ok:${call.name}`, status: { isSuccess: true, duration: 0 } };
        },
    };
}

function usage(prompt = 1, completion = 1): ChatUsage {
    return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
}

function textOf(content: MessageContent): string {
    if (typeof content === "string") return content;
    return content.map((part) => part.type === "text" ? part.text : "").join("");
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function section(title: string): void {
    console.log(`\n=== ${title} ===`);
}

const toolCall = (id: string, params: Record<string, unknown> = { path: "a" }): ToolCall => ({
    id,
    name: "filesystem__readFile",
    params,
});

/** 记录事件�?Session */
function trackedSession(llm: ScriptedLLM): {
    session: Session;
    history: SessionHistory;
    events: Parameters<Parameters<Session["subscribe"]>[0]>[0][];
}{
    const history = new SessionHistory();
    const session = new Session(llm, history, {});
    const events: Parameters<Parameters<Session["subscribe"]>[0]>[0][] = [];
    session.subscribe((event) => events.push(event));
    return { session, history, events };
}

/* ---------------------------------------------------------------------------
 * 1. 完整循环：对�?-> 工具调用 -> 工具结果 -> 再次对话 -> 结束
 * ------------------------------------------------------------------------- */
section("完整循环");

const calls: ToolCall[] = [];
const fetchCount = { value: 0 };
const registry = new ToolRegistry();
registry.registerProvider(fakeProvider("filesystem", {
    tools: [readTool],
    fetchCount,
    onCall: (call) => {
        calls.push(call);
        return {
            content: `content:${String(call.params.path)}`,
            status: { isSuccess: true, duration: 0 },
        };
    },
}));

const llm = new ScriptedLLM([
    assistant("", undefined, usage(), [toolCall("c1", { path: "a.md" })], ChatStopReason.ToolCall),
    assistant("done", undefined, usage(), undefined, ChatStopReason.Stop),
]);
const { session, history, events } = trackedSession(llm);

const run = await session.run("read a.md", { tools: registry });

assert.equal(run.status, RunStatus.Completed);
assert.equal(history.messages.length, 4, "user / assistant / tool / assistant");

const [userMsg, assistantMsg, toolMsg, finalMsg] = history.messages;
assert.ok(userMsg instanceof UserMessage);
assert.ok(assistantMsg instanceof AssistantMessage);
assert.ok(toolMsg instanceof ToolMessage);
assert.ok(finalMsg instanceof AssistantMessage);

assert.equal(toolMsg.toolName, "filesystem__readFile");
assert.equal(toolMsg.callId, "c1");
assert.equal(textOf(toolMsg.content), "content:a.md");
assert.equal(toolMsg.isSuccess, true);
assert.equal(textOf(finalMsg.content), "done");

assert.equal(calls[0].name, "readFile", "Provider 只应收到裸工具名");
assert.deepEqual(llm.requests[0].tools?.map((tool) => tool.name), ["filesystem__readFile", "host__ask_user"]);
assert.deepEqual(llm.requests[1].tools?.map((tool) => tool.name), ["filesystem__readFile", "host__ask_user"]);
assert.equal(llm.requests[1].messages.length, 3, "第二轮请求应携带工具结果");
assert.equal(fetchCount.value, 1, "Fetch tools exactly once per run");

const eventTypes = events.map((event) => event.type);
assert.equal(eventTypes.filter((type) => type === SessionEventType.ASSISTANT_COMPLETE).length, 1);
assert.equal(eventTypes.filter((type) => type === SessionEventType.ASSISTANT_COMPLETE_TURN).length, 2);
assert.equal(eventTypes.filter((type) => type === SessionEventType.TOOL_CALL_START).length, 1);
assert.equal(eventTypes.filter((type) => type === SessionEventType.TOOL_CALL_END).length, 1);
assert.equal(eventTypes.indexOf(SessionEventType.TOOL_CALL_START) < eventTypes.indexOf(SessionEventType.TOOL_CALL_END), true);

const complete = events.find((event) => event.type === SessionEventType.ASSISTANT_COMPLETE);
assert.ok(complete !== undefined && complete.type === SessionEventType.ASSISTANT_COMPLETE);
assert.equal(complete.usage.totalTokens, 4, "ASSISTANT_COMPLETE should carry total usage");
console.log("PASS loop order, ToolMessage materialization, events, tool dispatch, single fetch");

/* ---------------------------------------------------------------------------
 * 2. 一条助手消息中的多个工具调�? * ------------------------------------------------------------------------- */
section("multiple tool calls");

const multiLlm = new ScriptedLLM([
    assistant("", undefined, usage(), [toolCall("c1", { path: "a" }), toolCall("c2", { path: "b" })], ChatStopReason.ToolCall),
    assistant("both", undefined, usage(), undefined, ChatStopReason.Stop),
]);
const multi = trackedSession(multiLlm);
const multiRun = await multi.session.run("read both", { tools: registry });

assert.equal(multiRun.status, RunStatus.Completed);
assert.equal(multi.history.messages.length, 5, "user / assistant / tool / tool / assistant");

const firstTool = multi.history.messages[2] as ToolMessage;
const secondTool = multi.history.messages[3] as ToolMessage;
assert.equal(firstTool.callId, "c1");
assert.equal(secondTool.callId, "c2");
assert.equal(textOf(firstTool.content), "content:a");
assert.equal(textOf(secondTool.content), "content:b");

const multiEvents = multi.events.map((event) => event.type);
assert.equal(multiEvents.filter((type) => type === SessionEventType.TOOL_CALL_START).length, 2);
assert.equal(multiEvents.filter((type) => type === SessionEventType.TOOL_CALL_END).length, 2);
console.log("PASS two calls executed in order and each produced a ToolMessage");

/* ---------------------------------------------------------------------------
 * 3. 工具错误作为结果回灌模型，循环继�? * ------------------------------------------------------------------------- */
section("工具错误回灌");

const failingRegistry = new ToolRegistry();
failingRegistry.registerProvider(fakeProvider("filesystem", {
    tools: [readTool],
    onCall: () => {
        throw new ToolError(ToolErrorType.NetworkError, true, "socket reset");
    },
}));

const recoveredLlm = new ScriptedLLM([
    assistant("", undefined, usage(), [toolCall("c1")], ChatStopReason.ToolCall),
    assistant("recovered", undefined, usage(), undefined, ChatStopReason.Stop),
]);
const recovered = trackedSession(recoveredLlm);
const recoveredRun = await recovered.session.run("x", { tools: failingRegistry });

assert.equal(recoveredRun.status, RunStatus.Completed);
const failedTool = recovered.history.messages[2] as ToolMessage;
assert.equal(failedTool.isSuccess, false);
assert.equal(failedTool.error?.type, ToolErrorType.NetworkError);
assert.equal(textOf(failedTool.content), "socket reset");
assert.ok(recoveredLlm.requests[1].messages[2] instanceof ToolMessage, "第二轮必须带上失败的工具结果");
console.log("PASS ToolError converted to result; model can retry or give up");

/* ---------------------------------------------------------------------------
 * 4. 步数上限：以已闭合的工具消息收尾，且不吞掉已完成的轮�? * ------------------------------------------------------------------------- */
section("步数上限");

const cappedLlm = new ScriptedLLM([
    assistant("", undefined, usage(), [toolCall("c1")], ChatStopReason.ToolCall),
    assistant("", undefined, usage(), [toolCall("c2")], ChatStopReason.ToolCall),
]);
const capped = trackedSession(cappedLlm);
const cappedRun = await capped.session.run("x", { tools: registry, maxSteps: 1 });

assert.equal(cappedRun.status, RunStatus.Completed);
assert.equal(capped.history.messages.length, 3, "user / assistant / tool");
assert.ok(capped.history.messages[2] instanceof ToolMessage);
assert.equal(cappedLlm.requests.length, 1, "步数用尽后不得再请求模型");
console.log("PASS maxSteps enforced; committed history ends with assistant");

/* ---------------------------------------------------------------------------
 * 5. 没有传入工具集却出现工具调用 -> 运行失败、历史保持干净
 * ------------------------------------------------------------------------- */
section("缺少工具�");

const noToolsLlm = new ScriptedLLM([
    assistant("", undefined, usage(), [toolCall("c1")], ChatStopReason.ToolCall),
]);
const noTools = trackedSession(noToolsLlm);
const noToolsRun = await noTools.session.run("x");

assert.equal(noToolsRun.status, RunStatus.Failed);
assert.equal(noTools.history.messages.length, 0, "失败时不得提交任何消�");
assert.match(errorText(noToolsRun.error), /no tool source/);
assert.equal(noTools.events.some((event) => event.type === SessionEventType.ERROR), true);
console.log("PASS 未传工具集时报错且历史不受污�");

/* ---------------------------------------------------------------------------
 * 6. Provider 不支持工�?-> 在发起请求前失败
 * ------------------------------------------------------------------------- */
section("Provider 不支持工�");

const unsupportedLlm = new ScriptedLLM([], false);
const unsupported = trackedSession(unsupportedLlm);
const unsupportedRun = await unsupported.session.run("x", { tools: registry });

assert.equal(unsupportedRun.status, RunStatus.Failed);
assert.match(errorText(unsupportedRun.error), /does not support tool calls/);
assert.equal(unsupportedLlm.requests.length, 0, "不支持工具时不应发起模型请求");
console.log("PASS supportsTools=false 时快速失�");

/* ---------------------------------------------------------------------------
 * 7. 工具执行中取消：运行取消，pending 全部丢弃
 * ------------------------------------------------------------------------- */
section("取消");

const hangingRegistry = new ToolRegistry();
hangingRegistry.registerProvider(fakeProvider("filesystem", {
    tools: [readTool],
    onCall: () => new Promise<ToolCallResult>(() => { /* 永不返回 */ }),
}));

const cancelLlm = new ScriptedLLM([
    assistant("", undefined, usage(), [toolCall("c1")], ChatStopReason.ToolCall),
    assistant("never", undefined, usage(), undefined, ChatStopReason.Stop),
]);
const cancelling = trackedSession(cancelLlm);
let cancelled = false;
cancelling.session.subscribe((event) => {
    if (event.type === SessionEventType.TOOL_CALL_START && !cancelled) {
        cancelled = true;
        cancelling.session.cancel();
    }
});

const cancelledRun = await cancelling.session.run("x", { tools: hangingRegistry });

assert.equal(cancelledRun.status, RunStatus.Canceled);
assert.equal(cancelling.history.messages.length, 0, "取消后不得提�");
assert.equal(cancelLlm.requests.length, 1);
assert.equal(cancelLlm.requests.length, 1);
assert.equal(cancelling.events.some((event) => event.type === SessionEventType.USER_ABORT), true);
console.log("PASS 工具执行中取消、pending 丢弃、事件正�");

/* ---------------------------------------------------------------------------
 * 8. maxSteps 参数校验
 * ------------------------------------------------------------------------- */
section("参数校验");

await assert.rejects(
    () => new Session(new ScriptedLLM([]), new SessionHistory(), {}).run("x", { maxSteps: 0 }),
    /maxSteps/,
);
await assert.rejects(
    () => new Session(new ScriptedLLM([]), new SessionHistory(), {}).run("x", { maxSteps: 1.5 }),
    /maxSteps/,
);
console.log("PASS 非法 maxSteps 被拒�");

/* ---------------------------------------------------------------------------
 * 9. 平台层：工具定义 -> OpenAI 兼容 payload，以及能力声�? * ------------------------------------------------------------------------- */
section("Ollama 工具 payload");

const adapter = new OllamaProtocolAdapter();
const advertised = await registry.listTools();
assert.deepEqual(adapter.toolDefinitionsToPayload(advertised), [{
    type: "function",
    function: {
        name: "filesystem__readFile",
        description: "read a file",
        parameters: readTool.inputSchema,
    },
}]);
assert.equal(new OllamaProvider().supportsTools, true);
console.log("PASS 工具定义�?OpenAI 兼容格式序列�");

console.log("\nAll agent loop checks passed.");
