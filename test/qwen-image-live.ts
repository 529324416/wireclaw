import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

import { QwenImageProvider } from "../src/platform/qwen";

const raw = readFileSync("apikey-qwen.txt", "utf8").replace(/^\uFEFF/, "").trim();
const assignment = /^(?:DASHSCOPE_API_KEY|QWEN_API_KEY)\s*=\s*(.+)$/m.exec(raw);
const apiKey = (assignment?.[1] ?? raw).replace(/^["']|["']$/g, "").trim();

const provider = new QwenImageProvider({ apiKey });
const task = await provider.generate({
    modality: "image",
    prompt: "a red circle on a white background, flat minimal style",
});
const media = await task.wait();
const first = media[0];
if (first?.kind !== "url") throw new Error("no url media");

const response = await fetch(first.url);
if (!response.ok) throw new Error(`download HTTP ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());
const outDir = resolve(process.cwd(), ".minimax-test-output");
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, "qwen-image-live.png"), bytes);
const header = [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
console.log(JSON.stringify({ status: task.status, bytes: bytes.length, header }));
