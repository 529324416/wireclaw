import { readFile } from "node:fs/promises";

const keyRaw = await readFile("apikey-qwen.txt", "utf8");
let apiKey = keyRaw.replace(/^\uFEFF/, "").trim();
const assignment = /^(?:DASHSCOPE_API_KEY|QWEN_API_KEY)\s*=\s*(.+)$/m.exec(apiKey);
if (assignment !== null) apiKey = assignment[1]?.trim() ?? "";
apiKey = apiKey.replace(/^["']|["']$/g, "").trim();

const base = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
};

const modelsResponse = await fetch(`${base}/models`, { headers });
const modelsPayload = await modelsResponse.json() as { data?: Array<{ id?: string }> };
const ids = (modelsPayload.data ?? []).map((item) => item.id ?? "");
console.log("[all count]", ids.length);
console.log("[vision-like]", ids.filter((id) => /vl|vision|omni/i.test(id)).join(", "));
console.log("[image-like]", ids.filter((id) => /image/i.test(id)).join(", "));
console.log("[chat-like]", ids.filter((id) => /plus|max|turbo|flash/i.test(id)).slice(0, 20).join(", "));

const imageEndpoint = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

for (const model of ["qwen-image-2.0", "qwen-image-2.1-pro", "qwen-image-3.0"]) {
    const response = await fetch(imageEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
            model,
            input: { messages: [{ role: "user", content: [{ text: "a red circle on white background" }] }] },
            parameters: { size: "1024*1024", n: 1, prompt_extend: true, watermark: false },
        }),
    });
    const text = await response.text();
    console.log(`[image ${model}] status=${response.status} body=${text.slice(0, 240)}`);
    if (response.ok) break;
}
