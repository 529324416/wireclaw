import assert from "node:assert/strict";

import { ComfyUIImageToolProvider } from "../tools/comfyui-image-tool";
import type { ComfyUIWorkflow } from "../tools/comfyui-image-tool";

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function baseWorkflow(): ComfyUIWorkflow {
    return {
        text: {
            class_type: "TextEncodeQwenImage21",
            inputs: {
                prompt: "",
                negative_prompt: "",
                clip: ["clip", 0],
                "images.image_1": ["scale", 0],
            },
        },
        latent: {
            class_type: "EmptyLatentImage",
            inputs: {
                width: ["resolution", 0],
                height: ["resolution", 1],
                batch_size: 1,
            },
        },
        sampler: {
            class_type: "KSampler",
            inputs: {
                seed: 1,
                model: ["model", 0],
            },
        },
        load: {
            class_type: "LoadImage",
            inputs: { image: "old.png" },
        },
        scale: {
            class_type: "ImageScaleToTotalPixels",
            inputs: {
                upscale_method: "nearest-exact",
                megapixels: 0.7,
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

type Captured = {
    uploaded: number;
    promptBody: Record<string, unknown> | undefined;
    promptUrl: string;
};

function fakeFetch(captured: Captured, referenceData: Uint8Array = pngBytes): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/upload/image")) {
            captured.uploaded += 1;
            return new Response(JSON.stringify({ name: `ref-${captured.uploaded}.png`, subfolder: "", type: "input" }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }
        if (url.endsWith("/prompt")) {
            captured.promptUrl = url;
            captured.promptBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
            return new Response(JSON.stringify({ prompt_id: "prompt-1" }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }
        if (url.includes("/history/prompt-1")) {
            return new Response(JSON.stringify({
                "prompt-1": {
                    status: { status_str: "success", completed: true },
                    outputs: {
                        output: {
                            images: [{ filename: "out.png", subfolder: "", type: "output" }],
                        },
                    },
                },
            }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.includes("/view?")) {
            return new Response(referenceData.buffer as ArrayBuffer, {
                status: 200,
                headers: { "content-type": "image/png" },
            });
        }
        if (url === "https://example.test/reference.png") {
            return new Response(referenceData.buffer as ArrayBuffer, {
                status: 200,
                headers: { "content-type": "image/png" },
            });
        }
        throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;
}

/* ---------------------------------------------------------------------------
 * 1. 无参考图：prompt/size/seed/negative 映射，images.* 被移除
 * ------------------------------------------------------------------------- */
{
    const captured: Captured = { uploaded: 0, promptBody: undefined, promptUrl: "" };
    const provider = new ComfyUIImageToolProvider({
        workflow: baseWorkflow(),
        fetch: fakeFetch(captured),
    });

    const result = await provider.call({
        id: "call-1",
        name: "generateImage",
        params: {
            prompt: "a red circle",
            size: "1024x1024",
            seed: 42,
            negative_prompt: "blurry",
        },
    });

    assert.equal(result.status.isSuccess, true);
    const attachment = result.attachments?.[0];
    assert.ok(attachment !== undefined && attachment.kind === "bytes");
    assert.deepEqual([...attachment.data], [...pngBytes]);

    const body = captured.promptBody as {
        prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    assert.equal(body.prompt.text?.inputs.prompt, "a red circle");
    assert.equal(body.prompt.text?.inputs.negative_prompt, "blurry");
    assert.equal(body.prompt.sampler?.inputs.seed, 42);
    assert.equal(body.prompt.latent?.inputs.width, 1024);
    assert.equal(body.prompt.latent?.inputs.height, 1024);
    assert.equal("images.image_1" in (body.prompt.text?.inputs ?? {}), false);
    console.log("PASS ComfyUI 无参考图参数映射");
}

/* ---------------------------------------------------------------------------
 * 2. 一张参考图：上传后接到 images.image_1
 * ------------------------------------------------------------------------- */
{
    const captured: Captured = { uploaded: 0, promptBody: undefined, promptUrl: "" };
    const provider = new ComfyUIImageToolProvider({
        workflow: baseWorkflow(),
        fetch: fakeFetch(captured),
    });

    const result = await provider.call({
        id: "call-2",
        name: "generateImage",
        params: {
            prompt: "edit",
            size: "512x512",
            references: ["https://example.test/reference.png"],
        },
    });
    assert.equal(result.status.isSuccess, true);
    assert.equal(captured.uploaded, 1);

    const body = captured.promptBody as {
        prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    assert.deepEqual(body.prompt.text?.inputs["images.image_1"], ["scale", 0]);
    assert.equal(body.prompt.load?.inputs.image, "ref-1.png");
    assert.equal(body.prompt.latent?.inputs.width, 512);
    console.log("PASS ComfyUI 单参考图上传与映射");
}

/* ---------------------------------------------------------------------------
 * 3. 两张参考图：动态增加 LoadImage + ImageScale 节点
 * ------------------------------------------------------------------------- */
{
    const captured: Captured = { uploaded: 0, promptBody: undefined, promptUrl: "" };
    const provider = new ComfyUIImageToolProvider({
        workflow: baseWorkflow(),
        fetch: fakeFetch(captured),
    });

    const result = await provider.call({
        id: "call-3",
        name: "generateImage",
        params: {
            prompt: "combine",
            references: [
                "https://example.test/reference.png",
                "https://example.test/reference.png",
            ],
        },
    });
    assert.equal(result.status.isSuccess, true);
    assert.equal(captured.uploaded, 2);

    const body = captured.promptBody as {
        prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    assert.ok(Array.isArray(body.prompt.text?.inputs["images.image_2"]));
    const keys = Object.keys(body.prompt);
    assert.ok(keys.some((key) => key.startsWith("wireclaw_load_2")));
    assert.ok(keys.some((key) => key.startsWith("wireclaw_scale_2")));
    console.log("PASS ComfyUI 多参考图动态节点");
}

/* ---------------------------------------------------------------------------
 * 4. 已有多槽位工作流：复用现有 LoadImage/ImageScale，不重复建节点
 * ------------------------------------------------------------------------- */
{
    const workflow = baseWorkflow();
    workflow.text!.inputs["images.image_2"] = ["scale2", 0];
    workflow.load2 = { class_type: "LoadImage", inputs: { image: "slot2.png" } };
    workflow.scale2 = {
        class_type: "ImageScaleToTotalPixels",
        inputs: { upscale_method: "nearest-exact", megapixels: 0.7, resolution_steps: 1, image: ["load2", 0] },
    };

    const captured: Captured = { uploaded: 0, promptBody: undefined, promptUrl: "" };
    const provider = new ComfyUIImageToolProvider({
        workflow,
        fetch: fakeFetch(captured),
    });

    const result = await provider.call({
        id: "call-4",
        name: "generateImage",
        params: {
            prompt: "reuse slots",
            references: [
                "https://example.test/reference.png",
                "https://example.test/reference.png",
            ],
        },
    });
    assert.equal(result.status.isSuccess, true);
    assert.equal(captured.uploaded, 2);

    const body = captured.promptBody as {
        prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    assert.deepEqual(body.prompt.text?.inputs["images.image_1"], ["scale", 0]);
    assert.deepEqual(body.prompt.text?.inputs["images.image_2"], ["scale2", 0]);
    assert.equal(body.prompt.load?.inputs.image, "ref-1.png");
    assert.equal(body.prompt.load2?.inputs.image, "ref-2.png");
    assert.equal(
        Object.keys(body.prompt).some((key) => key.startsWith("wireclaw_load_")),
        false,
    );
    console.log("PASS ComfyUI 复用已有参考图槽位");
}

/* ---------------------------------------------------------------------------
 * 5. 16 槽位工作流：全部参考图槽位可用
 * ------------------------------------------------------------------------- */
{
    const workflow = baseWorkflow();
    for (let index = 2; index <= 16; index += 1){
        workflow[`load${index}`] = {
            class_type: "LoadImage",
            inputs: { image: `slot${index}.png` },
        };
        workflow[`scale${index}`] = {
            class_type: "ImageScaleToTotalPixels",
            inputs: {
                upscale_method: "nearest-exact",
                megapixels: 0.7,
                resolution_steps: 1,
                image: [`load${index}`, 0],
            },
        };
        workflow.text!.inputs[`images.image_${index}`] = [`scale${index}`, 0];
    }

    const captured: Captured = { uploaded: 0, promptBody: undefined, promptUrl: "" };
    const provider = new ComfyUIImageToolProvider({
        workflow,
        fetch: fakeFetch(captured),
    });

    const references = Array.from({ length: 16 }, () => "https://example.test/reference.png");
    const result = await provider.call({
        id: "call-5",
        name: "generateImage",
        params: { prompt: "sixteen references", references },
    });
    assert.equal(result.status.isSuccess, true);
    assert.equal(captured.uploaded, 16);

    const body = captured.promptBody as {
        prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    assert.deepEqual(body.prompt.text?.inputs["images.image_16"], ["scale16", 0]);
    assert.equal(body.prompt.load16?.inputs.image, "ref-16.png");
    assert.equal("images.image_17" in (body.prompt.text?.inputs ?? {}), false);
    console.log("PASS ComfyUI 16 参考图槽位");
}

console.log("\nAll ComfyUI image tool checks passed.");
