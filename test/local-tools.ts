import assert from "node:assert/strict";
import { access, mkdtemp, readFile as readFsFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { LocalToolProvider } from "../src/client";
import { ToolErrorType } from "../src/session/error";
import { assistant } from "../src/session/message";
import { AIProvider, ProtocolAdapter } from "../src/session/protocol";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { ToolRegistry } from "../src/session/tool";
import { ChatStopReason, SessionEventType } from "../src/session/type";
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

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

function section(title: string): void {
    console.log(`\n=== ${title} ===`);
}

/* ---------------------------------------------------------------------------
 * 测试主体
 * ------------------------------------------------------------------------- */
const root = await mkdtemp(join(tmpdir(), "wireclaw-local-"));

try {
    const provider = new LocalToolProvider(root, { id: "local" });
    const registry = new ToolRegistry();
    registry.registerProvider(provider);

    let sequence = 0;
    const invoke = (
        name: string,
        params: Record<string, unknown>,
        options?: { signal?: AbortSignal },
    ) => registry.invoke({ id: `call-${++sequence}`, name, params }, options);

    /* -----------------------------------------------------------------------
     * 1. 工具定义与能力声�?     * --------------------------------------------------------------------- */
    section("工具定义");

    assert.equal(provider.rootDir, resolve(root));
    const definitions = await registry.listTools();
    assert.deepEqual(definitions.map((item) => item.name), ["local__readFile", "local__writeFile"]);

    const readDefinition = definitions.find((item) => item.name === "local__readFile");
    assert.equal(readDefinition?.annotations?.readOnlyHint, true);
    assert.equal(readDefinition?.annotations?.concurrencySafe, true);
    assert.equal(readDefinition?.annotations?.requiresApproval, undefined);

    const writeDefinition = definitions.find((item) => item.name === "local__writeFile");
    assert.equal(writeDefinition?.annotations?.requiresApproval, true);
    assert.equal(writeDefinition?.annotations?.destructiveHint, true);
    assert.equal(writeDefinition?.annotations?.concurrencySafe, false);
console.log("PASS readFile readonly concurrency; writeFile approval required and not concurrency-safe");

    /* -----------------------------------------------------------------------
     * 2. 写入 -> 读取
     * --------------------------------------------------------------------- */
    section("读写");

    const writeResult = await invoke("local__writeFile", { path: "a.txt", content: "hello 世界" });
    assert.equal(writeResult.status.isSuccess, true);
    assert.match(String(writeResult.content), /Wrote \d+ bytes/);

    const readResult = await invoke("local__readFile", { path: "a.txt" });
    assert.equal(readResult.content, "hello 世界");
    assert.equal((readResult.structuredContent as { bytes: number }).bytes, 12);
    console.log("PASS content can be read back after write");

    /* -----------------------------------------------------------------------
     * 3. 自动创建父目�?     * --------------------------------------------------------------------- */
    section("父目�");

    await invoke("local__writeFile", { path: "nested/dir/b.txt", content: "b" });
    assert.equal(await readFsFile(join(root, "nested", "dir", "b.txt"), "utf8"), "b");
    console.log("PASS 自动创建父目�");

    /* -----------------------------------------------------------------------
     * 4. 文件不存�?     * --------------------------------------------------------------------- */
    section("缺失文件");

    const missing = await invoke("local__readFile", { path: "missing.txt" });
    assert.equal(missing.status.isSuccess, false);
    assert.equal(missing.status.error?.type, ToolErrorType.NotFound);
    console.log("PASS 缺失文件返回 NotFound");

    /* -----------------------------------------------------------------------
     * 5. 越界访问
     * --------------------------------------------------------------------- */
    section("越界防护");

    const escapeName = `wireclaw-escape-${Date.now()}.txt`;
    const escapeRead = await invoke("local__readFile", { path: `../${escapeName}` });
    assert.equal(escapeRead.status.error?.type, ToolErrorType.Denied);

    const escapeWrite = await invoke("local__writeFile", {
        path: `../${escapeName}`,
        content: "escape",
    });
    assert.equal(escapeWrite.status.error?.type, ToolErrorType.Denied);
    assert.equal(await exists(join(root, "..", escapeName)), false);

    const outsidePath = join(tmpdir(), `wireclaw-outside-${Date.now()}.txt`);
    const absolute = await invoke("local__readFile", { path: outsidePath });
    assert.equal(absolute.status.error?.type, ToolErrorType.Denied);
    console.log("PASS `..` 与绝对路径越界均被拒�");

    /* -----------------------------------------------------------------------
     * 6. 语义参数校验与取�?     * --------------------------------------------------------------------- */
    section("参数与取�");

    const empty = await invoke("local__readFile", { path: "" });
    assert.equal(empty.status.error?.type, ToolErrorType.InvalidParams);

    const abortedController = new AbortController();
    abortedController.abort();
    const aborted = await invoke(
        "local__readFile",
        { path: "a.txt" },
        { signal: abortedController.signal },
    );
    assert.equal(aborted.status.error?.type, ToolErrorType.AbortError);
    console.log("PASS 空路�?InvalidParams / 预取�?AbortError");

    /* -----------------------------------------------------------------------
     * 7. 读取截断
     * --------------------------------------------------------------------- */
    section("截断");

    const smallRegistry = new ToolRegistry();
    smallRegistry.registerProvider(new LocalToolProvider(root, { id: "small", maxReadBytes: 5 }));
    await smallRegistry.invoke({
        id: "small-write",
        name: "small__writeFile",
        params: { path: "big.txt", content: "0123456789" },
    });
    const truncated = await smallRegistry.invoke({
        id: "small-read",
        name: "small__readFile",
        params: { path: "big.txt" },
    });

    assert.equal(String(truncated.content).startsWith("01234"), true);
    assert.match(String(truncated.content), /truncated: 5 bytes omitted/);
    assert.equal((truncated.structuredContent as { truncated: boolean }).truncated, true);
    console.log("PASS 超过 maxReadBytes 时截断并标记");

    /* -----------------------------------------------------------------------
     * 8. Session 端到端：审批通过后写�?     * --------------------------------------------------------------------- */
    section("Session 审批写入");

    const sessionRegistry = new ToolRegistry();
    sessionRegistry.registerProvider(new LocalToolProvider(root, { id: "local" }));

    const sessionLlm = new ScriptedLLM([
        assistant("", undefined, usage(), [
            {
                id: "c1",
                name: "local__writeFile",
                params: { path: "session/approved.txt", content: "from session" },
            } satisfies ToolCall,
        ], ChatStopReason.ToolCall),
        assistant("done", undefined, usage(), undefined, ChatStopReason.Stop),
    ]);
    const session = new Session(sessionLlm, new SessionHistory(), {});
    let approvals = 0;
    session.subscribe((event) => {
        if (event.type !== SessionEventType.TOOL_APPROVAL_REQUIRED) return;
        approvals += 1;
        assert.equal(event.tool?.name, "local__writeFile");
        assert.equal(session.resume("approve"), true);
    });

    const sessionRun = await session.run("write it", { tools: sessionRegistry });
    assert.equal(sessionRun.status, RunStatus.Completed);
    assert.equal(approvals, 1);
    assert.equal(await readFsFile(join(root, "session", "approved.txt"), "utf8"), "from session");
    console.log("PASS 审批通过后本地写入生�");

    /* -----------------------------------------------------------------------
     * 9. Session 端到端：审批拒绝后不写入
     * --------------------------------------------------------------------- */
    section("Session 审批拒绝");

    const denyLlm = new ScriptedLLM([
        assistant("", undefined, usage(), [
            {
                id: "c1",
                name: "local__writeFile",
                params: { path: "session/denied.txt", content: "nope" },
            } satisfies ToolCall,
        ], ChatStopReason.ToolCall),
        assistant("recovered", undefined, usage(), undefined, ChatStopReason.Stop),
    ]);
    const denySession = new Session(denyLlm, new SessionHistory(), {});
    denySession.subscribe((event) => {
        if (event.type === SessionEventType.TOOL_APPROVAL_REQUIRED) denySession.resume("deny");
    });

    const denyRun = await denySession.run("write it", { tools: sessionRegistry });
    assert.equal(denyRun.status, RunStatus.Completed);
    assert.equal(await exists(join(root, "session", "denied.txt")), false);
    console.log("PASS 审批拒绝后文件未创建");

    /* -----------------------------------------------------------------------
     * 10. 构造参数校�?     * --------------------------------------------------------------------- */
    section("构造参�");

    assert.throws(() => new LocalToolProvider(""), /non-empty root directory/);
    assert.throws(() => new LocalToolProvider(root, { maxReadBytes: 0 }), /maxReadBytes/);
    console.log("PASS 非法 rootDir / maxReadBytes 被拒�");

    console.log("\nAll local tool checks passed.");
} finally {
    await rm(root, { recursive: true, force: true });
}
