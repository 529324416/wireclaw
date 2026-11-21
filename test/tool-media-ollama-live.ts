import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { MiniMaxImageToolProvider } from "../tools/minimax-image-tool";
import { MemoryFileHost } from "../src/file/memory";
import { MiniMaxH3ImageProvider } from "../src/platform/minimax";
import { OllamaProvider } from "../src/platform/ollama";
import { AttachmentFileManager } from "../src/session/attachment-manager";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { SessionEventType, SessionPermission } from "../src/session/type";
import type { SessionEvent } from "../src/session/type";
import { ToolRegistry } from "../src/session/tool";

async function readMiniMaxKey(): Promise<string> {
    const raw = (await readFile("apikey-minimax-h3.txt", "utf8")).replace(/^\uFEFF/, "").trim();
    const assignment = /^MINIMAX_API_KEY\s*=\s*(.+)$/m.exec(raw);
    return (assignment?.[1] ?? raw).replace(/^["']|["']$/g, "").trim();
}

const provider = new OllamaProvider();
const models = await provider.modelProvider.initModels();
const model = models.find((item) => item.name === "qwen3.5:9b");
assert.ok(model, "qwen3.5:9b should exist");
assert.ok(model.capabilities?.chat?.tools === true, "qwen3.5:9b should support tools");
assert.ok(model.capabilities?.chat?.input.includes("image"), "qwen3.5:9b should support image input");

const imageProvider = new MiniMaxH3ImageProvider({
    apiKey: await readMiniMaxKey(),
    baseUrl: "https://api.minimax.cn",
});
const toolProvider = new MiniMaxImageToolProvider({
    provider: imageProvider,
    size: undefined,
    adviceTimeoutMs: 600_000,
});

const manager = new AttachmentFileManager(new MemoryFileHost());
const session = new Session(
    provider,
    new SessionHistory(),
    { model: "qwen3.5:9b" },
    manager,
);
const registry = new ToolRegistry();
registry.registerProvider(toolProvider);

const events: SessionEvent[] = [];
session.subscribe((event) => {
    events.push(event);
    if (event.type === SessionEventType.TOOL_CALL_START) {
        console.log(`[tool-start] ${event.call.name}`);
    }
    if (event.type === SessionEventType.TOOL_ATTACHMENT) {
        console.log(`[tool-attachment] ${event.name} ${event.mimeType}`);
    }
    if (event.type === SessionEventType.TOOL_CALL_END) {
        console.log(`[tool-end] ${event.call.name} ${event.result.status.isSuccess}`);
    }
});

const run = await session.run(
    "请调用 minimax-image__generateImage 工具生成一张红色圆形图片，然后用一句话描述你看到的图片。",
    {
        tools: registry,
        permission: SessionPermission.Full,
        enableUserInput: false,
    },
);

console.log(`[run] status=${run.status} error=${String(run.error ?? "")}`);

const attachmentEvents = events.filter((event) => event.type === SessionEventType.TOOL_ATTACHMENT);
assert.ok(attachmentEvents.length > 0, "should emit TOOL_ATTACHMENT");

for (const event of attachmentEvents) {
    if (event.type !== SessionEventType.TOOL_ATTACHMENT) continue;
    const file = await manager.get(event.attachment.contentHash);
    assert.ok(file !== undefined, "attachment should be stored");
    await mkdir(".minimax-test-output", { recursive: true });
    const target = `.minimax-test-output/tool-media-ollama-${event.attachment.contentHash.slice(0, 8)}.png`;
    await writeFile(target, file.content);
    console.log(`[saved] ${target} (${file.size} bytes)`);
}

assert.equal(run.status, RunStatus.Completed, "run should complete");
const finalAssistant = [...(session.history?.messages ?? [])]
    .reverse()
    .find((message) => message.role === "assistant");
assert.ok(finalAssistant !== undefined, "should have final assistant message");
console.log(`[assistant] ${JSON.stringify(finalAssistant.content).slice(0, 300)}`);

console.log("\nPASS local MiniMax H3 tool + Ollama multimodal tool result");
