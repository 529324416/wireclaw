import { readFileSync } from "node:fs";

const baseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const raw = readFileSync("apikey-qwen.txt", "utf8").replace(/^\uFEFF/, "").trim();
const assignment = /^(?:DASHSCOPE_API_KEY|QWEN_API_KEY)\s*=\s*(.+)$/m.exec(raw);
const apiKey = (assignment?.[1] ?? raw).replace(/^["']|["']$/g, "").trim();
const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
};

function sineWav(seconds = 1, sampleRate = 16000): Uint8Array {
    const samples = Math.floor(seconds * sampleRate);
    const dataSize = samples * 2;
    const buffer = new Uint8Array(44 + dataSize);
    const view = new DataView(buffer.buffer);
    const writeString = (offset: number, text: string): void => {
        for (let i = 0; i < text.length; i += 1) buffer[offset + i] = text.charCodeAt(i);
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
    for (let i = 0; i < samples; i += 1) {
        const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000);
        view.setInt16(44 + i * 2, value, true);
    }
    return buffer;
}

async function post(label: string, body: unknown): Promise<void> {
    const started = Date.now();
    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
    });
    const text = await response.text();
    console.log(`\n=== ${label} status=${response.status} ms=${Date.now() - started} ===`);
    console.log(text.slice(0, 1200));
    if (response.ok) {
        try {
            const parsed = JSON.parse(text) as {
                choices?: Array<{ message?: { content?: unknown } }>;
                usage?: unknown;
            };
            console.log("content:", JSON.stringify(parsed.choices?.[0]?.message?.content).slice(0, 500));
            console.log("usage:", JSON.stringify(parsed.usage));
        } catch {
            // ignore
        }
    }
}

const wav = sineWav(1);
const wavBase64 = Buffer.from(wav).toString("base64");
const audioDataUri = `data:audio/wav;base64,${wavBase64}`;

await post("audio data URI", {
    model: "qwen3.8-omni-flash",
    messages: [{
        role: "user",
        content: [
            { type: "text", text: "这段音频里有什么？如果没有语音，只回复 OK。" },
            { type: "input_audio", input_audio: { data: audioDataUri, format: "wav" } },
        ],
    }],
    modalities: ["text"],
    stream: false,
});

await post("audio raw base64", {
    model: "qwen3.8-omni-flash",
    messages: [{
        role: "user",
        content: [
            { type: "text", text: "这段音频里有什么？如果没有语音，只回复 OK。" },
            { type: "input_audio", input_audio: { data: wavBase64, format: "wav" } },
        ],
    }],
    modalities: ["text"],
    stream: false,
});

const mp4 = readFileSync(".minimax-test-output/live-minimax-video.mp4");
const videoDataUri = `data:video/mp4;base64,${mp4.toString("base64")}`;
await post("video data URI", {
    model: "qwen3.8-omni-flash",
    messages: [{
        role: "user",
        content: [
            { type: "video_url", video_url: { url: videoDataUri } },
            { type: "text", text: "视频里有什么？" },
        ],
    }],
    modalities: ["text"],
    stream: false,
});

await post("video public URL", {
    model: "qwen3.8-omni-flash",
    messages: [{
        role: "user",
        content: [
            {
                type: "video_url",
                video_url: {
                    url: "https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20241115/cqqkru/1.mp4",
                },
            },
            { type: "text", text: "视频的内容是什么？用一句话描述。" },
        ],
    }],
    modalities: ["text"],
    stream: false,
});
