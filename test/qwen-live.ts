import { readFile } from "node:fs/promises";

import { applyQwenReferenceModelOverrides } from "../src/client";
import { MemoryFileHost } from "../src/file/memory";
import { QwenChatProvider } from "../src/platform/qwen";
import { AttachmentFileManager } from "../src/session/attachment-manager";
import { UserMessage } from "../src/session/message";
import { Session, SessionHistory } from "../src/session/session";

const keyRaw = await readFile("apikey-qwen.txt", "utf8");
let apiKey = keyRaw.replace(/^\uFEFF/, "").trim();
const assignment = /^(?:DASHSCOPE_API_KEY|QWEN_API_KEY)\s*=\s*(.+)$/m.exec(apiKey);
if (assignment !== null) apiKey = assignment[1]?.trim() ?? "";
apiKey = apiKey.replace(/^["']|["']$/g, "").trim();
if (apiKey.length === 0) throw new Error("empty qwen key");

const provider = new QwenChatProvider({ apiKey });
applyQwenReferenceModelOverrides(provider);
const models = await provider.modelProvider.initModels();
const interesting = models
    .map((model) => model.id)
    .filter((id) => /qwen-(vl|image|plus|max|omni)/i.test(id));
console.log(`[models] ${interesting.slice(0, 30).join(", ")}`);

/* 1. 纯文本流式对话 */
{
    let tokenCount = 0;
    const result = await provider.chat(
        [new UserMessage("用一句话介绍你自己")],
        { model: "qwen-plus" },
        {
            signal: new AbortController().signal,
            onToken: () => { tokenCount += 1; },
        },
    );
    console.log(`[chat] status=ok tokens=${tokenCount} content=${JSON.stringify(result.message.content.slice(0, 120))}`);
}

/* 2. 图片输入 + 会话分析 */
{
    const bytes = new Uint8Array(await readFile(".minimax-test-output/result-0.png"));
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const file = await manager.put("result-0.png", bytes, "image/png", [".minimax-test-output/result-0.png"]);
    const session = new Session(
        provider,
        new SessionHistory(),
        { model: "qwen3-vl-plus" },
        manager,
    );

    const run = await session.run([
        { type: "text", text: "这张图里有什么？用一句话描述。" },
        { type: "attachment", attachment: { contentHash: file.contentHash } },
    ], { enableUserInput: false });

    const assistant = run.pendingMessages.find((message) => message.role === "assistant");
    const text = typeof assistant?.content === "string"
        ? assistant.content
        : (assistant?.content ?? [])
            .filter((part) => part.type === "text")
            .map((part) => part.type === "text" ? part.text : "")
            .join("");
    console.log(`[vision] status=${run.status} bytes=${file.size} content=${JSON.stringify(text.slice(0, 160))} error=${JSON.stringify(String(run.error ?? ""))}`);
}

console.log("[done] qwen live chat/vision");
