import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { MiniMaxImageToolProvider } from "../tools/minimax-image-tool";
import { MemoryFileHost } from "../src/file/memory";
import { MiniMaxH3ImageProvider } from "../src/platform/minimax";
import { AttachmentFileManager } from "../src/session/attachment-manager";

async function readKey(): Promise<string> {
    const raw = (await readFile("apikey-minimax-h3.txt", "utf8")).replace(/^\uFEFF/, "").trim();
    const assignment = /^MINIMAX_API_KEY\s*=\s*(.+)$/m.exec(raw);
    return (assignment?.[1] ?? raw).replace(/^["']|["']$/g, "").trim();
}

const manager = new AttachmentFileManager(new MemoryFileHost());
const tool = new MiniMaxImageToolProvider({
    provider: new MiniMaxH3ImageProvider({
        apiKey: await readKey(),
        baseUrl: "https://api.minimax.cn",
    }),
    adviceTimeoutMs: 600_000,
    resolveReference: (contentHash) => manager.get(contentHash),
});

const first = await tool.call({
    id: "call-1",
    name: "generateImage",
    params: { prompt: "a simple red circle on a white background" },
});
assert.equal(first.status.isSuccess, true);
const firstAttachment = first.attachments?.[0];
assert.ok(firstAttachment !== undefined && firstAttachment.kind === "bytes");
const source = await manager.put(
    firstAttachment.name ?? "source.png",
    firstAttachment.data,
    firstAttachment.mimeType,
);
await mkdir(".minimax-test-output", { recursive: true });
await writeFile(".minimax-test-output/minimax-reference-source.png", source.content);
console.log(`[source] ${source.contentHash} ${source.size} bytes`);

const second = await tool.call({
    id: "call-2",
    name: "generateImage",
    params: {
        prompt: "keep the red circle and change the background to deep blue",
        references: [source.contentHash],
    },
});
assert.equal(second.status.isSuccess, true);
const secondAttachment = second.attachments?.[0];
assert.ok(secondAttachment !== undefined && secondAttachment.kind === "bytes");
await writeFile(".minimax-test-output/minimax-reference-edited.png", secondAttachment.data);
console.log(`[edited] ${secondAttachment.data.byteLength} bytes`);

console.log("\nPASS MiniMax H3-Image reference image editing");
