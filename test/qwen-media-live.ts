import { readFile } from "node:fs/promises";

import { applyQwenReferenceModelOverrides } from "../src/client";
import { MemoryFileHost } from "../src/file/memory";
import { QwenChatProvider } from "../src/platform/qwen";
import { AttachmentFileManager } from "../src/session/attachment-manager";
import { SessionErrorType } from "../src/session/error";
import { Session, SessionHistory } from "../src/session/session";
import { RunStatus } from "../src/session/session";

const keyRaw = (await readFile("apikey-qwen.txt", "utf8")).replace(/^\uFEFF/, "").trim();
const assignment = /^(?:DASHSCOPE_API_KEY|QWEN_API_KEY)\s*=\s*(.+)$/m.exec(keyRaw);
let apiKey = (assignment?.[1] ?? keyRaw).replace(/^["']|["']$/g, "").trim();
if (apiKey.length === 0) throw new Error("empty qwen key");

function sineWav(seconds = 1, sampleRate = 16000): Uint8Array {
    const samples = Math.floor(seconds * sampleRate);
    const dataSize = samples * 2;
    const buffer = new Uint8Array(44 + dataSize);
    const view = new DataView(buffer.buffer);
    const writeString = (offset: number, text: string): void => {
        for (let index = 0; index < text.length; index += 1) {
            buffer[offset + index] = text.charCodeAt(index);
        }
    };
    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, dataSize, true);
    for (let index = 0; index < samples; index += 1) {
        const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 8000);
        view.setInt16(44 + index * 2, value, true);
    }
    return buffer;
}

function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((part): part is { type: "text"; text: string } =>
            typeof part === "object" && part !== null
            && (part as { type?: unknown }).type === "text"
            && typeof (part as { text?: unknown }).text === "string")
        .map((part) => part.text)
        .join("");
}

const provider = new QwenChatProvider({ apiKey });
applyQwenReferenceModelOverrides(provider);
const models = await provider.modelProvider.initModels();
const model = models.find((item) => item.id === "qwen3.8-omni-flash");
console.log(`[model] omni=${model !== undefined} capabilities=${JSON.stringify(model?.capabilities?.chat?.input)}`);

const manager = new AttachmentFileManager(new MemoryFileHost());

/* 1. 音频输入 */
const audioSession = new Session(
    provider,
    new SessionHistory(),
    { model: "qwen3.8-omni-flash" },
    manager,
);
const audioFile = await manager.put("tone.wav", sineWav(1), "audio/wav");
const audioRun = await audioSession.run([
    { type: "text", text: "这段音频里有什么？用一句话说明。" },
    { type: "attachment", attachment: { contentHash: audioFile.contentHash } },
], { enableUserInput: false });
console.log(
    `[audio] status=${audioRun.status}`
    + ` content=${JSON.stringify(textOf(audioRun.pendingMessages.at(-1)?.content).slice(0, 120))}`
    + ` error=${JSON.stringify(String(audioRun.error ?? ""))}`,
);

/* 2. 视频输入 */
const videoSession = new Session(
    provider,
    new SessionHistory(),
    { model: "qwen3.8-omni-flash" },
    manager,
);
const videoBytes = new Uint8Array(await readFile(".minimax-test-output/live-minimax-video.mp4"));
const videoFile = await manager.put("video.mp4", videoBytes, "video/mp4");
const videoRun = await videoSession.run([
    { type: "text", text: "视频里发生了什么？用一句话描述。" },
    { type: "attachment", attachment: { contentHash: videoFile.contentHash } },
], { enableUserInput: false });
console.log(
    `[video] status=${videoRun.status}`
    + ` content=${JSON.stringify(textOf(videoRun.pendingMessages.at(-1)?.content).slice(0, 120))}`
    + ` error=${JSON.stringify(String(videoRun.error ?? ""))}`,
);

/* 3. 文本模型拒绝音频 */
const negativeSession = new Session(
    provider,
    new SessionHistory(),
    { model: "qwen-plus" },
    manager,
);
const negativeRun = await negativeSession.run([
    { type: "attachment", attachment: { contentHash: audioFile.contentHash } },
], { enableUserInput: false });
console.log(
    `[negative] status=${negativeRun.status}`
    + ` type=${JSON.stringify((negativeRun.error as { type?: string } | undefined)?.type)}`
    + ` expected=${JSON.stringify(SessionErrorType.UnsupportedInput)}`,
);

if (audioRun.status !== RunStatus.Completed
    || videoRun.status !== RunStatus.Completed
    || (negativeRun.error as { type?: string } | undefined)?.type !== SessionErrorType.UnsupportedInput) {
    process.exitCode = 1;
}
