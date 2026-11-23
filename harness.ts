import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
    Edge,
    Graph,
    HarnessBuiltinNodeType,
} from "./src/harness";
import type {
    GraphEvent,
    GraphRunResult,
} from "./src/harness";
import {
    createPipelineRuntime,
    modelNode,
    textOf,
} from "./harness-runtime";
import type { PipelineRuntime } from "./harness-runtime";

const DEFAULT_TOPIC = "雨夜书店里，一只橘猫趴在窗边看书，暖色台灯，赛博朋克城市倒影";
const DEFAULT_PROMPT_MODEL = "qwen-plus";
const DEFAULT_IMAGE_MODEL = "qwen-plus";
const DEFAULT_VISION_MODEL = "qwen3-vl-plus";
const IMAGE_TOOL = "comfyui-image__generateImage";

const PROMPT_SYSTEM = [
    "You are an art director.",
    "Turn the user's Chinese idea into one vivid English image-generation prompt.",
    "Keep it under 60 words. Return only the prompt, no quotes or explanation.",
].join(" ");

const IMAGE_SYSTEM = [
    "You are the image production stage of a local pipeline.",
    `You must call the tool ${IMAGE_TOOL} exactly once with the prompt you receive.`,
    "Do not ask questions and do not answer before the tool call.",
    "After the tool returns, reply with one short sentence describing the result.",
].join(" ");

const CAPTION_SYSTEM = [
    "You are an art critic.",
    "Look at the generated image and write a concise Chinese caption in 2 sentences.",
    "Mention subject, style and mood. Do not explain the pipeline.",
].join(" ");

function createPipelineGraph(runtime: PipelineRuntime): Graph{
    const registry = runtime.registry;
    const promptModel = modelNode(
        registry,
        "promptModel",
        process.env.HARNESS_PROMPT_MODEL ?? DEFAULT_PROMPT_MODEL,
    );
    const imageModel = modelNode(
        registry,
        "imageModel",
        process.env.HARNESS_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL,
    );
    const visionModel = modelNode(
        registry,
        "visionModel",
        process.env.HARNESS_VISION_MODEL ?? DEFAULT_VISION_MODEL,
    );

    const input = registry.createNode({
        id: "input",
        type: HarnessBuiltinNodeType.Input,
        typeVersion: 1,
    });
    const prompt = registry.createNode({
        id: "prompt",
        type: HarnessBuiltinNodeType.ModelCall,
        typeVersion: 1,
        config: { system: PROMPT_SYSTEM, temperature: 0.7 },
    });
    const image = registry.createNode({
        id: "image",
        type: HarnessBuiltinNodeType.AgentRun,
        typeVersion: 1,
        config: {
            system: IMAGE_SYSTEM,
            permission: "full",
            maxSteps: 4,
            hostTools: false,
        },
    });
    const toolset = registry.createNode({
        id: "toolset",
        type: HarnessBuiltinNodeType.ToolSet,
        typeVersion: 1,
        config: {
            include: [IMAGE_TOOL],
        },
    });
    const caption = registry.createNode({
        id: "caption",
        type: HarnessBuiltinNodeType.ModelCall,
        typeVersion: 1,
        config: { system: CAPTION_SYSTEM, temperature: 0.4 },
    });
    const output = registry.createNode({
        id: "output",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });

    return new Graph([
        promptModel,
        imageModel,
        visionModel,
        input,
        prompt,
        image,
        toolset,
        caption,
        output,
    ], [
        new Edge({ nodeId: "input", port: "text" }, { nodeId: "prompt", port: "prompt" }),
        new Edge({ nodeId: "promptModel", port: "model" }, { nodeId: "prompt", port: "model" }),
        new Edge({ nodeId: "prompt", port: "text" }, { nodeId: "image", port: "input" }),
        new Edge({ nodeId: "imageModel", port: "model" }, { nodeId: "image", port: "model" }),
        new Edge({ nodeId: "toolset", port: "toolset" }, { nodeId: "image", port: "toolset" }),
        new Edge({ nodeId: "prompt", port: "text" }, { nodeId: "caption", port: "prompt" }),
        new Edge({ nodeId: "image", port: "attachments" }, { nodeId: "caption", port: "attachments" }),
        new Edge({ nodeId: "visionModel", port: "model" }, { nodeId: "caption", port: "model" }),
        new Edge({ nodeId: "caption", port: "text" }, { nodeId: "output", port: "text" }),
        new Edge({ nodeId: "image", port: "attachments" }, { nodeId: "output", port: "attachments" }),
    ], {
        id: "local-image-pipeline",
        title: "Local image pipeline",
        toolSet: {
            include: [IMAGE_TOOL],
            hostTools: { askUser: false, viewMedia: false },
        },
    });
}

function nodeText(events: readonly GraphEvent[], nodeId: string): string{
    for (let index = events.length - 1; index >= 0; index -= 1){
        const event = events[index];
        if (event?.type === "node:end" && event.nodeId === nodeId){
            return textOf(event.outputs, "text");
        }
    }
    return "";
}

async function saveArtifacts(
    runtime: PipelineRuntime,
    result: GraphRunResult,
    topic: string,
    prompt: string,
): Promise<{ imagePath?: string; captionPath: string }>{
    const outputDir = resolve(process.cwd(), "harness-output");
    await mkdir(outputDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    const caption = textOf(result.outputs, "text");
    const captionPath = resolve(outputDir, `${stamp}-caption.txt`);
    await writeFile(
        captionPath,
        `topic:\n${topic}\n\nprompt:\n${prompt}\n\ncaption:\n${caption}\n`,
        "utf8",
    );

    let imagePath: string | undefined;
    const attachments = result.outputs.attachments;
    if (attachments?.type === "attachments" && attachments.attachments.length > 0){
        const first = attachments.attachments[0];
        if (first !== undefined){
            const file = await runtime.attachments.get(first.contentHash);
            if (file !== undefined){
                const extension = file.mimeType === "image/jpeg" ? "jpg" : "png";
                imagePath = resolve(outputDir, `${stamp}-image.${extension}`);
                await writeFile(imagePath, file.content);
            }
        }
    }

    return { imagePath, captionPath };
}

async function main(): Promise<void>{
    const topic = process.argv.slice(2).join(" ").trim() || DEFAULT_TOPIC;
    console.log(`[harness] topic: ${topic}`);
    console.log("[harness] preparing Qwen provider, ComfyUI tool and attachment store...");

    const runtime = await createPipelineRuntime();
    const graph = createPipelineGraph(runtime);
    graph.assertValid();

    const events: GraphEvent[] = [];
    const started = Date.now();
    const result = await graph.run({
        host: {
            resolveProvider: (id) => id === "qwen" ? runtime.provider : undefined,
            tools: runtime.tools,
            attachments: runtime.attachments,
            onToolApproval: (request, nodeId) =>{
                console.log(`[approval] ${nodeId}: ${request.call.name}`);
                return "approve";
            },
            log: (level, message) =>{
                if (level !== "debug") console.log(`[${level}] ${message}`);
            },
        },
        input: { text: topic },
        listener: (event) =>{
            events.push(event);
            if (event.type === "node:start"){
                console.log(`[node:start] ${event.nodeId}`);
            }
            if (event.type === "node:end"){
                console.log(`[node:end]   ${event.nodeId}`);
            }
        },
    }).done;

    if (result.status !== "completed"){
        throw result.error ?? new Error(`pipeline ended with ${result.status}`);
    }

    const caption = textOf(result.outputs, "text");
    const prompt = nodeText(events, "prompt");
    const artifacts = await saveArtifacts(runtime, result, topic, prompt);
    console.log("");
    console.log(`[harness] completed in ${String(Date.now() - started)}ms`);
    console.log(`[harness] image prompt: ${prompt}`);
    console.log(`[harness] caption: ${caption}`);
    console.log(`[harness] caption file: ${artifacts.captionPath}`);
    if (artifacts.imagePath !== undefined){
        console.log(`[harness] image file: ${artifacts.imagePath}`);
    } else {
        throw new Error("pipeline completed without a generated image attachment");
    }
}

await main();
