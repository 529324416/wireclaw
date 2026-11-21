import assert from "node:assert/strict";

import { MiniMaxImageToolProvider } from "../tools/minimax-image-tool";
import { AttachmentFile } from "../src/session/attachment";
import type {
    GenerationCapability,
    GenerationOptions,
    GenerationRequest,
    GenerationTask,
} from "../src/session/protocol";
import { isToolError, ToolErrorType } from "../src/session/error";

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class FakeGenerationProvider implements GenerationCapability {
    requests: GenerationRequest[] = [];

    constructor(private readonly _data: Uint8Array) {}

    async generate(request: GenerationRequest, _options?: GenerationOptions): Promise<GenerationTask> {
        this.requests.push(request);
        const data = this._data;
        const media = {
            kind: "bytes" as const,
            data,
            name: "generated.png",
            mimeType: "image/png",
        };
        return {
            id: "task-1",
            status: "succeeded",
            result: [media],
            async cancel(): Promise<void> {},
            async wait() {
                return [media];
            },
        };
    }
}

/* ---------------------------------------------------------------------------
 * 1. 工具定义 / 超时 / 媒体产出
 * ------------------------------------------------------------------------- */
{
    const generation = new FakeGenerationProvider(pngBytes);
    const provider = new MiniMaxImageToolProvider({
        provider: generation,
        size: "1024x1024",
    });

    const tools = await provider.fetchTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, "generateImage");
    assert.equal(tools[0]?.adviceTimeout, 600_000);

    const result = await provider.call({
        id: "call-1",
        name: "generateImage",
        params: {
            prompt: "draw a cat",
            seed: 12345,
            negative_prompt: "blurry",
        },
    });

    assert.equal(result.status.isSuccess, true);
    assert.equal(result.attachments?.length, 1);
    const attachment = result.attachments?.[0];
    assert.ok(attachment !== undefined && attachment.kind === "bytes");
    assert.deepEqual([...attachment.data], [...pngBytes]);
    assert.equal(attachment.origin, "tool");

    assert.equal(generation.requests.length, 1);
    assert.equal(generation.requests[0]?.modality, "image");
    assert.equal(generation.requests[0]?.prompt, "draw a cat");
    assert.equal(generation.requests[0]?.parameters?.response_format, "b64_json");
    assert.equal(generation.requests[0]?.parameters?.size, "1024x1024");
    assert.equal(generation.requests[0]?.parameters?.seed, 12345);
    assert.equal(generation.requests[0]?.parameters?.negative_prompt, "blurry");
    console.log("PASS MiniMax H3 本地工具产出附件");
}

/* ---------------------------------------------------------------------------
 * 2. 参考图：contentHash 解析为附件字节，URL 原样透传
 * ------------------------------------------------------------------------- */
{
    const generation = new FakeGenerationProvider(pngBytes);
    const reference = await AttachmentFile.create("reference.png", pngBytes, "image/png");
    const provider = new MiniMaxImageToolProvider({
        provider: generation,
        resolveReference: async (contentHash) =>
            contentHash === reference.contentHash ? reference : undefined,
    });

    const result = await provider.call({
        id: "call-ref",
        name: "generateImage",
        params: {
            prompt: "change the background",
            references: [
                reference.contentHash,
                "https://example.test/reference.png",
            ],
        },
    });

    assert.equal(result.status.isSuccess, true);
    assert.equal(generation.requests.length, 1);
    const request = generation.requests[0];
    assert.equal(request?.prompt, "change the background");
    assert.equal(request?.referenceFiles?.[0]?.contentHash, reference.contentHash);
    assert.deepEqual(request?.references, [{ contentHash: reference.contentHash }]);
    assert.deepEqual(request?.referenceUrls, ["https://example.test/reference.png"]);
    console.log("PASS MiniMax H3 本地工具接收参考图");
}

/* ---------------------------------------------------------------------------
 * 2. 生成失败映射为 ToolError
 * ------------------------------------------------------------------------- */
{
    const generation: GenerationCapability = {
        async generate(): Promise<GenerationTask> {
            throw new Error("generation failed");
        },
    };
    const provider = new MiniMaxImageToolProvider({ provider: generation });

    try {
        await provider.call({
            id: "call-2",
            name: "generateImage",
            params: { prompt: "fail" },
        });
        assert.fail("should throw");
    } catch (error) {
        assert.ok(isToolError(error));
        assert.equal(error.type, ToolErrorType.ProviderError);
        assert.match(error.message, /generation failed/);
    }
    console.log("PASS MiniMax H3 工具错误映射");
}

console.log("\nAll MiniMax image tool checks passed.");
