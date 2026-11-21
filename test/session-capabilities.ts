import assert from "node:assert/strict";

import { AttachmentFileManager } from "../src/session/attachment-manager";
import { MemoryFileHost } from "../src/file/memory";
import { AssistantMessage, UserMessage, assistant } from "../src/session/message";
import type { Message } from "../src/session/message";
import {
    AIProvider,
    CloudFileManager,
    ModelProvider,
} from "../src/session/protocol";
import type { ChatCapability, ModelInfo, ModelModality } from "../src/session/protocol";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { ChatStopReason } from "../src/session/type";
import type {
    AttachmentWireMap,
    ChatOptions,
    ChatResult,
    RemoteFileRef,
    SessionRuntimeOptions,
} from "../src/session/type";
import type { AttachmentFile as AttachmentFileType } from "../src/session/attachment";

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class FakeModelProvider extends ModelProvider {
    constructor(private readonly _models: ModelInfo[]) {
        super();
    }

    async validateNetwork(): Promise<void> {
        // no-op
    }

    protected async fetchModels(): Promise<ModelInfo[]> {
        return this._models;
    }
}

class FakeCloudFileManager extends CloudFileManager {
    readonly calls: AttachmentFileType[] = [];

    async ensureFile(file: AttachmentFileType): Promise<RemoteFileRef> {
        this.calls.push(file);
        return { kind: "inline", data: file.content, name: file.name, mimeType: file.mimeType };
    }
}

function modelInfo(id: string, input: ModelModality[], withCapabilities = true): ModelInfo {
    return {
        id,
        name: id,
        description: id,
        size: 0,
        supportCompletion: true,
        supportToolCall: true,
        supportThink: false,
        isVisionModel: input.includes("image"),
        isEmbeddingModel: false,
        ...(withCapabilities ? {
            capabilities: {
                chat: {
                    input,
                    output: ["text"] as ModelModality[],
                    streaming: true,
                    tools: true,
                },
            },
        } : {}),
    };
}

class FakeChatProvider extends AIProvider implements ChatCapability {
    readonly cloudFiles = new FakeCloudFileManager();
    readonly modelProviderRef: FakeModelProvider;
    lastMessages: readonly Message[] | undefined;
    lastRefs: AttachmentWireMap | undefined;

    constructor(models: ModelInfo[]) {
        super();
        this.modelProviderRef = new FakeModelProvider(models);
    }

    get title(): string {
        return "fake";
    }

    override get modelProvider(): FakeModelProvider {
        return this.modelProviderRef;
    }

    override get cloudFileManager(): FakeCloudFileManager {
        return this.cloudFiles;
    }

    override get supportsTools(): boolean {
        return false;
    }

    async chat(
        messages: readonly Message[],
        _options: SessionRuntimeOptions,
        turn?: ChatOptions,
    ): Promise<ChatResult> {
        this.lastMessages = messages;
        this.lastRefs = turn?.attachmentRefs;
        return { message: assistant("ok", undefined, undefined, undefined, ChatStopReason.Stop) };
    }
}

function sessionWith(provider: FakeChatProvider, manager: AttachmentFileManager): Session {
    return new Session(
        provider,
        new SessionHistory(),
        { model: "test-model" },
        manager,
    );
}

/* ---------------------------------------------------------------------------
 * 1. 模型级模态约束：文本模型拒绝图片输入
 * ------------------------------------------------------------------------- */
{
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const file = await manager.put("pixel.png", pngBytes, "image/png");
    const provider = new FakeChatProvider([modelInfo("test-model", ["text"])]);
    await provider.modelProviderRef.initModels();

    const session = sessionWith(provider, manager);
    const run = await session.run([
        { type: "text", text: "look" },
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ]);

    assert.equal(run.status, RunStatus.Failed);
    assert.match(String(run.error), /does not support image input/);
    assert.equal(provider.cloudFiles.calls.length, 0, "模型不支持时不得触发上传/转换");
    assert.equal(session.history?.messages.length, 0, "失败运行不得污染历史");
    console.log("PASS 文本模型拒绝图片输入");
}

/* ---------------------------------------------------------------------------
 * 2. 视觉模型接受图片输入
 * ------------------------------------------------------------------------- */
{
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const file = await manager.put("pixel.png", pngBytes, "image/png");
    const provider = new FakeChatProvider([modelInfo("test-model", ["text", "image"])]);
    await provider.modelProviderRef.initModels();

    const session = sessionWith(provider, manager);
    const run = await session.run([
        { type: "text", text: "look" },
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ]);

    assert.equal(run.status, RunStatus.Completed);
    assert.equal(provider.cloudFiles.calls.length, 1);
    assert.equal(provider.lastRefs?.size, 1);
    console.log("PASS 视觉模型接受图片输入");
}

/* ---------------------------------------------------------------------------
 * 3. assistant 媒体回放：历史保留引用，但不发送给 Provider
 * ------------------------------------------------------------------------- */
{
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const file = await manager.put("pixel.png", pngBytes, "image/png");
    const provider = new FakeChatProvider([modelInfo("test-model", ["text", "image"])]);
    await provider.modelProviderRef.initModels();

    const history = new SessionHistory("replay-session", [
        assistant([
            { type: "text", text: "made" },
            { type: "attachment", attachment: { contentHash: file.contentHash } },
        ]),
    ]);
    const session = new Session(provider, history, { model: "test-model" }, manager);

    const run = await session.run("continue");
    assert.equal(run.status, RunStatus.Completed);
    assert.equal(provider.cloudFiles.calls.length, 0, "assistant 媒体不应触发上传");

    const assistantMessages = (provider.lastMessages ?? []).filter(
        (message): message is AssistantMessage => message instanceof AssistantMessage,
    );
    assert.equal(assistantMessages.length, 1);
    const replayedContent = assistantMessages[0]?.content;
    assert.ok(Array.isArray(replayedContent), "多段 assistant 内容应保持数组");
    assert.ok(replayedContent.some(
        (part) => part.type === "text" && part.text === "made",
    ), "assistant 文本应保留");
    assert.ok(replayedContent.some(
        (part) => part.type === "text" && part.text === `[media:${file.contentHash}]`,
    ), "assistant 附件应回写为 media 标记");
    assert.ok(replayedContent.every((part) => part.type !== "attachment"));
    assert.equal(provider.lastRefs, undefined);

    const stored = history.messages[0];
    assert.ok(stored instanceof AssistantMessage);
    assert.ok(Array.isArray(stored.content));
    assert.ok(stored.content.some((part) => part.type === "attachment"));
    console.log("PASS assistant 媒体默认不回放");
}

/* ---------------------------------------------------------------------------
 * 4. 未声明 capabilities 的模型按传统字段推导
 * ------------------------------------------------------------------------- */
{
    const provider = new FakeChatProvider([modelInfo("legacy", ["text", "image"], false)]);
    await provider.modelProviderRef.initModels();

    const capabilities = await provider.resolveModelCapabilities("legacy");
    assert.ok(capabilities?.chat?.input?.includes("image"));
    assert.equal(capabilities?.chat?.tools, true);

    const textOnly = await provider.resolveModelCapabilities("missing");
    assert.equal(textOnly, undefined);
    console.log("PASS 模型能力按传统字段推导");
}

/* ---------------------------------------------------------------------------
 * 5. 用户附件额外写入 [media:<hash>] 标记，供参考图工具使用
 * ------------------------------------------------------------------------- */
{
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const file = await manager.put("user.png", pngBytes, "image/png");
    const provider = new FakeChatProvider([modelInfo("test-model", ["text", "image"])]);
    await provider.modelProviderRef.initModels();

    const session = sessionWith(provider, manager);
    const run = await session.run([
        { type: "text", text: "use this image as reference" },
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ]);

    assert.equal(run.status, RunStatus.Completed);
    const outbound = provider.lastMessages ?? [];
    const user = outbound.find(
        (message): message is UserMessage => message instanceof UserMessage
            && Array.isArray(message.content)
            && message.content.some((part) => part.type === "attachment"),
    );
    assert.ok(user !== undefined);
    if (typeof user.content === "string") {
        throw new Error("expected user content parts");
    }
    assert.ok(user.content.some((part) => part.type === "text"
        && part.text === `[media:${file.contentHash}]`));
    console.log("PASS 用户附件保留 contentHash 标记");
}

console.log("\nAll session capability checks passed.");
