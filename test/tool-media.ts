import assert from "node:assert/strict";

import { MemoryFileHost } from "../src/file/memory";
import { AttachmentFileManager } from "../src/session/attachment-manager";
import { ToolMessage, UserMessage, assistant } from "../src/session/message";
import type { Message } from "../src/session/message";
import {
    AIProvider,
    CloudFileManager,
    ModelProvider,
} from "../src/session/protocol";
import type { ChatCapability, ModelInfo } from "../src/session/protocol";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { ChatStopReason, SessionEventType, SessionPermission } from "../src/session/type";
import type {
    AttachmentWireMap,
    ChatOptions,
    ChatResult,
    RemoteFileRef,
    SessionEvent,
    SessionRuntimeOptions,
    ToolDefinition,
} from "../src/session/type";
import type { ToolCallOptions, ToolProvider } from "../src/session/tool";
import { ToolRegistry } from "../src/session/tool";
import type { AttachmentFile as AttachmentFileType } from "../src/session/attachment";

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeWav(): Uint8Array {
    const buffer = new Uint8Array(44);
    const view = new DataView(buffer.buffer);
    const write = (offset: number, text: string): void => {
        for (let index = 0; index < text.length; index += 1) {
            buffer[offset + index] = text.charCodeAt(index);
        }
    };
    write(0, "RIFF");
    view.setUint32(4, 36, true);
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
    view.setUint32(40, 0, true);
    return buffer;
}

const wavBytes = makeWav();

class FakeModelProvider extends ModelProvider {
    fetchCalls = 0;
    validateCount = 0;

    constructor(
        private readonly _models: ModelInfo[],
        private readonly _failInit: boolean,
    ) {
        super();
    }

    async validateNetwork(): Promise<void> {
        this.validateCount += 1;
        if (this._failInit) throw new Error("network unavailable");
    }

    protected async fetchModels(): Promise<ModelInfo[]> {
        this.fetchCalls += 1;
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

    private _calls = 0;

    constructor(
        models: ModelInfo[],
        failInit = false,
        private readonly _toolCallName = "media__produce",
    ) {
        super();
        this.modelProviderRef = new FakeModelProvider(models, failInit);
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
        this._calls += 1;
        this.lastMessages = messages;
        this.lastRefs = turn?.attachmentRefs;

        if (this._calls === 1) {
            return {
                message: assistant(
                    "",
                    undefined,
                    undefined,
                    [{
                        id: "call-media",
                        name: this._toolCallName,
                        params: {},
                    }],
                    ChatStopReason.ToolCall,
                ),
            };
        }

        return { message: assistant("done", undefined, undefined, undefined, ChatStopReason.Stop) };
    }
}

function modelInfo(
    id: string,
    input: Array<"text" | "image" | "audio" | "video">,
    output: Array<"text" | "image" | "audio" | "video"> = ["text"],
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

type MediaPart = {
    kind: "bytes";
    data: Uint8Array;
    mimeType: string;
    name: string;
};

class MediaToolProvider implements ToolProvider {
    readonly id = "media";
    readonly name = "Media";
    readonly description = "test media tool";

    constructor(private readonly _parts: readonly MediaPart[]) {}

    async fetchTools(): Promise<ToolDefinition[]> {
        return [{
            name: "produce",
            description: "produce media",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true, concurrencySafe: false },
        }];
    }

    async call(_call: unknown, _options?: ToolCallOptions) {
        return {
            content: "produced",
            status: { isSuccess: true, duration: 0 },
            attachments: this._parts.map((part) => ({
                kind: "bytes" as const,
                data: part.data,
                name: part.name,
                mimeType: part.mimeType,
                origin: "tool" as const,
            })),
        };
    }
}

function makeRegistry(provider: ToolProvider): ToolRegistry {
    const registry = new ToolRegistry();
    registry.registerProvider(provider);
    return registry;
}

function toolMessages(messages: readonly Message[]): ToolMessage[] {
    return messages.filter((message): message is ToolMessage => message instanceof ToolMessage);
}

function syntheticUsers(messages: readonly Message[]): UserMessage[] {
    return messages.filter((message): message is UserMessage => message instanceof UserMessage);
}

/* ---------------------------------------------------------------------------
 * 1. 图片输入 + 文本输出模型：tool 图片应进入 synthetic user
 * ------------------------------------------------------------------------- */
{
    const provider = new FakeChatProvider([modelInfo("vision-text", ["text", "image"], ["text"])]);
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const session = new Session(
        provider,
        new SessionHistory(),
        { model: "vision-text" },
        manager,
    );
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));

    const run = await session.run("draw", {
        tools: makeRegistry(new MediaToolProvider([
            { kind: "bytes", data: pngBytes, mimeType: "image/png", name: "tool.png" },
        ])),
        permission: SessionPermission.Full,
        enableUserInput: false,
    });

    assert.equal(run.status, RunStatus.Completed);
    assert.equal(provider.modelProviderRef.fetchCalls, 1, "未初始化时应自动 initModels");
    assert.equal(provider.cloudFiles.calls.length, 1, "tool 图片应被解析给 Provider");

    const outbound = provider.lastMessages ?? [];
    const user = syntheticUsers(outbound).find((message) =>
        Array.isArray(message.content)
        && message.content.some((part) => part.type === "attachment"));
    assert.ok(user !== undefined, "应生成携带 tool 图片的 synthetic user");
    assert.ok(
        events.some((event) => event.type === SessionEventType.TOOL_ATTACHMENT),
        "应发出 TOOL_ATTACHMENT 事件",
    );

    const storedTool = toolMessages(session.history?.messages ?? [])[0];
    assert.ok(storedTool !== undefined && Array.isArray(storedTool.content));
    assert.ok(storedTool.content.some((part) => part.type === "attachment"));
    console.log("PASS tool 图片接入并按模型输入模态回传");
}

/* ---------------------------------------------------------------------------
 * 2. 文本模型：tool 图片落盘，但不发给模型
 * ------------------------------------------------------------------------- */
{
    const provider = new FakeChatProvider([modelInfo("text-only", ["text"], ["text"])]);
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const session = new Session(
        provider,
        new SessionHistory(),
        { model: "text-only" },
        manager,
    );
    const run = await session.run("draw", {
        tools: makeRegistry(new MediaToolProvider([
            { kind: "bytes", data: pngBytes, mimeType: "image/png", name: "tool.png" },
        ])),
        permission: SessionPermission.Full,
        enableUserInput: false,
    });

    assert.equal(run.status, RunStatus.Completed);
    assert.equal(provider.cloudFiles.calls.length, 0, "文本模型不得收到 tool 媒体");

    const outbound = provider.lastMessages ?? [];
    assert.ok(
        outbound.some((message) => message instanceof UserMessage
            && (typeof message.content === "string"
                ? message.content.includes("model does not accept media input")
                : message.content.some((part) => part.type === "text"
                    && part.text.includes("model does not accept media input")))),
        "应明确告知模型媒体被省略",
    );
    console.log("PASS 文本模型省略 tool 媒体");
}

/* ---------------------------------------------------------------------------
 * 3. 混合图片/音频：只回传模型支持的模态
 * ------------------------------------------------------------------------- */
{
    const provider = new FakeChatProvider([modelInfo("image-only", ["text", "image"], ["text"])]);
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const session = new Session(
        provider,
        new SessionHistory(),
        { model: "image-only" },
        manager,
    );
    const run = await session.run("produce", {
        tools: makeRegistry(new MediaToolProvider([
            { kind: "bytes", data: pngBytes, mimeType: "image/png", name: "tool.png" },
            { kind: "bytes", data: wavBytes, mimeType: "audio/wav", name: "tool.wav" },
        ])),
        permission: SessionPermission.Full,
        enableUserInput: false,
    });

    assert.equal(run.status, RunStatus.Completed);
    assert.equal(provider.cloudFiles.calls.length, 1, "只应解析图片");
    assert.equal(provider.cloudFiles.calls[0]?.mimeType, "image/png");
    console.log("PASS 混合媒体按模型输入模态过滤");
}

/* ---------------------------------------------------------------------------
 * 4. 无 AttachmentFileManager：工具调用失败，但 run 继续
 * ------------------------------------------------------------------------- */
{
    const provider = new FakeChatProvider([modelInfo("vision-text", ["text", "image"], ["text"])]);
    const session = new Session(
        provider,
        new SessionHistory(),
        { model: "vision-text" },
    );
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));

    const run = await session.run("draw", {
        tools: makeRegistry(new MediaToolProvider([
            { kind: "bytes", data: pngBytes, mimeType: "image/png", name: "tool.png" },
        ])),
        permission: SessionPermission.Full,
        enableUserInput: false,
    });

    assert.equal(run.status, RunStatus.Completed);
    const end = events.find((event) => event.type === SessionEventType.TOOL_CALL_END);
    assert.ok(end !== undefined && end.type === SessionEventType.TOOL_CALL_END);
    assert.equal(end.result.status.isSuccess, false);
    assert.match(String(end.result.content), /AttachmentFileManager/);
    console.log("PASS 无附件管理器时工具媒体调用失败");
}

/* ---------------------------------------------------------------------------
 * 5. 宿主覆盖模型能力时不强制 initModels
 * ------------------------------------------------------------------------- */
{
    const provider = new FakeChatProvider([modelInfo("vision-text", ["text", "image"], ["text"])]);
    provider.overwrite("vision-text", {
        capabilities: {
            chat: {
                input: ["text", "image"],
                output: ["text"],
                streaming: true,
                tools: true,
            },
        },
    });
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const session = new Session(
        provider,
        new SessionHistory(),
        { model: "vision-text" },
        manager,
    );

    const run = await session.run("draw", {
        tools: makeRegistry(new MediaToolProvider([
            { kind: "bytes", data: pngBytes, mimeType: "image/png", name: "tool.png" },
        ])),
        permission: SessionPermission.Full,
        enableUserInput: false,
    });

    assert.equal(run.status, RunStatus.Completed);
    assert.equal(provider.modelProviderRef.fetchCalls, 0, "宿主覆盖后不应主动 initModels");
    assert.equal(provider.cloudFiles.calls.length, 1, "覆盖的能力应驱动 tool 媒体回传");
    console.log("PASS 宿主覆盖模型能力优先于自动 initModels");
}

/* ---------------------------------------------------------------------------
 * 6. 自动初始化失败：按不支持媒体处理
 * ------------------------------------------------------------------------- */
{
    const provider = new FakeChatProvider(
        [modelInfo("vision-text", ["text", "image"], ["text"])],
        true,
    );
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const session = new Session(
        provider,
        new SessionHistory(),
        { model: "vision-text" },
        manager,
    );

    const run = await session.run("draw", {
        tools: makeRegistry(new MediaToolProvider([
            { kind: "bytes", data: pngBytes, mimeType: "image/png", name: "tool.png" },
        ])),
        permission: SessionPermission.Full,
        enableUserInput: false,
    });

    assert.equal(run.status, RunStatus.Completed);
    assert.equal(provider.cloudFiles.calls.length, 0);
    console.log("PASS 模型初始化失败时按不支持媒体处理");
}

console.log("\nAll tool media checks passed.");
