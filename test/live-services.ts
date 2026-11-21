import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { MemoryFileHost } from "../src/file/memory";
import { DeepSeekProvider } from "../src/platform/deepseek";
import { MiniMaxChatProvider } from "../src/platform/minimax/chat";
import { MiniMaxH3ImageProvider } from "../src/platform/minimax/image";
import { MiniMaxH3VideoProvider } from "../src/platform/minimax/video";
import { AttachmentFileManager } from "../src/session/attachment-manager";
import { UserMessage } from "../src/session/message";
import { RunStatus, Session, SessionHistory } from "../src/session/session";

function readKey(file: string, envName: string, assignmentName: string): string {
    const configured = process.env[envName]?.trim();
    if (configured !== undefined && configured.length > 0) return configured;

    const raw = readFileSyncSafe(resolve(process.cwd(), file));
    const assignment = new RegExp(`^${assignmentName}\\s*=\\s*(.+)$`, "m").exec(raw);
    return (assignment?.[1] ?? raw).replace(/^["']|["']$/g, "").trim();
}

function readFileSyncSafe(path: string): string {
    return readFileSync(path, "utf8").replace(/^\uFEFF/, "").trim();
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

const failures: string[] = [];
const outDir = resolve(process.cwd(), ".minimax-test-output");
await mkdir(outDir, { recursive: true });

/* ---------------------------------------------------------------------------
 * DeepSeek：文本 + 图片输入
 * ------------------------------------------------------------------------- */
try {
    const apiKey = readKey("apikey-ds.txt", "DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY");
    const provider = new DeepSeekProvider({ apiKey });
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const imageBytes = new Uint8Array(await readFile(".minimax-test-output/result-0.png"));
    const file = await manager.put("result-0.png", imageBytes, "image/png");
    const session = new Session(provider, new SessionHistory(), { model: "deepseek-flash" }, manager);

    const textRun = await session.run("只回复 OK", { enableUserInput: false });
    console.log(`[deepseek] text status=${textRun.status} content=${JSON.stringify(textOf(textRun.pendingMessages.at(-1)?.content).slice(0, 60))}`);

    const visionRun = await session.run([
        { type: "text", text: "这张图里有什么？用一句话描述。" },
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ], { enableUserInput: false });
    console.log(`[deepseek] vision status=${visionRun.status} content=${JSON.stringify(textOf(visionRun.pendingMessages.at(-1)?.content).slice(0, 120))} error=${JSON.stringify(String(visionRun.error ?? ""))}`);
    if (visionRun.status !== RunStatus.Completed) failures.push("deepseek vision");
} catch (error) {
    failures.push(`deepseek: ${String(error)}`);
    console.error("[deepseek] error", String(error));
}

/* ---------------------------------------------------------------------------
 * MiniMax Chat
 * ------------------------------------------------------------------------- */
try {
    const apiKey = readKey("apikey-minimax-h3.txt", "MINIMAX_API_KEY", "MINIMAX_API_KEY");
    const provider = new MiniMaxChatProvider({ apiKey, baseUrl: "https://api.minimax.cn" });
    const result = await provider.chat(
        [new UserMessage("只回复 OK")],
        { model: "MiniMax-M3.1-Flash" },
    );
    console.log(`[minimax-chat] content=${JSON.stringify(result.message.content.slice(0, 60))}`);
} catch (error) {
    failures.push(`minimax-chat: ${String(error)}`);
    console.error("[minimax-chat] error", String(error));
}

/* ---------------------------------------------------------------------------
 * MiniMax H3-Image
 * ------------------------------------------------------------------------- */
try {
    const apiKey = readKey("apikey-minimax-h3.txt", "MINIMAX_API_KEY", "MINIMAX_API_KEY");
    const provider = new MiniMaxH3ImageProvider({ apiKey, baseUrl: "https://api.minimax.cn" });
    const task = await provider.generate({
        modality: "image",
        prompt: "a red circle on a white background, flat minimal style",
        parameters: {
            response_format: "b64_json",
            output_format: "png",
            area: "1K",
            n: 1,
        },
    });
    const media = await task.wait();
    const first = media[0];
    if (first?.kind === "bytes") {
        const path = resolve(outDir, "live-minimax-image.png");
        await writeFile(path, first.data);
        const header = [...first.data.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
        console.log(`[minimax-image] status=${task.status} bytes=${first.data.byteLength} header=${header}`);
    } else {
        console.log(`[minimax-image] status=${task.status} media=${first?.kind ?? "none"}`);
        failures.push("minimax-image: unexpected media kind");
    }
} catch (error) {
    failures.push(`minimax-image: ${String(error)}`);
    console.error("[minimax-image] error", String(error));
}

/* ---------------------------------------------------------------------------
 * MiniMax H3 Video
 * ------------------------------------------------------------------------- */
try {
    const apiKey = readKey("apikey-minimax-h3.txt", "MINIMAX_API_KEY", "MINIMAX_API_KEY");
    const provider = new MiniMaxH3VideoProvider({
        apiKey,
        baseUrl: "https://api.minimax.cn",
        pollIntervalMs: 5_000,
        maxWaitMs: 10 * 60 * 1000,
    });
    const task = await provider.generate({
        modality: "video",
        prompt: "a calm ocean wave at sunset, cinematic",
        parameters: { duration: 4, resolution: "768P", ratio: "16:9" },
    });
    const media = await task.wait();
    const first = media[0];
    if (first?.kind === "url") {
        const response = await fetch(first.url);
        if (!response.ok) throw new Error(`video download HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const path = resolve(outDir, "live-minimax-video.mp4");
        await writeFile(path, bytes);
        const header = [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
        console.log(`[minimax-video] status=${task.status} bytes=${bytes.byteLength} header=${header}`);
    } else if (first?.kind === "bytes") {
        const path = resolve(outDir, "live-minimax-video.mp4");
        await writeFile(path, first.data);
        console.log(`[minimax-video] status=${task.status} bytes=${first.data.byteLength}`);
    } else {
        failures.push("minimax-video: no media");
        console.log("[minimax-video] no media");
    }
} catch (error) {
    failures.push(`minimax-video: ${String(error)}`);
    console.error("[minimax-video] error", String(error));
}

console.log(JSON.stringify({ failures }));
if (failures.length > 0) process.exitCode = 1;
