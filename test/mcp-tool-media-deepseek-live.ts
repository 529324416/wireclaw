import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { MemoryFileHost } from "../src/file/memory";
import { DeepSeekProvider } from "../src/platform/deepseek";
import { AttachmentFileManager } from "../src/session/attachment-manager";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { SessionEventType, SessionPermission } from "../src/session/type";
import type { SessionEvent } from "../src/session/type";
import { ToolRegistry } from "../src/session/tool";
import { McpHttpTransport } from "../src/tool/mcp/http";
import { McpToolProvider } from "../src/tool/mcp/provider";

const rawKey = (await readFile("apikey-ds.txt", "utf8")).replace(/^\uFEFF/, "").trim();
const assignment = /^DEEPSEEK_API_KEY\s*=\s*(.+)$/m.exec(rawKey);
const apiKey = (assignment?.[1] ?? rawKey).replace(/^["']|["']$/g, "").trim();

const provider = new DeepSeekProvider({ apiKey });
const models = await provider.modelProvider.initModels();
const model = models.find((item) => item.id === "deepseek-flash" || item.name === "deepseek-flash");
assert.ok(model, "deepseek-flash should exist");
assert.equal(model.isVisionModel, true, "deepseek-flash should support image input");
assert.equal(model.supportToolCall, true, "deepseek-flash should support tools");

const transport = new McpHttpTransport({
    url: process.env.WIRECLAW_MCP_URL ?? "http://127.0.0.1:5001/mcp",
});
const toolProvider = new McpToolProvider({ id: "mcp" }, transport);

const manager = new AttachmentFileManager(new MemoryFileHost());
const session = new Session(
    provider,
    new SessionHistory(),
    { model: "deepseek-flash" },
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

try {
    const run = await session.run(
        "请调用 mcp__generate_image 工具生成一张绿色正方形图片，然后用一句话描述你看到的图片。",
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
        const target = `.minimax-test-output/tool-media-mcp-deepseek-${event.attachment.contentHash.slice(0, 8)}.png`;
        await writeFile(target, file.content);
        console.log(`[saved] ${target} (${file.size} bytes)`);
    }

    assert.equal(run.status, RunStatus.Completed, "run should complete");
    const finalAssistant = [...(session.history?.messages ?? [])]
        .reverse()
        .find((message) => message.role === "assistant");
    assert.ok(finalAssistant !== undefined, "should have final assistant message");
    console.log(`[assistant] ${JSON.stringify(finalAssistant.content).slice(0, 300)}`);
    console.log("\nPASS MCP MiniMax H3 tool + DeepSeek multimodal tool result");
} finally {
    await registry.closeAll();
}
