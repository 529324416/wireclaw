import assert from "node:assert/strict";

import { ToolErrorType } from "../src/session/error";
import {
    formatUserInputResult,
    parseUserInputRequest,
    validateUserInputResult,
} from "../src/session/host-tool";
import { assistant, ToolMessage } from "../src/session/message";
import { AIProvider, ProtocolAdapter } from "../src/session/protocol";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { ChatStopReason, SessionEventType, SessionState } from "../src/session/type";
import type { AssistantMessage, Message } from "../src/session/message";
import type { ChatOptions, ChatResult, ChatUsage, SessionEvent, SessionRuntimeOptions, StreamChunk, ToolCall, ToolCallResult, ToolDefinition } from "../src/session/type";

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
    readonly requests: Array<{ tools?: ToolDefinition[] }> = [];

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
        this.requests.push({ tools: turn?.tools });
        const next = this._script.shift();
        if (next === undefined) throw new Error("script exhausted");
        turn?.onToken?.(next.content, false);
        return { message: next };
    }
}

const askCall: ToolCall = {
    id: "call-ask-1",
    name: "host__ask_user",
    params: {
        title: "项目配置",
        questions: [
            {
                id: "db",
                header: "Data",
                question: "Choose data",
                options: [
                    { id: "pg", label: "PostgreSQL" },
                    { id: "sqlite", label: "SQLite" },
                ],
            },
            {
                id: "features",
                header: "功能",
                question: "选择需要启用的功能",
                multiSelect: true,
                options: [
                    { id: "auth", label: "Auth" },
                    { id: "logging", label: "Logging" },
                    { id: "cache", label: "Cache" },
                ],
            },
        ],
    },
};

/* ---------------------------------------------------------------------------
 * 1. 正常问答
 * ------------------------------------------------------------------------- */
section("正常问答");

{
    const llm = new ScriptedLLM([
        assistant("", undefined, usage(), [askCall], ChatStopReason.ToolCall),
        assistant("done", undefined, usage(), undefined, ChatStopReason.Stop),
    ]);
    const session = new Session(llm, new SessionHistory(), {});

    let seen = false;
    let endResult: ToolCallResult | undefined;
    session.subscribe((event: SessionEvent) => {
        if (event.type === SessionEventType.TOOL_CALL_END) {
            endResult = event.result;
            return;
        }
        if (event.type !== SessionEventType.TOOL_INPUT_REQUIRED) return;

        seen = true;
        assert.equal(session.state, SessionState.Pause);
        assert.equal(session.pendingUserInput?.questions.length, 2);

        const ok = session.respondUserInput({
            requestId: event.request.id,
            answers: [
                { questionId: "db", selected: ["sqlite"] },
                { questionId: "features", selected: ["auth", "cache"] },
            ],
        });
        assert.equal(ok, true);
    });

    const run = await session.run("configure", { toolProgressDelayMs: 0 });

    assert.equal(seen, true);
    assert.equal(run.status, RunStatus.Completed);
    assert.equal(session.history?.messages.length, 4);

    const toolMessage = session.history?.messages[2] as ToolMessage;
    assert.equal(toolMessage.isSuccess, true);
    assert.match(String(toolMessage.content), /SQLite/);
    assert.match(String(toolMessage.content), /Auth, Cache/);

    assert.deepEqual(endResult?.structuredContent, {
        requestId: "call-ask-1",
        answers: [
            { questionId: "db", selected: ["sqlite"] },
            { questionId: "features", selected: ["auth", "cache"] },
        ],
    });

    const advertised = llm.requests[0]?.tools?.map((tool) => tool.name) ?? [];
    assert.ok(advertised.includes("host__ask_user"), `host tool not advertised: ${advertised.join(", ")}`);
    console.log(`PASS host__ask_user 无需注册即可使用，广告工�?${JSON.stringify(advertised)}`);
}

/* ---------------------------------------------------------------------------
 * 2. 非法答案不会恢复运行
 * ------------------------------------------------------------------------- */
section("答案校验");

{
    const llm = new ScriptedLLM([
        assistant("", undefined, usage(), [askCall], ChatStopReason.ToolCall),
        assistant("done", undefined, usage(), undefined, ChatStopReason.Stop),
    ]);
    const session = new Session(llm, new SessionHistory(), {});

    let attempts = 0;
    session.subscribe((event: SessionEvent) => {
        if (event.type !== SessionEventType.TOOL_INPUT_REQUIRED) return;

        const bad = session.respondUserInput({
            requestId: event.request.id,
            answers: [
                { questionId: "db", selected: ["not-an-option"] },
                { questionId: "features", selected: ["auth"] },
            ],
        });
        assert.equal(bad, false);
        assert.notEqual(session.pendingUserInput, null);

        const good = session.respondUserInput({
            requestId: event.request.id,
            answers: [
                { questionId: "db", selected: ["pg"] },
                { questionId: "features", selected: ["logging"] },
            ],
        });
        assert.equal(good, true);
        attempts += 1;
    });

    const run = await session.run("configure");
    assert.equal(run.status, RunStatus.Completed);
    assert.equal(attempts, 1);
    console.log("PASS invalid option rejected, resubmitted successfully");
}

/* ---------------------------------------------------------------------------
 * 3. 非法参数
 * ------------------------------------------------------------------------- */
section("非法参数");

{
    const invalidCall: ToolCall = {
        id: "call-bad",
        name: "host__ask_user",
        params: {
            questions: [{
                id: "q",
                question: "只有一个选项",
                options: [{ id: "only", label: "Only" }],
            }],
        },
    };

    const llm = new ScriptedLLM([
        assistant("", undefined, usage(), [invalidCall], ChatStopReason.ToolCall),
        assistant("recovered", undefined, usage(), undefined, ChatStopReason.Stop),
    ]);
    const session = new Session(llm, new SessionHistory(), {});

    const run = await session.run("x");
    assert.equal(run.status, RunStatus.Completed);

    const toolMessage = session.history?.messages[2] as ToolMessage;
    assert.equal(toolMessage.isSuccess, false);
    assert.equal(toolMessage.error?.type, ToolErrorType.InvalidParams);
    console.log("PASS 非法 ask_user 参数作为工具失败结果回传");
}

/* ---------------------------------------------------------------------------
 * 4. 暂停期间取消
 * ------------------------------------------------------------------------- */
section("取消");

{
    const llm = new ScriptedLLM([
        assistant("", undefined, usage(), [askCall], ChatStopReason.ToolCall),
        assistant("never", undefined, usage(), undefined, ChatStopReason.Stop),
    ]);
    const session = new Session(llm, new SessionHistory(), {});

    session.subscribe((event: SessionEvent) => {
        if (event.type === SessionEventType.TOOL_INPUT_REQUIRED) {
            session.cancel();
        }
    });

    const run = await session.run("configure");
    assert.equal(run.status, RunStatus.Canceled);
    assert.equal(session.history?.messages.length, 0);
    assert.equal(session.pendingUserInput, null);
    console.log("PASS 暂停填写时取消，历史不污�");
}

/* ---------------------------------------------------------------------------
 * 5. 关闭 host 工具
 * ------------------------------------------------------------------------- */
section("enableUserInput=false");

{
    const llm = new ScriptedLLM([
        assistant("", undefined, usage(), [askCall], ChatStopReason.ToolCall),
        assistant("never", undefined, usage(), undefined, ChatStopReason.Stop),
    ]);
    const session = new Session(llm, new SessionHistory(), {});

    const run = await session.run("configure", { enableUserInput: false });
    assert.equal(run.status, RunStatus.Failed);
    assert.equal(session.history?.messages.length, 0);
    assert.equal(llm.requests[0]?.tools, undefined);
    console.log("PASS 关闭后不广告 host 工具，调用失�");
}

/* ---------------------------------------------------------------------------
 * 6. allowOther 的自由输入校验与格式化
 * ------------------------------------------------------------------------- */
section("allowOther");

{
    const call: ToolCall = {
        id: "call-other",
        name: "host__ask_user",
        params: {
            questions: [{
                id: "q",
                question: "选择一个方向，也可以自由输入",
                allowOther: true,
                options: [
                    { id: "a", label: "A" },
                    { id: "b", label: "B" },
                ],
            }],
        },
    };

    const parsed = parseUserInputRequest(call);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error("ask_user parse failed");

    const request = parsed.request;
    const answer = (other: unknown) => ({
        requestId: request.id,
        answers: [{
            questionId: "q",
            selected: [] as string[],
            other: other as string,
        }],
    });

    assert.deepEqual(validateUserInputResult(request, answer("自定义方向")), []);
    assert.match(
        formatUserInputResult(request, answer("自定义方向")),
        /其他: 自定义方向/,
    );

    assert.ok(
        validateUserInputResult(request, answer("   "))
            .some((problem) => /non-empty/.test(problem)),
        "whitespace-only other must be rejected",
    );
    assert.ok(
        validateUserInputResult(request, answer(123))
            .some((problem) => /must be a string/.test(problem)),
        "non-string other must be rejected",
    );

    const noOtherCall: ToolCall = {
        ...call,
        params: {
            questions: [{
                id: "q",
                question: "选择一个方向",
                options: [
                    { id: "a", label: "A" },
                    { id: "b", label: "B" },
                ],
            }],
        },
    };
    const noOtherParsed = parseUserInputRequest(noOtherCall);
    assert.equal(noOtherParsed.ok, true);
    if (!noOtherParsed.ok) throw new Error("ask_user parse failed");
    assert.ok(
        validateUserInputResult(noOtherParsed.request, answer("自定义方向"))
            .some((problem) => /not allowed/.test(problem)),
        "other must be rejected when allowOther is false",
    );

    console.log("PASS allowOther 自由输入校验与格式化");
}

console.log("\nAll user input checks passed.");
