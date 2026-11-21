import assert from "node:assert/strict";
import { mkdtemp, readFile as readFsFile, rm, writeFile as writeFsFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalToolProvider } from "../src/client";
import { ToolErrorType } from "../src/session/error";
import { assistant } from "../src/session/message";
import { AIProvider, ProtocolAdapter } from "../src/session/protocol";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { ToolRegistry } from "../src/session/tool";
import { ChatStopReason, SessionEventType, SessionPermission } from "../src/session/type";
import type { SessionEvent } from "../src/session/type";
import type { AssistantMessage, Message } from "../src/session/message";
import type { ChatOptions, ChatResult, ChatUsage, SessionRuntimeOptions, StreamChunk, ToolCall } from "../src/session/type";

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

function usage(): ChatUsage {
    return { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
}

function toolCall(name: string, params: Record<string, unknown>): ToolCall {
    return { id: `call-${name}`, name, params };
}

/** 构造两轮脚本：先调工具，再正常结束 */
function scriptWithTool(call: ToolCall, finalText = "done"): AssistantMessage[] {
    return [
        assistant("", undefined, usage(), [call], ChatStopReason.ToolCall),
        assistant(finalText, undefined, usage(), undefined, ChatStopReason.Stop),
    ];
}

function section(title: string): void {
    console.log(`\n=== ${title} ===`);
}

/* ---------------------------------------------------------------------------
 * 测试主体
 * ------------------------------------------------------------------------- */
const root = await mkdtemp(join(tmpdir(), "wireclaw-permission-"));

try {
    await writeFsFile(join(root, "note.txt"), "hello", "utf8");

    const makeRegistry = (): ToolRegistry => {
        const registry = new ToolRegistry();
        registry.registerProvider(new LocalToolProvider(root, { id: "local" }));
        return registry;
    };

    /* -----------------------------------------------------------------------
     * 1. readonly：只读工具正常执�?     * --------------------------------------------------------------------- */
    section("readonly 允许只读");

    {
        const registry = makeRegistry();
        const session = new Session(
            new ScriptedLLM(scriptWithTool(toolCall("local__readFile", { path: "note.txt" }))),
            new SessionHistory(),
            {},
        );
        let approvals = 0;
        session.subscribe((event) => {
            if (event.type === SessionEventType.TOOL_APPROVAL_REQUIRED) approvals += 1;
        });

        const run = await session.run("read", {
            tools: registry,
            permission: SessionPermission.ReadOnly,
        });

        assert.equal(run.status, RunStatus.Completed);
        assert.equal(approvals, 0);
        const toolMessage = session.history?.messages[2] as { isSuccess?: boolean };
        assert.equal(toolMessage.isSuccess, true);
        console.log("PASS readonly �?readFile 直接放行");
    }

    /* -----------------------------------------------------------------------
     * 2. readonly：写工具直接拒绝，不进入审批
     * --------------------------------------------------------------------- */
    section("readonly 拒绝写入");

    {
        const registry = makeRegistry();
        const session = new Session(
            new ScriptedLLM(scriptWithTool(toolCall("local__writeFile", {
                path: "readonly.txt",
                content: "nope",
            }), "recovered")),
            new SessionHistory(),
            {},
        );
        let approvals = 0;
        session.subscribe((event) => {
            if (event.type === SessionEventType.TOOL_APPROVAL_REQUIRED) approvals += 1;
        });

        const run = await session.run("write", {
            tools: registry,
            permission: SessionPermission.ReadOnly,
        });

assert.equal(run.status, RunStatus.Completed, "Denial should be fed back as a tool result, not abort the run");
        assert.equal(approvals, 0, "readonly 不应乞求审批");
        assert.equal(await exists(join(root, "readonly.txt")), false);

        const toolMessage = session.history?.messages[2] as {
            isSuccess?: boolean;
            error?: { type?: string };
            content?: unknown;
        };
        assert.equal(toolMessage.isSuccess, false);
        assert.equal(toolMessage.error?.type, ToolErrorType.Denied);
        assert.match(String(toolMessage.content), /permission is "readonly"/);
        console.log("PASS readonly rejects writeFile and file is not created");
    }

    /* -----------------------------------------------------------------------
     * 3. readonly：未声明的工具同样拒�?     * --------------------------------------------------------------------- */
    section("readonly 拒绝未知工具");

    {
        const registry = makeRegistry();
        const session = new Session(
            new ScriptedLLM(scriptWithTool(toolCall("local__doesNotExist", {}), "recovered")),
            new SessionHistory(),
            {},
        );

        const run = await session.run("unknown", {
            tools: registry,
            permission: SessionPermission.ReadOnly,
        });

        assert.equal(run.status, RunStatus.Completed);
        const toolMessage = session.history?.messages[2] as { error?: { type?: string } };
        assert.equal(toolMessage.error?.type, ToolErrorType.Denied);
        console.log("PASS readonly 下未声明只读的工具一律拒�");
    }

    /* -----------------------------------------------------------------------
     * 4. approval（默认）：写工具需要审�?     * --------------------------------------------------------------------- */
    section("approval 审批");

    {
        const registry = makeRegistry();
        const session = new Session(
            new ScriptedLLM(scriptWithTool(toolCall("local__writeFile", {
                path: "approval.txt",
                content: "approved",
            }))),
            new SessionHistory(),
            {},
        );
        let approvals = 0;
        session.subscribe((event) => {
            if (event.type !== SessionEventType.TOOL_APPROVAL_REQUIRED) return;
            approvals += 1;
            session.resume("approve");
        });

        const run = await session.run("write", { tools: registry });

        assert.equal(run.status, RunStatus.Completed);
        assert.equal(approvals, 1);
        assert.equal(await readFsFile(join(root, "approval.txt"), "utf8"), "approved");
        console.log("PASS 默认 approval：写入需要审批且审批后生�");
    }

    /* -----------------------------------------------------------------------
     * 5. full：写工具直接放行，但发出危险警告
     * --------------------------------------------------------------------- */
    section("full 放行 + 警告");

    {
        const registry = makeRegistry();
        const session = new Session(
            new ScriptedLLM(scriptWithTool(toolCall("local__writeFile", {
                path: "full.txt",
                content: "auto",
            }))),
            new SessionHistory(),
            {},
        );

        const events: SessionEvent[] = [];
        let approvals = 0;
        session.subscribe((event) => {
            events.push(event);
            if (event.type === SessionEventType.TOOL_APPROVAL_REQUIRED) approvals += 1;
        });

        const run = await session.run("write", {
            tools: registry,
            permission: SessionPermission.Full,
        });

        assert.equal(run.status, RunStatus.Completed);
        assert.equal(approvals, 0, "full 模式不应暂停等待审批");
        assert.equal(await readFsFile(join(root, "full.txt"), "utf8"), "auto");

        const warning = events.find((event) => event.type === SessionEventType.TOOL_PERMISSION_WARNING);
        assert.ok(warning !== undefined && warning.type === SessionEventType.TOOL_PERMISSION_WARNING);
        assert.match(warning.message, /full permission mode/);
        assert.equal(warning.tool?.name, "local__writeFile");
        console.log("PASS full 模式直接执行并发�?TOOL_PERMISSION_WARNING");
    }

    /* -----------------------------------------------------------------------
     * 6. full：只读工具不产生警告
     * --------------------------------------------------------------------- */
    section("full 只读无警�");

    {
        const registry = makeRegistry();
        const session = new Session(
            new ScriptedLLM(scriptWithTool(toolCall("local__readFile", { path: "note.txt" }))),
            new SessionHistory(),
            {},
        );
        let warnings = 0;
        session.subscribe((event) => {
            if (event.type === SessionEventType.TOOL_PERMISSION_WARNING) warnings += 1;
        });

        const run = await session.run("read", {
            tools: registry,
            permission: SessionPermission.Full,
        });

        assert.equal(run.status, RunStatus.Completed);
        assert.equal(warnings, 0, "只读工具不应产生危险警告");
        console.log("PASS full 下只读工具无警告");
    }

    /* -----------------------------------------------------------------------
     * 7. 非法权限�?     * --------------------------------------------------------------------- */
    section("参数校验");

    {
        const session = new Session(new ScriptedLLM([]), new SessionHistory(), {});
        await assert.rejects(
            () => session.run("x", { permission: "admin" as never }),
            /permission/,
        );
    }

    assert.equal(SessionPermission.ReadOnly, "readonly");
    assert.equal(SessionPermission.Approval, "approval");
    assert.equal(SessionPermission.Full, "full");
    console.log("PASS 非法权限值被拒绝，常量取值正�");

    console.log("\nAll permission checks passed.");
} finally {
    await rm(root, { recursive: true, force: true });
}

/* ---------------------------------------------------------------------------
 * 小工�? * ------------------------------------------------------------------------- */

async function exists(path: string): Promise<boolean> {
    try {
        await readFsFile(path);
        return true;
    } catch {
        return false;
    }
}
