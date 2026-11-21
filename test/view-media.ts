import assert from "node:assert/strict";

import { MemoryFileHost } from "../src/file/memory";
import { AttachmentFileManager } from "../src/session/attachment-manager";
import { VIEW_MEDIA_TOOL_NAME } from "../src/session/host-tool";
import {
    AssistantMessage,
    ToolMessage,
    UserMessage,
    assistant,
} from "../src/session/message";
import type { Message } from "../src/session/message";
import {
    AIProvider,
    CloudFileManager,
    ModelProvider,
} from "../src/session/protocol";
import type {
    ChatCapability,
    ModelInfo,
    ModelModality,
} from "../src/session/protocol";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { ChatStopReason } from "../src/session/type";
import type {
    AttachmentWireMap,
    ChatOptions,
    ChatResult,
    RemoteFileRef,
    SessionRuntimeOptions,
    ToolDefinition,
} from "../src/session/type";
import type { AttachmentFile as AttachmentFileType } from "../src/session/attachment";

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeWav(samples: number): Uint8Array {
    const dataSize = samples * 2;
    const buffer = new Uint8Array(44 + dataSize);
    const view = new DataView(buffer.buffer);
    const write = (offset: number, text: string): void => {
        for (let index = 0; index < text.length; index += 1) {
            buffer[offset + index] = text.charCodeAt(index);
        }
    };
    write(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    write(8, "WAVE");
    write(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, "data");
    view.setUint32(40, dataSize, true);
    return buffer;
}

const wavBytes = makeWav(16000);

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

class FakeChatProvider extends AIProvider implements ChatCapability {
    readonly cloudFiles = new FakeCloudFileManager();
    readonly modelProviderRef: FakeModelProvider;
    lastMessages: readonly Message[] | undefined;
    lastRefs: AttachmentWireMap | undefined;
    lastTools: readonly ToolDefinition[] | undefined;
    mediaHash: string | undefined;

    private _chatCalls = 0;

    constructor(
        models: ModelInfo[],
        private readonly _media: { data: Uint8Array; mimeType: string } | undefined,
    ) {
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
        return true;
    }

    async chat(
        messages: readonly Message[],
        _options: SessionRuntimeOptions,
        turn?: ChatOptions,
    ): Promise<ChatResult> {
        this._chatCalls += 1;
        this.lastMessages = messages;
        this.lastRefs = turn?.attachmentRefs;
        this.lastTools = turn?.tools;

        if (this._media === undefined) {
            return { message: assistant("ok", undefined, undefined, undefined, ChatStopReason.Stop) };
        }

        if (this._chatCalls === 1) {
            return {
                message: assistant("", undefined, undefined, undefined, ChatStopReason.Stop),
                attachments: [{
                    kind: "bytes",
                    data: this._media.data,
                    mimeType: this._media.mimeType,
                    origin: "assistant",
                }],
            };
        }

        if (this._chatCalls === 2) {
            assert.ok(this.mediaHash !== undefined);
            return {
                message: assistant(
                    "",
                    undefined,
                    undefined,
                    [{
                        id: "call-view",
                        name: VIEW_MEDIA_TOOL_NAME,
                        params: { contentHash: this.mediaHash },
                    }],
                    ChatStopReason.ToolCall,
                ),
            };
        }

        return { message: assistant("seen", undefined, undefined, undefined, ChatStopReason.Stop) };
    }
}

function modelInfo(
    id: string,
    input: ModelModality[],
    output: ModelModality[] = ["text", "image"],
): ModelInfo {
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
        capabilities: {
            chat: {
                input,
                output,
                streaming: true,
                tools: true,
            },
        },
    };
}

/* ---------------------------------------------------------------------------
 * 1. 多模态 -> 多模态：注册 view_media，assistant 标记 + tool 媒体回传
 * ------------------------------------------------------------------------- */
{
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const provider = new FakeChatProvider(
        [modelInfo("multimodal", ["text", "image"])],
        { data: pngBytes, mimeType: "image/png" },
    );
    await provider.modelProviderRef.initModels();

    const history = new SessionHistory("view-media");
    const session = new Session(provider, history, { model: "multimodal" }, manager);

    const first = await session.run("draw", { enableUserInput: false });
    assert.equal(first.status, RunStatus.Completed);
    assert.equal(manager.size, 1);

    const storedAssistant = history.messages.find(
        (message): message is AssistantMessage => message instanceof AssistantMessage,
    );
    assert.ok(storedAssistant !== undefined);
    assert.ok(Array.isArray(storedAssistant.content));
    const storedPart = storedAssistant.content.find((part) => part.type === "attachment");
    assert.ok(storedPart !== undefined && storedPart.type === "attachment");
    const contentHash = storedPart.attachment.contentHash;

    assert.ok(provider.lastTools?.some((tool) => tool.name === VIEW_MEDIA_TOOL_NAME));

    provider.mediaHash = contentHash;
    const second = await session.run("look again", { enableUserInput: false });
    assert.equal(second.status, RunStatus.Completed);

    const outbound = provider.lastMessages ?? [];
    const historicalAssistant = outbound.find(
        (message): message is AssistantMessage =>
            message instanceof AssistantMessage
            && Array.isArray(message.content)
            && message.content.some((part) => part.type === "text"
                && part.text === `[media:${contentHash}]`),
    );
    assert.ok(historicalAssistant !== undefined, "assistant 媒体应回写 [media:<hash>] 标记");

    const outboundTool = outbound.find(
        (message): message is ToolMessage => message instanceof ToolMessage,
    );
    assert.ok(outboundTool !== undefined);
    assert.ok(
        typeof outboundTool.content === "string"
        || outboundTool.content.every((part) => part.type !== "attachment"),
        "tool 消息本身不应携带附件",
    );

    const syntheticUser = outbound.find(
        (message): message is UserMessage =>
            message instanceof UserMessage
            && Array.isArray(message.content)
            && message.content.some((part) => part.type === "attachment"
                && part.attachment.contentHash === contentHash),
    );
    assert.ok(syntheticUser !== undefined, "当前轮 tool 媒体应转成 synthetic user 消息");

    assert.ok(provider.lastRefs?.has(contentHash), "synthetic user 媒体应被 ensureFile 解析");
    assert.ok(provider.cloudFiles.calls.some((file) => file.contentHash === contentHash));

    const committedTool = history.messages.find(
        (message): message is ToolMessage => message instanceof ToolMessage,
    );
    assert.ok(committedTool !== undefined);
    assert.ok(Array.isArray(committedTool.content));
    assert.ok(committedTool.content.some((part) => part.type === "attachment"));

    console.log("PASS view_media 标记 / 工具注册 / tool 媒体 synthetic user");
}

/* ---------------------------------------------------------------------------
 * 2. 文本 -> 文本：不注册 view_media
 * ------------------------------------------------------------------------- */
{
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const provider = new FakeChatProvider(
        [modelInfo("text-only", ["text"])],
        undefined,
    );
    await provider.modelProviderRef.initModels();

    const session = new Session(
        provider,
        new SessionHistory("text-only"),
        { model: "text-only" },
        manager,
    );
    const run = await session.run("hello", { enableUserInput: false });
    assert.equal(run.status, RunStatus.Completed);
    assert.equal(
        (provider.lastTools ?? []).some((tool) => tool.name === VIEW_MEDIA_TOOL_NAME),
        false,
        "文本模型不应注册 view_media",
    );
    console.log("PASS 文本模型不注册 view_media");
}

/* ---------------------------------------------------------------------------
 * 3. 音频 -> 音频：view_media 支持音频回放
 * ------------------------------------------------------------------------- */
{
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const provider = new FakeChatProvider(
        [modelInfo("audio-model", ["text", "audio"], ["text", "audio"])],
        { data: wavBytes, mimeType: "audio/wav" },
    );
    await provider.modelProviderRef.initModels();

    const history = new SessionHistory("view-audio");
    const session = new Session(provider, history, { model: "audio-model" }, manager);

    const first = await session.run("say", { enableUserInput: false });
    assert.equal(first.status, RunStatus.Completed);

    const storedAssistant = history.messages.find(
        (message): message is AssistantMessage => message instanceof AssistantMessage,
    );
    assert.ok(storedAssistant !== undefined && Array.isArray(storedAssistant.content));
    const storedPart = storedAssistant.content.find((part) => part.type === "attachment");
    assert.ok(storedPart !== undefined && storedPart.type === "attachment");
    const contentHash = storedPart.attachment.contentHash;

    assert.ok(
        provider.lastTools?.some((tool) => tool.name === VIEW_MEDIA_TOOL_NAME),
        "音频模型应注册 view_media",
    );

    provider.mediaHash = contentHash;
    const second = await session.run("play again", { enableUserInput: false });
    assert.equal(second.status, RunStatus.Completed);

    const outbound = provider.lastMessages ?? [];
    const syntheticUser = outbound.find(
        (message): message is UserMessage =>
            message instanceof UserMessage
            && Array.isArray(message.content)
            && message.content.some((part) => part.type === "attachment"
                && part.attachment.contentHash === contentHash),
    );
    assert.ok(syntheticUser !== undefined, "音频 view_media 应转成 synthetic user 消息");
    assert.ok(provider.lastRefs?.has(contentHash));
    console.log("PASS view_media 支持音频回放");
}

/* ---------------------------------------------------------------------------
 * 4. 模型不能接收的模态：view_media 返回工具错误，不把媒体发出去
 * ------------------------------------------------------------------------- */
{
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const provider = new FakeChatProvider(
        [modelInfo("image-only", ["text", "image"], ["text", "image", "audio"])],
        { data: wavBytes, mimeType: "audio/wav" },
    );
    await provider.modelProviderRef.initModels();

    const history = new SessionHistory("view-mismatch");
    const session = new Session(provider, history, { model: "image-only" }, manager);

    const first = await session.run("say", { enableUserInput: false });
    assert.equal(first.status, RunStatus.Completed);

    const storedAssistant = history.messages.find(
        (message): message is AssistantMessage => message instanceof AssistantMessage,
    );
    assert.ok(storedAssistant !== undefined && Array.isArray(storedAssistant.content));
    const storedPart = storedAssistant.content.find((part) => part.type === "attachment");
    assert.ok(storedPart !== undefined && storedPart.type === "attachment");

    provider.mediaHash = storedPart.attachment.contentHash;
    const second = await session.run("play it", { enableUserInput: false });
    assert.equal(second.status, RunStatus.Completed);

    const toolMessage = history.messages.find(
        (message): message is ToolMessage =>
            message instanceof ToolMessage && message.toolName === VIEW_MEDIA_TOOL_NAME,
    );
    assert.ok(toolMessage !== undefined);
    assert.equal(toolMessage.isSuccess, false);
    assert.match(String(toolMessage.content), /cannot receive audio/);
    console.log("PASS view_media 拒绝模型无法接收的模态");
}

/* ---------------------------------------------------------------------------
 * 5. 图片输入 + 文本输出：不注册 view_media（selfViewable 为空）
 * ------------------------------------------------------------------------- */
{
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const provider = new FakeChatProvider(
        [modelInfo("vision-text", ["text", "image"], ["text"])],
        undefined,
    );
    await provider.modelProviderRef.initModels();

    const session = new Session(
        provider,
        new SessionHistory("vision-text"),
        { model: "vision-text" },
        manager,
    );
    const run = await session.run("hello", { enableUserInput: false });
    assert.equal(run.status, RunStatus.Completed);
    assert.equal(
        (provider.lastTools ?? []).some((tool) => tool.name === VIEW_MEDIA_TOOL_NAME),
        false,
        "输出为文本的视觉模型不应注册 view_media",
    );
    console.log("PASS 图片输入/文本输出模型不注册 view_media");
}

console.log("\nAll view media checks passed.");
