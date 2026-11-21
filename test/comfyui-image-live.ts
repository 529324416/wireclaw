import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { ComfyUIImageToolProvider } from "../tools/comfyui-image-tool";
import type { ComfyUIWorkflow } from "../tools/comfyui-image-tool";
import { ComfyUIImageEditToolProvider } from "../tools/comfyui-image-edit-tool";
import { MemoryFileHost } from "../src/file/memory";
import { AttachmentFileManager } from "../src/session/attachment-manager";

const workflow = JSON.parse(
    await readFile("examples/comfyui/qwen-image-2.1-t2i.json", "utf8"),
) as ComfyUIWorkflow;
const provider = new ComfyUIImageToolProvider({
    workflow,
    baseUrl: process.env.COMFYUI_BASE_URL ?? "http://127.0.0.1:8188",
    timeoutMs: 600_000,
    adviceTimeoutMs: 600_000,
});

const result = await provider.call({
    id: "call-1",
    name: "generateImage",
    params: {
        prompt: "a simple red circle on a white background",
        size: "1024x1024",
        seed: 12345,
        negative_prompt: "blurry, low quality",
    },
});
assert.equal(result.status.isSuccess, true);
const attachment = result.attachments?.[0];
assert.ok(attachment !== undefined && attachment.kind === "bytes");
await mkdir(".minimax-test-output", { recursive: true });
await writeFile(".minimax-test-output/comfyui-image.png", attachment.data);
console.log(`[comfyui] ${attachment.mimeType} ${attachment.data.byteLength} bytes`);

const manager = new AttachmentFileManager(new MemoryFileHost());
const source = await manager.put(attachment.name ?? "comfyui-source.png", attachment.data, attachment.mimeType);
const referenceProvider = new ComfyUIImageToolProvider({
    workflow,
    baseUrl: process.env.COMFYUI_BASE_URL ?? "http://127.0.0.1:8188",
    timeoutMs: 600_000,
    adviceTimeoutMs: 600_000,
    resolveReference: (contentHash) => manager.get(contentHash),
});
const referenced = await referenceProvider.call({
    id: "call-2",
    name: "generateImage",
    params: {
        prompt: "keep the red circle and change the background to deep blue",
        size: "1024x1024",
        seed: 12345,
        references: [source.contentHash],
    },
});
assert.equal(referenced.status.isSuccess, true);
const referencedAttachment = referenced.attachments?.[0];
assert.ok(referencedAttachment !== undefined && referencedAttachment.kind === "bytes");
await writeFile(".minimax-test-output/comfyui-image-reference.png", referencedAttachment.data);
console.log(`[comfyui-reference] ${referencedAttachment.mimeType} ${referencedAttachment.data.byteLength} bytes`);

const editWorkflow = JSON.parse(
    await readFile("examples/comfyui/qwen-image-2.1-image-edit.json", "utf8"),
) as ComfyUIWorkflow;
const editProvider = new ComfyUIImageEditToolProvider({
    workflow: editWorkflow,
    baseUrl: process.env.COMFYUI_BASE_URL ?? "http://127.0.0.1:8188",
    timeoutMs: 600_000,
    adviceTimeoutMs: 600_000,
    resolveReference: (contentHash) => manager.get(contentHash),
});
const edited = await editProvider.call({
    id: "call-3",
    name: "editImage",
    params: {
        prompt: "change the background to deep blue",
        size: "1024x1024",
        seed: 12345,
        references: [source.contentHash],
    },
});
assert.equal(edited.status.isSuccess, true);
const editedAttachment = edited.attachments?.[0];
assert.ok(editedAttachment !== undefined && editedAttachment.kind === "bytes");
await writeFile(".minimax-test-output/comfyui-image-edit.png", editedAttachment.data);
console.log(`[comfyui-edit] ${editedAttachment.mimeType} ${editedAttachment.data.byteLength} bytes`);
console.log("\nPASS ComfyUI Qwen-Image tool generation + reference edit + edit workflow");
