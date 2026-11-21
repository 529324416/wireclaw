import assert from "node:assert/strict";

import { MemoryFileHost } from "../src/file/memory";
import { AttachmentFileManager } from "../src/session/attachment-manager";
import { SessionErrorType } from "../src/session/error";
import { assistant } from "../src/session/message";
import type { Message } from "../src/session/message";
import {
    AIProvider,
    CloudFileManager,
    ModelProvider,
} from "../src/session/protocol";
import type { ChatCapability, ModelInfo, ModelLimits } from "../src/session/protocol";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { ChatStopReason } from "../src/session/type";
import type {
    ChatOptions,
    ChatResult,
    RemoteFileRef,
    SessionRuntimeOptions,
} from "../src/session/type";
import type { AttachmentFile as AttachmentFileType } from "../src/session/attachment";

const wavBytes = makeWav(100);
const smallWav = makeWav(2);
const oneSecondWav = makeWav(16000);
const threeSecondWav = makeWav(48000);

function makeMp4(durationMs: number): Uint8Array {
    const box = (type: string, payload: Uint8Array): Uint8Array => {
        const out = new Uint8Array(8 + payload.byteLength);
        new DataView(out.buffer).setUint32(0, out.byteLength, false);
        for (let index = 0; index < 4; index += 1) {
            out[4 + index] = type.charCodeAt(index);
        }
        out.set(payload, 8);
        return out;
    };

    const mvhd = new Uint8Array(20);
    const view = new DataView(mvhd.buffer);
    view.setUint32(12, 1000, false);
    view.setUint32(16, durationMs, false);

    return new Uint8Array([
        ...box("ftyp", new Uint8Array([0x69, 0x73, 0x6f, 0x6d])),
        ...box("moov", box("mvhd", mvhd)),
    ]);
}

const shortMp4 = makeMp4(1500);
const longMp4 = makeMp4(2500);

function makeWav(samples: number): Uint8Array {
    const dataSize = samples * 2;
    const buffer = new Uint8Array(44 + dataSize);
    const view = new DataView(buffer.buffer);
    const write = (offset: number, text: string): void => {
        for (let i = 0; i < text.length; i += 1) buffer[offset + i] = text.charCodeAt(i);
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
    readonly modelProviderRef: FakeModelProvider;
    readonly cloudFiles = new FakeCloudFileManager();

    constructor(
        models: ModelInfo[],
        private readonly _defaultLimits?: ModelLimits,
    ) {
        super();
        this.modelProviderRef = new FakeModelProvider(models);
    }

    override get defaultModelLimits(): ModelLimits | undefined {
        return this._defaultLimits;
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
        _messages: readonly Message[],
        _options: SessionRuntimeOptions,
        _turn?: ChatOptions,
    ): Promise<ChatResult> {
        return { message: assistant("ok", undefined, undefined, undefined, ChatStopReason.Stop) };
    }
}

const audioModel: ModelInfo = {
    id: "audio-model",
    name: "audio-model",
    description: "",
    size: 0,
    supportCompletion: true,
    supportToolCall: false,
    supportThink: false,
    isVisionModel: false,
    isEmbeddingModel: false,
    capabilities: {
        chat: {
            input: ["text", "image", "audio", "video"],
            output: ["text"],
            streaming: true,
            tools: false,
        },
    },
    limits: {
        input: {
            audio: {
                maxEncodedBytes: 128,
                mimeTypes: ["audio/wav"],
                maxCount: 1,
            },
            video: {
                maxCount: 1,
            },
        },
    },
};

const textModel: ModelInfo = {
    ...audioModel,
    id: "text-model",
    name: "text-model",
    capabilities: {
        chat: {
            input: ["text"],
            output: ["text"],
            streaming: true,
            tools: false,
        },
    },
    limits: undefined,
};

const durationModel: ModelInfo = {
    ...audioModel,
    id: "duration-model",
    name: "duration-model",
    limits: {
        input: {
            audio: {
                maxEncodedBytes: 10 * 1024 * 1024,
                maxDurationSeconds: 2,
                mimeTypes: ["audio/wav"],
                maxCount: 1,
            },
        },
    },
};

const videoDurationModel: ModelInfo = {
    ...audioModel,
    id: "video-duration-model",
    name: "video-duration-model",
    capabilities: {
        chat: {
            input: ["text", "video"],
            output: ["text"],
            streaming: true,
            tools: false,
        },
    },
    limits: {
        input: {
            video: {
                maxEncodedBytes: 10 * 1024 * 1024,
                maxDurationSeconds: 2,
                mimeTypes: ["video/mp4"],
            },
        },
    },
};

async function sessionFor(model: ModelInfo): Promise<{
    session: Session;
    manager: AttachmentFileManager;
}> {
    const provider = new FakeChatProvider([model]);
    await provider.modelProviderRef.initModels();
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const session = new Session(
        provider,
        new SessionHistory(),
        { model: model.id },
        manager,
    );
    return { session, manager };
}

/* ---------------------------------------------------------------------------
 * 1. 模型支持 audio 输入；限制内通过
 * ------------------------------------------------------------------------- */
{
    const { session, manager } = await sessionFor(audioModel);
    const file = await manager.put("small.wav", smallWav, "audio/wav");
    const run = await session.run([
        { type: "text", text: "listen" },
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ], { enableUserInput: false });
    assert.equal(run.status, RunStatus.Completed);
    console.log("PASS 音频输入在模型限制内通过");
}

/* ---------------------------------------------------------------------------
 * 2. 编码后超限
 * ------------------------------------------------------------------------- */
{
    const { session, manager } = await sessionFor(audioModel);
    const file = await manager.put("large.wav", wavBytes, "audio/wav");
    const run = await session.run([
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ], { enableUserInput: false });
    assert.equal(run.status, RunStatus.Failed);
    assert.equal((run.error as { type?: string }).type, SessionErrorType.InputLimitExceeded);
    console.log("PASS 音频编码后超限被拒绝");
}

/* ---------------------------------------------------------------------------
 * 3. MIME 不在白名单
 * ------------------------------------------------------------------------- */
{
    const { session, manager } = await sessionFor(audioModel);
    const file = await manager.put("voice.ogg", smallWav, "audio/ogg");
    const run = await session.run([
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ], { enableUserInput: false });
    assert.equal(run.status, RunStatus.Failed);
    assert.equal((run.error as { type?: string }).type, SessionErrorType.UnsupportedMediaFormat);
    console.log("PASS 音频格式白名单拒绝");
}

/* ---------------------------------------------------------------------------
 * 4. 文本模型拒绝音频
 * ------------------------------------------------------------------------- */
{
    const { session, manager } = await sessionFor(textModel);
    const file = await manager.put("small.wav", smallWav, "audio/wav");
    const run = await session.run([
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ], { enableUserInput: false });
    assert.equal(run.status, RunStatus.Failed);
    assert.equal((run.error as { type?: string }).type, SessionErrorType.UnsupportedInput);
    console.log("PASS 文本模型拒绝音频输入");
}

/* ---------------------------------------------------------------------------
 * 5. maxCount
 * ------------------------------------------------------------------------- */
{
    const { session, manager } = await sessionFor(audioModel);
    const first = await manager.put("a.wav", smallWav, "audio/wav");
    const second = await manager.put("b.wav", makeWav(3), "audio/wav");
    const run = await session.run([
        { type: "attachment", attachment: { contentHash: first.contentHash } },
        { type: "attachment", attachment: { contentHash: second.contentHash } },
    ], { enableUserInput: false });
    assert.equal(run.status, RunStatus.Failed);
    assert.equal((run.error as { type?: string }).type, SessionErrorType.InputLimitExceeded);
    console.log("PASS 音频数量上限拒绝");
}

/* ---------------------------------------------------------------------------
 * 6. 时长限制内通过
 * ------------------------------------------------------------------------- */
{
    const { session, manager } = await sessionFor(durationModel);
    const file = await manager.put("one-second.wav", oneSecondWav, "audio/wav");
    const run = await session.run([
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ], { enableUserInput: false });
    assert.equal(run.status, RunStatus.Completed);
    console.log("PASS 音频时长限制内通过");
}

/* ---------------------------------------------------------------------------
 * 7. 时长超限被拒绝
 * ------------------------------------------------------------------------- */
{
    const { session, manager } = await sessionFor(durationModel);
    const file = await manager.put("three-second.wav", threeSecondWav, "audio/wav");
    const run = await session.run([
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ], { enableUserInput: false });
    assert.equal(run.status, RunStatus.Failed);
    assert.equal((run.error as { type?: string }).type, SessionErrorType.InputLimitExceeded);
    assert.match(String(run.error), /duration is too long/);
    console.log("PASS 音频时长超限被拒绝");
}

/* ---------------------------------------------------------------------------
 * 8. 无法确定时长时严格拒绝
 * ------------------------------------------------------------------------- */
{
    const { session, manager } = await sessionFor(durationModel);
    const brokenWav = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
        0x57, 0x41, 0x56, 0x45,
    ]);
    const file = await manager.put("broken.wav", brokenWav, "audio/wav");
    const run = await session.run([
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ], { enableUserInput: false });
    assert.equal(run.status, RunStatus.Failed);
    assert.equal((run.error as { type?: string }).type, SessionErrorType.UnsupportedMediaFormat);
    assert.match(String(run.error), /duration could not be determined/);
    console.log("PASS 无法确定时长时被拒绝");
}

/* ---------------------------------------------------------------------------
 * 9. Provider 级默认限制兜底（模型未声明 limits）
 * ------------------------------------------------------------------------- */
{
    const model: ModelInfo = {
        ...audioModel,
        id: "default-limit-model",
        name: "default-limit-model",
        limits: undefined,
    };
    const provider = new FakeChatProvider([model], {
        input: {
            audio: {
                maxEncodedBytes: 128,
                mimeTypes: ["audio/wav"],
            },
        },
    });
    await provider.modelProviderRef.initModels();

    const manager = new AttachmentFileManager(new MemoryFileHost());
    const session = new Session(
        provider,
        new SessionHistory(),
        { model: model.id },
        manager,
    );
    const file = await manager.put("large.wav", wavBytes, "audio/wav");
    const run = await session.run([
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ], { enableUserInput: false });

    assert.equal(run.status, RunStatus.Failed);
    assert.equal((run.error as { type?: string }).type, SessionErrorType.InputLimitExceeded);
    assert.match(String(run.error), /encoded media is too large/);
    assert.equal(provider.cloudFiles.calls.length, 0, "超限时不得触发 ensureFile");
    console.log("PASS Provider 默认编码上限在 Session 前置生效");
}

/* ---------------------------------------------------------------------------
 * 10. 视频时长限制：MP4 容器解析并强制执行
 * ------------------------------------------------------------------------- */
{
    const { session, manager } = await sessionFor(videoDurationModel);
    const file = await manager.put("short.mp4", shortMp4, "video/mp4");
    const run = await session.run([
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ], { enableUserInput: false });
    assert.equal(run.status, RunStatus.Completed);
    console.log("PASS 视频时长限制内通过");
}

/* ---------------------------------------------------------------------------
 * 11. 视频时长超限被拒绝
 * ------------------------------------------------------------------------- */
{
    const { session, manager } = await sessionFor(videoDurationModel);
    const file = await manager.put("long.mp4", longMp4, "video/mp4");
    const run = await session.run([
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ], { enableUserInput: false });
    assert.equal(run.status, RunStatus.Failed);
    assert.equal((run.error as { type?: string }).type, SessionErrorType.InputLimitExceeded);
    assert.match(String(run.error), /duration is too long/);
    console.log("PASS 视频时长超限被拒绝");
}

/* ---------------------------------------------------------------------------
 * 12. Provider 默认限制与模型级限制按模态合并
 * ------------------------------------------------------------------------- */
{
    const model: ModelInfo = {
        ...audioModel,
        id: "merge-limit-model",
        name: "merge-limit-model",
        limits: {
            input: {
                audio: {
                    maxDurationSeconds: 2,
                    mimeTypes: ["audio/wav"],
                },
            },
        },
    };
    const provider = new FakeChatProvider([model], {
        input: {
            audio: {
                maxEncodedBytes: 128,
                mimeTypes: ["audio/wav"],
            },
        },
    });
    await provider.modelProviderRef.initModels();

    const manager = new AttachmentFileManager(new MemoryFileHost());
    const session = new Session(
        provider,
        new SessionHistory(),
        { model: model.id },
        manager,
    );
    const file = await manager.put("large.wav", wavBytes, "audio/wav");
    const run = await session.run([
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ], { enableUserInput: false });

    assert.equal(run.status, RunStatus.Failed);
    assert.equal((run.error as { type?: string }).type, SessionErrorType.InputLimitExceeded);
    assert.match(String(run.error), /encoded media is too large/);
    console.log("PASS Provider 默认限制与模型限制合并");
}

console.log("\nAll media input checks passed.");
