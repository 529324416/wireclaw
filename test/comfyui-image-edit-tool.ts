import assert from "node:assert/strict";

import { ComfyUIImageEditToolProvider } from "../tools/comfyui-image-edit-tool";
import type { ComfyUIWorkflow } from "../tools/comfyui-image-tool";

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function editWorkflow(): ComfyUIWorkflow {
    return {
        text: {
            class_type: "TextEncodeQwenImage21",
            inputs: {
                prompt: "",
                negative_prompt: "",
                clip: ["clip", 0],
                "images.image_1": ["scale", 0],
                vae: ["vae", 0],
            },
        },
        latent: {
            class_type: "EmptyLatentImage",
            inputs: { width: 1024, height: 1024, batch_size: 1 },
        },
        sampler: {
            class_type: "KSampler",
            inputs: {
                seed: 1,
                latent_image: ["latent-switch", 0],
            },
        },
        "latent-switch": {
            class_type: "ComfySwitchNode",
            inputs: {
                switch: false,
                on_false: ["text", 2],
                on_true: ["latent", 0],
            },
        },
        load: {
            class_type: "LoadImage",
            inputs: { image: "source.png" },
        },
        scale: {
            class_type: "ImageScaleToTotalPixels",
            inputs: {
                upscale_method: "nearest-exact",
                megapixels: 0.8,
                resolution_steps: 1,
                image: ["load", 0],
            },
        },
        output: {
            class_type: "SaveImageAdvanced",
            inputs: { images: ["sampler", 0] },
        },
    };
}

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

function fakeFetch(captured: {
    uploaded: number;
    body: Record<string, unknown> | undefined;
}): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/upload/image")) {
            captured.uploaded += 1;
            return jsonResponse({ name: `ref-${captured.uploaded}.png`, subfolder: "", type: "input" });
        }
        if (url.endsWith("/prompt")) {
            captured.body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
            return jsonResponse({ prompt_id: "edit-1" });
        }
        if (url.includes("/history/edit-1")) {
            return jsonResponse({
                "edit-1": {
                    status: { status_str: "success", completed: true },
                    outputs: {
                        output: { images: [{ filename: "edited.png", subfolder: "", type: "output" }] },
                    },
                },
            });
        }
        if (url.includes("/view?")) {
            return new Response(pngBytes, { status: 200, headers: { "content-type": "image/png" } });
        }
        if (url === "https://example.test/source.png") {
            return new Response(pngBytes, { status: 200, headers: { "content-type": "image/png" } });
        }
        throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;
}

/* ---------------------------------------------------------------------------
 * 1. 修图工具必须提供参考图
 * ------------------------------------------------------------------------- */
{
    const captured = { uploaded: 0, body: undefined as Record<string, unknown> | undefined };
    const provider = new ComfyUIImageEditToolProvider({
        workflow: editWorkflow(),
        fetch: fakeFetch(captured),
    });
    await assert.rejects(
        () => provider.call({
            id: "edit-0",
            name: "editImage",
            params: { prompt: "edit" },
        }),
        /requires at least 1 reference image/,
    );
    assert.equal(captured.uploaded, 0);
    console.log("PASS ComfyUI 修图工具强制参考图");
}

/* ---------------------------------------------------------------------------
 * 2. 修图参数 + 尺寸 switch + 参考图槽位
 * ------------------------------------------------------------------------- */
{
    const captured = { uploaded: 0, body: undefined as Record<string, unknown> | undefined };
    const provider = new ComfyUIImageEditToolProvider({
        workflow: editWorkflow(),
        fetch: fakeFetch(captured),
    });

    const result = await provider.call({
        id: "edit-1",
        name: "editImage",
        params: {
            prompt: "change the background",
            size: "768x512",
            seed: 99,
            negative_prompt: "blurry",
            references: ["https://example.test/source.png"],
        },
    });

    assert.equal(result.status.isSuccess, true);
    assert.equal(captured.uploaded, 1);
    const body = captured.body as { prompt: Record<string, { inputs: Record<string, unknown> }> };
    assert.equal(body.prompt.text?.inputs.prompt, "change the background");
    assert.equal(body.prompt.text?.inputs.negative_prompt, "blurry");
    assert.equal(body.prompt.sampler?.inputs.seed, 99);
    assert.equal(body.prompt.latent?.inputs.width, 768);
    assert.equal(body.prompt.latent?.inputs.height, 512);
    assert.equal(body.prompt["latent-switch"]?.inputs.switch, true);
    assert.deepEqual(body.prompt.text?.inputs["images.image_1"], ["scale", 0]);
    assert.equal(body.prompt.load?.inputs.image, "ref-1.png");
    console.log("PASS ComfyUI 修图参数与尺寸 switch");
}

console.log("\nAll ComfyUI image edit tool checks passed.");
