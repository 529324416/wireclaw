import assert from "node:assert/strict";

import { toBase64 } from "../src/base";
import { MemoryFileHost } from "../src/file/memory";
import {
    MINIMAX_H3_IMAGE_MODEL,
    MiniMaxH3ImageProvider,
} from "../src/platform/minimax";
import { AttachmentFile } from "../src/session/attachment";
import { AttachmentFileManager } from "../src/session/attachment-manager";
import { AttachmentIngestor } from "../src/session/attachment-ingestor";
import { isChatProvider, isGenerationProvider } from "../src/session/protocol";
import type { GenerationRequest } from "../src/session/protocol";

type CapturedRequest = {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
};

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
    });
}

{
    let captured: CapturedRequest | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        captured = {
            url: String(input),
            headers: (init?.headers ?? {}) as Record<string, string>,
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        };
        return jsonResponse({
            id: "req-1",
            data: [{
                url: "https://example.com/result.png",
                size: "1024x1024",
                // 模拟平台省略 output_format；应回退到请求的 png
                revised_prompt: "a cat",
            }],
        });
    }) as typeof fetch;

    const provider = new MiniMaxH3ImageProvider({
        apiKey: "test-key",
        fetch: fetchImpl,
    });

    assert.equal(isChatProvider(provider), false);
    assert.equal(isGenerationProvider(provider), true);
    assert.equal(provider.modelInfo.id, MINIMAX_H3_IMAGE_MODEL);
    assert.equal(provider.modelInfo.capabilities?.generate?.image, true);

    const task = await provider.generate({
        modality: "image",
        prompt: "a cat",
        parameters: { seed: 12345, negative_prompt: "blurry, low quality" },
    });
    assert.equal(task.status, "succeeded");

    const media = await task.wait();
    assert.equal(media.length, 1);
    assert.equal(media[0]?.kind, "url");
    assert.equal(media[0]?.mimeType, "image/png");

    assert.equal(captured?.url, "https://api.minimax.io/v1/images/generations");
    assert.equal(captured?.headers.Authorization, "Bearer test-key");
    assert.equal(captured?.body.model, "MiniMax-H3-Image");
    assert.equal(captured?.body.prompt, "a cat");
    assert.equal(captured?.body.n, 1);
    assert.equal(captured?.body.area, "1K");
    assert.equal(captured?.body.output_format, "png");
    assert.equal(captured?.body.response_format, "url");
    assert.equal(captured?.body.seed, 12345);
    assert.equal(captured?.body.negative_prompt, "blurry, low quality");
    console.log("PASS MiniMax H3-Image URL response + request mapping");
}

{
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const fetchImpl = (async () => jsonResponse({
        id: "req-2",
        data: [{
            b64_json: toBase64(pngBytes),
            // 模拟平台 output_format 与实际字节不一致
            output_format: "jpeg",
            size: "1024x1024",
        }],
    })) as typeof fetch;

    const provider = new MiniMaxH3ImageProvider({
        apiKey: "test-key",
        fetch: fetchImpl,
    });
    const task = await provider.generate({
        modality: "image",
        prompt: "a cat",
        parameters: {
            n: 2,
            size: "1024x1024",
            response_format: "b64_json",
            output_format: "png",
        },
    });
    const media = await task.wait();
    assert.equal(media.length, 1);
    assert.equal(media[0]?.kind, "bytes");
    assert.equal(media[0]?.mimeType, "image/png");
    assert.match(media[0]?.name ?? "", /\.png$/);
    if (media[0]?.kind === "bytes") {
        assert.deepEqual([...media[0].data], [...pngBytes]);
    }
    console.log("PASS MiniMax H3-Image b64_json response + magic-byte MIME correction");
}

{
    const provider = new MiniMaxH3ImageProvider({
        apiKey: "test-key",
        fetch: (async () => new Response("bad request", { status: 400 })) as typeof fetch,
    });

    await assert.rejects(
        () => provider.generate({ modality: "image", prompt: "a cat" }),
        /HTTP 400/,
    );
    console.log("PASS MiniMax H3-Image HTTP error");
}

{
    const provider = new MiniMaxH3ImageProvider({
        apiKey: "test-key",
        fetch: (async () => jsonResponse({ data: [] })) as typeof fetch,
    });

    await assert.rejects(
        () => provider.generate({ modality: "image", prompt: "a cat" }),
        /no images/,
    );

    const badRequest: GenerationRequest = {
        modality: "image",
        prompt: "a cat",
        references: [{ contentHash: "a".repeat(64) }],
    };
    await assert.rejects(
        () => provider.generate(badRequest),
        /requires resolved referenceFiles/,
    );
    console.log("PASS MiniMax H3-Image validation");
}

/* ---------------------------------------------------------------------------
 * 图片编辑：参考图通过 /v1/images/edits 的 images[].image_url 发送
 * ------------------------------------------------------------------------- */
{
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    let captured: CapturedRequest | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        captured = {
            url: String(input),
            headers: (init?.headers ?? {}) as Record<string, string>,
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        };
        return jsonResponse({
            id: "req-edit",
            data: [{ url: "https://example.com/edited.png", size: "1024x1024" }],
        });
    }) as typeof fetch;

    const provider = new MiniMaxH3ImageProvider({
        apiKey: "test-key",
        fetch: fetchImpl,
    });
    const reference = await AttachmentFile.create("reference.png", pngBytes, "image/png");

    const task = await provider.generate({
        modality: "image",
        prompt: "turn the background blue",
        references: [{ contentHash: reference.contentHash }],
        referenceFiles: [reference],
        parameters: { response_format: "url" },
    });
    const media = await task.wait();
    assert.equal(media.length, 1);

    assert.equal(captured?.url, "https://api.minimax.io/v1/images/edits");
    assert.equal(captured?.body.prompt, "turn the background blue");
    assert.deepEqual(captured?.body.images, [{
        image_url: `data:image/png;base64,${toBase64(pngBytes)}`,
    }]);
    console.log("PASS MiniMax H3-Image edit request with reference image");
}

{
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const ingestor = new AttachmentIngestor(manager, {
        allowedMimeTypes: ["image/png", "image/jpeg"],
    });
    const ref = await ingestor.ingest({
        kind: "bytes",
        name: "wrong.jpg",
        mimeType: "image/jpeg",
        data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        origin: "generation",
    });
    const file = await manager.get(ref.contentHash);
    assert.equal(file?.mimeType, "image/png");
    assert.equal(file?.name, "wrong.png");
    console.log("PASS AttachmentIngestor corrects declared MIME from magic bytes");
}

console.log("\nAll MiniMax H3-Image checks passed.");
