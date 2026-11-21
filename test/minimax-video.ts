import assert from "node:assert/strict";

import { MiniMaxH3VideoProvider } from "../src/platform/minimax";
import { isChatProvider, isGenerationProvider } from "../src/session/protocol";
import type { GenerationProgress, GenerationRequest } from "../src/session/protocol";

type CapturedRequest = {
    method: string;
    url: string;
    body?: Record<string, unknown>;
};

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
    });
}

{
    const calls: CapturedRequest[] = [];
    let queryCount = 0;
    const progress: GenerationProgress[] = [];

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({
            method,
            url,
            ...(typeof init?.body === "string"
                ? { body: JSON.parse(init.body) as Record<string, unknown> }
                : {}),
        });

        if (method === "POST" && url.endsWith("/v2/video_generation")) {
            return jsonResponse({ task_id: "task-1" });
        }
        if (method === "GET" && url.includes("/v2/query/video_generation/task-1")) {
            queryCount += 1;
            if (queryCount === 1) {
                return jsonResponse({
                    task: { id: "task-1", status: "running", progress: 10 },
                });
            }
            return jsonResponse({
                task: {
                    id: "task-1",
                    status: "succeeded",
                    content: {
                        url: "https://example.com/video.mp4",
                        duration: 4,
                        resolution: "768P",
                    },
                    usage: { output_seconds: 4 },
                },
            });
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    const provider = new MiniMaxH3VideoProvider({
        apiKey: "test-key",
        baseUrl: "https://api.minimax.cn",
        fetch: fetchImpl,
        pollIntervalMs: 10,
        maxWaitMs: 2_000,
    });

    assert.equal(isChatProvider(provider), false);
    assert.equal(isGenerationProvider(provider), true);
    assert.equal(provider.modelInfo.capabilities?.generate?.video, true);
    assert.equal(provider.modelInfo.capabilities?.generate?.async, true);

    const task = await provider.generate({
        modality: "video",
        prompt: "a cat on a windowsill",
        parameters: {
            duration: 4,
            resolution: "768P",
            ratio: "16:9",
        },
    }, {
        onProgress: (value) => progress.push(value),
    });

    assert.equal(task.id, "task-1");
    assert.equal(task.status, "queued");

    const media = await task.wait();
    assert.equal(media.length, 1);
    assert.equal(media[0]?.kind, "url");
    assert.equal(media[0]?.mimeType, "video/mp4");
    assert.equal(media[0]?.url, "https://example.com/video.mp4");

    const createCall = calls.find((call) => call.method === "POST");
    assert.equal(createCall?.url, "https://api.minimax.cn/v2/video_generation");
    assert.equal(createCall?.body?.model, "MiniMax-H3");
    assert.equal(createCall?.body?.duration, 4);
    assert.equal(createCall?.body?.resolution, "768P");
    assert.equal(createCall?.body?.ratio, "16:9");
    assert.deepEqual(createCall?.body?.content, [
        { type: "text", text: "a cat on a windowsill" },
    ]);

    assert.equal(queryCount, 2);
    assert.equal(progress.length >= 2, true);
    console.log("PASS MiniMax H3 Video create + poll + success");
}

{
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (method === "POST") return jsonResponse({ task_id: "task-2" });
        if (method === "DELETE") return new Response(null, { status: 204 });
        throw new Error(`Unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    const provider = new MiniMaxH3VideoProvider({
        apiKey: "test-key",
        fetch: fetchImpl,
        pollIntervalMs: 10,
    });
    const task = await provider.generate({
        modality: "video",
        prompt: "cancel me",
    });
    await task.cancel();
    assert.equal(task.status, "cancelled");
    console.log("PASS MiniMax H3 Video cancel");
}

{
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (method === "POST") return jsonResponse({ task_id: "task-3" });
        if (method === "GET" && url.includes("/v2/query/video_generation/task-3")) {
            return jsonResponse({
                task: {
                    id: "task-3",
                    status: "failed",
                    error: { code: "1027", message: "content safety check failed" },
                },
            });
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    const provider = new MiniMaxH3VideoProvider({
        apiKey: "test-key",
        fetch: fetchImpl,
        pollIntervalMs: 10,
        maxWaitMs: 2_000,
    });
    const task = await provider.generate({
        modality: "video",
        prompt: "fail",
    });

    await assert.rejects(
        () => task.wait(),
        /content safety check failed/,
    );
    assert.equal(task.status, "failed");
    console.log("PASS MiniMax H3 Video failure");
}

{
    const provider = new MiniMaxH3VideoProvider({
        apiKey: "test-key",
        fetch: (async () => jsonResponse({ task_id: "unused" })) as typeof fetch,
    });

    await assert.rejects(
        () => provider.generate({
            modality: "video",
            prompt: "too long",
            parameters: { duration: 16 },
        }),
        /duration must be an integer between 4 and 15/,
    );
    const wrongModality = {
        modality: "image",
        prompt: "wrong modality",
    } as unknown as GenerationRequest;
    await assert.rejects(
        () => provider.generate(wrongModality),
        /only supports video/,
    );
    console.log("PASS MiniMax H3 Video validation");
}

console.log("\nAll MiniMax H3 Video checks passed.");
