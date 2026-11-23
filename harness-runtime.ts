import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
    HarnessBuiltinNodeType,
    createBuiltinNodeRegistry,
} from "./src/harness";
import type { NodeOutputValues } from "./src/harness";
import { applyQwenReferenceModelOverrides } from "./src/client";
import { LocalFileHost, readLocalSourcePath } from "./src/file/local";
import {
    QWEN_DEFAULT_BASE_URL,
    QwenChatProvider,
} from "./src/platform/index";
import { AttachmentFileManager, ToolRegistry } from "./src/session/index";
import { ComfyUIImageToolProvider } from "./tools/comfyui-image-tool";
import type { ComfyUIWorkflow } from "./tools/comfyui-image-tool";

export type PipelineRuntime = {
    provider: QwenChatProvider;
    attachments: AttachmentFileManager;
    tools: ToolRegistry;
    registry: ReturnType<typeof createBuiltinNodeRegistry>;
};

export async function readQwenApiKey(): Promise<string>{
    const configured = process.env.DASHSCOPE_API_KEY?.trim()
        ?? process.env.QWEN_API_KEY?.trim();
    if (configured !== undefined && configured.length > 0) return configured;

    const keyPath = resolve(
        process.cwd(),
        process.env.QWEN_API_KEY_FILE ?? "apikey-qwen.txt",
    );
    const raw = await readFile(keyPath, "utf8");
    let key = raw.replace(/^\uFEFF/, "").trim();
    const assignment = /^(?:DASHSCOPE_API_KEY|QWEN_API_KEY)\s*=\s*(.+)$/m.exec(key);
    if (assignment !== null) key = assignment[1]?.trim() ?? "";
    key = key.replace(/^["']|["']$/g, "").trim();

    if (key.length === 0){
        throw new Error(`Qwen API key file is empty: ${keyPath}`);
    }
    return key;
}

export async function createPipelineRuntime(): Promise<PipelineRuntime>{
    const apiKey = await readQwenApiKey();
    const provider = new QwenChatProvider({
        apiKey,
        baseUrl: process.env.QWEN_BASE_URL ?? QWEN_DEFAULT_BASE_URL,
        model: process.env.HARNESS_PROMPT_MODEL ?? "qwen-plus",
    });
    applyQwenReferenceModelOverrides(provider);

    const fileHost = new LocalFileHost(resolve(process.cwd(), ".wireclaw-files/harness"));
    const attachments = new AttachmentFileManager(fileHost, {
        readSourcePath: readLocalSourcePath,
    });

    const tools = new ToolRegistry({
        onProviderError: (providerId, error) =>{
            console.error(`[tool:${providerId}] ${String(error)}`);
        },
    });

    const workflowPath = resolve(
        process.cwd(),
        process.env.WIRECLAW_COMFYUI_WORKFLOW ?? "examples/comfyui/qwen-image-2.1-t2i.json",
    );
    const workflow = JSON.parse(await readFile(workflowPath, "utf8")) as ComfyUIWorkflow;
    tools.registerProvider(new ComfyUIImageToolProvider({
        workflow,
        baseUrl: process.env.COMFYUI_BASE_URL ?? "http://127.0.0.1:8188",
        timeoutMs: Number(process.env.WIRECLAW_COMFYUI_TIMEOUT_MS ?? "600000"),
        adviceTimeoutMs: 600_000,
    }));

    return {
        provider,
        attachments,
        tools,
        registry: createBuiltinNodeRegistry(),
    };
}

export function textOf(outputs: NodeOutputValues, port: string): string{
    const value = outputs[port];
    return value?.type === "text" ? value.text : "";
}

export function modelNode(
    registry: PipelineRuntime["registry"],
    id: string,
    modelId: string,
) {
    return registry.createNode({
        id,
        type: HarnessBuiltinNodeType.Model,
        typeVersion: 1,
        config: { providerId: "qwen", modelId },
    });
}
