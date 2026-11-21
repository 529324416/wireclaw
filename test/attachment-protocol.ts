import assert from "node:assert/strict";

import { AttachmentFile } from "../src/session/attachment";
import { AttachmentFileManager } from "../src/session/attachment-manager";
import { MemoryFileHost } from "../src/file/memory";
import { assistant, UserMessage } from "../src/session/message";
import type { AssistantMessage, Message } from "../src/session/message";
import { CloudFileManager, AIProvider, ProtocolAdapter } from "../src/session/protocol";
import { SessionSerializer } from "../src/session/serialize";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { ChatStopReason } from "../src/session/type";
import type {
    AttachmentWireMap,
    ChatOptions,
    ChatResult,
    RemoteFileRef,
    SessionRuntimeOptions,
    StreamChunk,
} from "../src/session/type";

/** 假云文件管理器：记录 ensureFile 调用，返�?inline 表示 */
class FakeCloudFileManager extends CloudFileManager {
    readonly calls: AttachmentFile[] = [];

    async ensureFile(file: AttachmentFile): Promise<RemoteFileRef> {
        this.calls.push(file);
        return {
            kind: "inline",
            data: file.content,
            name: file.name,
            mimeType: file.mimeType,
        };
    }
}

/** 捕获 Session 传给 Adapter 的附件映�?*/
class CapturingAdapter extends ProtocolAdapter {
    lastAttachmentRefs: AttachmentWireMap | undefined;

    toAssistantMessage(_payload: unknown): AssistantMessage {
        throw new Error("not used");
    }

    toPayload(msg: Message, attachmentRefs?: AttachmentWireMap): unknown {
        this.lastAttachmentRefs = attachmentRefs;
        return { role: msg.role, content: msg.content };
    }

    parseStreamChunk(_raw: unknown): StreamChunk[] {
        return [];
    }
}

class FakeLLM extends AIProvider {
    readonly adapter = new CapturingAdapter();
    lastOptions: ChatOptions | undefined;
    lastMessages: readonly Message[] | undefined;

    constructor(private readonly _cloudFileManager: CloudFileManager | null) {
        super();
    }

    override get modelProvider(): null {
        return null;
    }

    get protocolAdapter(): ProtocolAdapter {
        return this.adapter;
    }

    get title(): string {
        return "fake";
    }

    override get supportsTools(): boolean {
        return false;
    }

    override get cloudFileManager(): CloudFileManager | null {
        return this._cloudFileManager;
    }

    async chat(
        messages: readonly Message[],
        _options: SessionRuntimeOptions,
        turn?: ChatOptions,
    ): Promise<ChatResult> {
        this.lastMessages = messages;
        this.lastOptions = turn;
        this.adapter.toPayloads([...messages], turn?.attachmentRefs);
        return { message: assistant("ok", undefined, undefined, undefined, ChatStopReason.Stop) };
    }
}

/* ---------------------------------------------------------------------------
 * 1. Session 解析附件并把 map 透传�?ChatOptions / Adapter
 * ------------------------------------------------------------------------- */
{
    const host = new MemoryFileHost();
    const attachmentManager = new AttachmentFileManager(host);
    const file = await attachmentManager.put(
        "note.txt",
        new TextEncoder().encode("hello"),
        "text/plain",
    );
    const cloudManager = new FakeCloudFileManager();
    const llm = new FakeLLM(cloudManager);
    const history = new SessionHistory();
    const session = new Session(llm, history, {}, attachmentManager);

    const content = [
        { type: "text" as const, text: "read this" },
        { type: "attachment" as const, attachment: { contentHash: file.contentHash } },
    ];

    const run = await session.run(content);

    assert.equal(run.status, RunStatus.Completed);
    assert.equal(cloudManager.calls.length, 1);
    assert.equal(cloudManager.calls[0]?.contentHash, file.contentHash);

    const ref = llm.lastOptions?.attachmentRefs?.get(file.contentHash);
    assert.equal(ref?.kind, "inline");
    assert.equal(ref?.mimeType, "text/plain");

    const adapterRef = llm.adapter.lastAttachmentRefs?.get(file.contentHash);
    assert.equal(adapterRef?.kind, "inline");

    const sessionRef = session.attachmentRefs.get(file.contentHash);
assert.equal(sessionRef?.kind, "inline", "Session should hold this round's attachment map");

    const committed = history.messages[0]?.content;
    assert.deepEqual(committed, content, "History must keep contentHash, not a remote reference");
    console.log("PASS Session 解析附件、map 透传�?Adapter，历史仍保存指纹");
}

/* ---------------------------------------------------------------------------
 * 2. 同一附件出现多次时只解析一�? * ------------------------------------------------------------------------- */
{
    const host = new MemoryFileHost();
    const attachmentManager = new AttachmentFileManager(host);
    const file = await attachmentManager.put(
        "dup.txt",
        new TextEncoder().encode("dup"),
        "text/plain",
    );
    const cloudManager = new FakeCloudFileManager();
    const llm = new FakeLLM(cloudManager);
    const session = new Session(llm, new SessionHistory(), {}, attachmentManager);

    await session.run([
        { type: "attachment", attachment: { contentHash: file.contentHash } },
        { type: "text", text: "again" },
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ]);

    assert.equal(cloudManager.calls.length, 1, "同一 contentHash 只应 ensure 一�");
    console.log("PASS 同一 contentHash 去重解析");
}

/* ---------------------------------------------------------------------------
 * 3. 无附件时不访�?Manager
 * ------------------------------------------------------------------------- */
{
    const host = new MemoryFileHost();
    const attachmentManager = new AttachmentFileManager(host);
    const cloudManager = new FakeCloudFileManager();
    const llm = new FakeLLM(cloudManager);
    const session = new Session(llm, new SessionHistory(), {}, attachmentManager);

    const run = await session.run("plain text");

    assert.equal(run.status, RunStatus.Completed);
    assert.equal(cloudManager.calls.length, 0);
    assert.equal(llm.lastOptions?.attachmentRefs, undefined);
    console.log("PASS 纯文本不触发附件解析");
}

/* ---------------------------------------------------------------------------
 * 4. 缺少 AttachmentFileManager / CloudFileManager / 本地文件时失�? * ------------------------------------------------------------------------- */
{
    const host = new MemoryFileHost();
    const attachmentManager = new AttachmentFileManager(host);
    const file = await attachmentManager.put(
        "missing.txt",
        new TextEncoder().encode("x"),
        "text/plain",
    );

    const noManager = new Session(
        new FakeLLM(new FakeCloudFileManager()),
        new SessionHistory(),
    );
    const noManagerRun = await noManager.run([
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ]);
    assert.equal(noManagerRun.status, RunStatus.Failed);
    assert.match(String(noManagerRun.error), /AttachmentFileManager/);

    const noCloud = new Session(
        new FakeLLM(null),
        new SessionHistory(),
        {},
        attachmentManager,
    );
    const noCloudRun = await noCloud.run([
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ]);
    assert.equal(noCloudRun.status, RunStatus.Failed);
    assert.match(String(noCloudRun.error), /does not support attachments/);

    const missing = new Session(
        new FakeLLM(new FakeCloudFileManager()),
        new SessionHistory(),
        {},
        attachmentManager,
    );
    const missingRun = await missing.run([
        { type: "attachment", attachment: { contentHash: "0".repeat(64) } },
    ]);
    assert.equal(missingRun.status, RunStatus.Failed);
    assert.match(String(missingRun.error), /missing or corrupted/);
    assert.equal(missing.history?.messages.length, 0, "失败运行不得污染历史");

    console.log("PASS 缺少 Manager / CloudFileManager / 文件时失败且历史不污�");
}

/* ---------------------------------------------------------------------------
 * 5. 历史只序列化 contentHash，不落盘远端引用
 * ------------------------------------------------------------------------- */
{
    const contentHash = "abc123";
    const history = new SessionHistory("attachment-session", [
        new UserMessage([
            { type: "text", text: "see file" },
            { type: "attachment", attachment: { contentHash } },
        ]),
    ]);

    const data = SessionSerializer.serialize(history);
    assert.deepEqual(data.messages[0]?.content, [
        { type: "text", text: "see file" },
        { type: "attachment", attachment: { contentHash } },
    ]);

    const restored = SessionSerializer.deserialize(JSON.parse(JSON.stringify(data)) as unknown);
    assert.deepEqual(restored.messages[0]?.content, data.messages[0]?.content);
    console.log("PASS 历史只序列化 contentHash");
}

console.log("\nAll attachment protocol checks passed.");
