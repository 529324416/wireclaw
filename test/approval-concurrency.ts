import assert from "node:assert/strict";

import { ToolErrorType } from "../src/session/error";
import { AssistantMessage, ToolMessage, assistant } from "../src/session/message";
import { AIProvider, ProtocolAdapter } from "../src/session/protocol";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { ToolRegistry } from "../src/session/tool";
import { ChatStopReason, SessionEventType, SessionState } from "../src/session/type";
import type { SessionEvent } from "../src/session/type";
import type { ChatOptions, ChatResult, ChatUsage, MessageContent, SessionRuntimeOptions, StreamChunk, ToolCall, ToolCallResult, ToolDefinition } from "../src/session/type";
import type { ToolCallOptions, ToolProvider } from "../src/session/tool";
import type { Message } from "../src/session/message";

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

class ScriptedLLM extends AIProvider {
    readonly requests: Array<{ messages: readonly Message[] }> = [];

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
        messages: readonly Message[],
        _options: SessionRuntimeOptions,
        turn?: ChatOptions,
    ): Promise<ChatResult> {
        this.requests.push({ messages: [...messages] });
        const next = this._script.shift();
        if (next === undefined) throw new Error("script exhausted");
        turn?.onToken?.(next.content, false);
        return { message: next };
    }
}

const writeTool: ToolDefinition = {
    name: "writeFile",
    description: "write a file",
    inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
    },
    annotations: { requiresApproval: true, concurrencySafe: false },
};

const readTool: ToolDefinition = {
    name: "readFile",
    description: "read a file",
    inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
    },
    annotations: { readOnlyHint: true, concurrencySafe: true },
};

const unsafeTool: ToolDefinition = {
    name: "unsafe",
    description: "tool without concurrency declaration",
    inputSchema: { type: "object" },
};

type FakeOptions = {
    tools?: ToolDefinition[];
    onCall?: (call: ToolCall, options?: ToolCallOptions) => Promise<ToolCallResult> | ToolCallResult;
};

function fakeProvider(id: string, options: FakeOptions = {}): ToolProvider {
    return {
        id,
        name: id,
        description: id,
        async fetchTools() {
            return options.tools ?? [];
        },
        async call(call, callOptions) {
            if (options.onCall !== undefined) return await options.onCall(call, callOptions);
            return ok(`ok:${call.name}`);
        },
    };
}

function usage(): ChatUsage {
    return { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
}

function ok(content: string): ToolCallResult {
    return { content, status: { isSuccess: true, duration: 0 } };
}

function call(id: string, name: string, path = "a"): ToolCall {
    return { id, name, params: { path } };
}

function textOf(content: MessageContent): string {
    if (typeof content === "string") return content;
    return content.map((part) => part.type === "text" ? part.text : "").join("");
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

type Tracked = { session: Session; history: SessionHistory; events: SessionEvent[] };

function tracked(llm: ScriptedLLM): Tracked {
    const history = new SessionHistory();
    const session = new Session(llm, history, {});
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    return { session, history, events };
}

function section(title: string): void {
    console.log(`\n=== ${title} ===`);
}

function writeRegistry(onCall?: FakeOptions["onCall"]): ToolRegistry {
    const registry = new ToolRegistry();
    registry.registerProvider(fakeProvider("filesystem", { tools: [writeTool], onCall }));
    return registry;
}

function twoTurnScript(toolCalls: ToolCall[], finalText = "done"): AssistantMessage[] {
    return [
        assistant("", undefined, usage(), toolCalls, ChatStopReason.ToolCall),
        assistant(finalText, undefined, usage(), undefined, ChatStopReason.Stop),
    ];
}

/* ---------------------------------------------------------------------------
 * 1. 审批通过：暂�?-> resume(approve) -> 继续执行
 * ------------------------------------------------------------------------- */
section("审批通过");

let writeInvoked = 0;
const approveRegistry = writeRegistry(() => {
    writeInvoked += 1;
    return ok("written");
});
const approveLlm = new ScriptedLLM(twoTurnScript([call("c1", "filesystem__writeFile")]));
const approve = tracked(approveLlm);

let approvalSeen = false;
approve.session.subscribe((event) => {
    if (event.type !== SessionEventType.TOOL_APPROVAL_REQUIRED) return;

    approvalSeen = true;
    assert.equal(approve.session.state, SessionState.Pause);
    assert.equal(approve.session.isBusy, true);
    assert.equal(approve.session.pendingApproval?.call.id, "c1");
    assert.equal(approve.session.pendingApproval?.tool?.name, "filesystem__writeFile");
    assert.equal(approve.session.pendingApproval?.tool?.annotations?.requiresApproval, true);
    assert.equal(approve.session.resume("approve"), true);
    assert.equal(approve.session.state, SessionState.Run);
});

const approveRun = await approve.session.run("write", { tools: approveRegistry });

assert.equal(approvalSeen, true);
assert.equal(approveRun.status, RunStatus.Completed);
assert.equal(writeInvoked, 1);
assert.equal(approve.history.messages.length, 4);
const approvedTool = approve.history.messages[2] as ToolMessage;
assert.equal(approvedTool.isSuccess, true);
assert.equal(textOf(approvedTool.content), "written");

const approveEvents = approve.events.map((event) => event.type);
assert.equal(approveEvents.indexOf(SessionEventType.TOOL_CALL_START) < approveEvents.indexOf(SessionEventType.TOOL_APPROVAL_REQUIRED), true);
assert.equal(approveEvents.indexOf(SessionEventType.TOOL_APPROVAL_REQUIRED) < approveEvents.indexOf(SessionEventType.TOOL_CALL_END), true);
console.log("PASS paused state, pendingApproval, resume after approve");

/* ---------------------------------------------------------------------------
 * 2. 暂停期间 run() 不结束，resume 后才落地
 * ------------------------------------------------------------------------- */
section("pause keeps run alive");

const pauseLlm = new ScriptedLLM(twoTurnScript([call("c1", "filesystem__writeFile")]));
const paused = tracked(pauseLlm);

let pausedApprovalSeen = false;
paused.session.subscribe((event) => {
    if (event.type === SessionEventType.TOOL_APPROVAL_REQUIRED) pausedApprovalSeen = true;
});

let settled = false;
const pendingRun = paused.session.run("write", { tools: writeRegistry() }).then((run) => {
    settled = true;
    return run;
});

await sleep(20);

assert.equal(pausedApprovalSeen, true);
assert.equal(settled, false, "暂停期间 run() 不得提前结束");
assert.equal(paused.session.isBusy, true);
assert.equal(paused.session.state, SessionState.Pause);
assert.equal(paused.session.activeRun?.status, RunStatus.Paused);
assert.equal(paused.session.pendingApproval?.call.id, "c1");

assert.equal(paused.session.resume("approve"), true);
const resumedRun = await pendingRun;
assert.equal(resumedRun.status, RunStatus.Completed);
assert.equal(settled, true);
console.log("PASS 暂停期间保持 busy，resume 后完成并提交");

/* ---------------------------------------------------------------------------
 * 3. 审批拒绝：不执行工具，拒绝作为结果回灌模�? * ------------------------------------------------------------------------- */
section("审批拒绝");

let deniedInvoked = 0;
const denyRegistry = writeRegistry(() => {
    deniedInvoked += 1;
    return ok("should not run");
});
const denyLlm = new ScriptedLLM(twoTurnScript([call("c1", "filesystem__writeFile")], "recovered"));
const denied = tracked(denyLlm);

denied.session.subscribe((event) => {
    if (event.type === SessionEventType.TOOL_APPROVAL_REQUIRED) {
        assert.equal(denied.session.resume("deny"), true);
    }
});

const deniedRun = await denied.session.run("write", { tools: denyRegistry });

assert.equal(deniedInvoked, 0, "拒绝后不得执行工�");
assert.equal(deniedRun.status, RunStatus.Completed);
const deniedTool = denied.history.messages[2] as ToolMessage;
assert.equal(deniedTool.isSuccess, false);
assert.equal(deniedTool.error?.type, ToolErrorType.Denied);
assert.match(textOf(deniedTool.content), /denied/);
assert.ok(denyLlm.requests[1].messages[2] instanceof ToolMessage, "拒绝结果必须回灌模型");
console.log("PASS 拒绝不执行、Denied 结果回灌、循环继�");

/* ---------------------------------------------------------------------------
 * 4. 暂停期间取消
 * ------------------------------------------------------------------------- */
section("暂停期间取消");

const cancelLlm = new ScriptedLLM(twoTurnScript([call("c1", "filesystem__writeFile")]));
const cancelling = tracked(cancelLlm);

cancelling.session.subscribe((event) => {
    if (event.type === SessionEventType.TOOL_APPROVAL_REQUIRED) cancelling.session.cancel();
});

const cancelledRun = await cancelling.session.run("write", { tools: writeRegistry() });

assert.equal(cancelledRun.status, RunStatus.Canceled);
assert.equal(cancelling.history.messages.length, 0, "取消后不得提�");
assert.equal(cancelling.session.pendingApproval, null);
assert.equal(cancelling.session.isBusy, false);
assert.equal(cancelling.events.some((event) => event.type === SessionEventType.USER_ABORT), true);
console.log("PASS 暂停时取消、pendingApproval 清空、历史不污染");

/* ---------------------------------------------------------------------------
 * 5. 无待审批�?resume 返回 false
 * ------------------------------------------------------------------------- */
section("resume 边界");

const idle = new Session(new ScriptedLLM([]), new SessionHistory(), {});
assert.equal(idle.resume("approve"), false);
assert.equal(idle.resume("maybe" as never), false);
console.log("PASS �?pending / 非法决定�?resume 返回 false");

/* ---------------------------------------------------------------------------
 * 6. 并发安全工具并行执行，且结果按调用顺序物�? * ------------------------------------------------------------------------- */
section("并发执行");

let active = 0;
let maxActive = 0;
const parallelRegistry = new ToolRegistry();
parallelRegistry.registerProvider(fakeProvider("fs", {
    tools: [readTool],
    onCall: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(30);
        active -= 1;
        return ok("read");
    },
}));

const parallelLlm = new ScriptedLLM(twoTurnScript([
    call("c1", "fs__readFile", "a"),
    call("c2", "fs__readFile", "b"),
]));
const parallel = tracked(parallelLlm);
const parallelRun = await parallel.session.run("x", {
    tools: parallelRegistry,
    toolConcurrency: 2,
});

assert.equal(parallelRun.status, RunStatus.Completed);
assert.equal(maxActive, 2, "并发安全工具应同时执�");
const parallelMessages = parallel.history.messages;
assert.equal((parallelMessages[2] as ToolMessage).callId, "c1");
assert.equal((parallelMessages[3] as ToolMessage).callId, "c2");
console.log("PASS 同一批并发安全工具并行，历史顺序稳定");

/* ---------------------------------------------------------------------------
 * 7. 未声明并发安全的工具强制顺序执行
 * ------------------------------------------------------------------------- */
section("默认串行");

let serialMax = 0;
let serialActive = 0;
const serialRegistry = new ToolRegistry();
serialRegistry.registerProvider(fakeProvider("fs", {
    tools: [unsafeTool],
    onCall: async () => {
        serialActive += 1;
        serialMax = Math.max(serialMax, serialActive);
        await sleep(20);
        serialActive -= 1;
        return ok("x");
    },
}));

const serialLlm = new ScriptedLLM(twoTurnScript([
    call("c1", "fs__unsafe", "a"),
    call("c2", "fs__unsafe", "b"),
]));
const serial = tracked(serialLlm);
await serial.session.run("x", { tools: serialRegistry, toolConcurrency: 3 });
assert.equal(serialMax, 1, "未声�?concurrencySafe 时必须串�");
console.log("PASS 未声明并发安全的工具串行执行");

/* ---------------------------------------------------------------------------
 * 8. 并发上限生效
 * ------------------------------------------------------------------------- */
section("并发上限");

let limitActive = 0;
let limitMax = 0;
const limitRegistry = new ToolRegistry();
limitRegistry.registerProvider(fakeProvider("fs", {
    tools: [readTool],
    onCall: async () => {
        limitActive += 1;
        limitMax = Math.max(limitMax, limitActive);
        await sleep(20);
        limitActive -= 1;
        return ok("x");
    },
}));

const limitLlm = new ScriptedLLM(twoTurnScript([
    call("c1", "fs__readFile", "a"),
    call("c2", "fs__readFile", "b"),
    call("c3", "fs__readFile", "c"),
    call("c4", "fs__readFile", "d"),
]));
const limited = tracked(limitLlm);
await limited.session.run("x", { tools: limitRegistry, toolConcurrency: 2 });
assert.equal(limitMax, 2, "并发数不得超�?toolConcurrency");
assert.equal(limited.history.messages.length, 7);
console.log("PASS 并发上限生效且历史完�");

/* ---------------------------------------------------------------------------
 * 9. 含审批的批次退化为顺序执行
 * ------------------------------------------------------------------------- */
section("审批批次串行");

let mixedActive = 0;
let mixedMax = 0;
const mixedRegistry = new ToolRegistry();
mixedRegistry.registerProvider(fakeProvider("filesystem", {
    tools: [writeTool, readTool],
    onCall: async () => {
        mixedActive += 1;
        mixedMax = Math.max(mixedMax, mixedActive);
        await sleep(20);
        mixedActive -= 1;
        return ok("x");
    },
}));

const mixedLlm = new ScriptedLLM(twoTurnScript([
    call("c1", "filesystem__writeFile"),
    call("c2", "filesystem__readFile"),
]));
const mixed = tracked(mixedLlm);
let mixedApprovals = 0;
mixed.session.subscribe((event) => {
    if (event.type === SessionEventType.TOOL_APPROVAL_REQUIRED) {
        mixedApprovals += 1;
        mixed.session.resume("approve");
    }
});

await mixed.session.run("x", { tools: mixedRegistry, toolConcurrency: 2 });
assert.equal(mixedApprovals, 1);
assert.equal(mixedMax, 1, "含审批的批次必须串行");
console.log("PASS 审批批次退化为串行");

/* ---------------------------------------------------------------------------
 * 10. toolConcurrency 参数校验
 * ------------------------------------------------------------------------- */
section("参数校验");

await assert.rejects(
    () => new Session(new ScriptedLLM([]), new SessionHistory(), {}).run("x", { toolConcurrency: 0 }),
    /toolConcurrency/,
);
await assert.rejects(
    () => new Session(new ScriptedLLM([]), new SessionHistory(), {}).run("x", { toolConcurrency: 1.5 }),
    /toolConcurrency/,
);
console.log("PASS 非法 toolConcurrency 被拒�");

console.log("\nAll approval/concurrency checks passed.");
