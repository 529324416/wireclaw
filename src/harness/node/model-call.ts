import type { PendingAttachment } from "../../session/media";
import { AttachmentIngestor } from "../../session/attachment-ingestor";
import { HarnessBuiltinNodeType } from "../definition";
import { HarnessError, HarnessErrorCode } from "../base/error";
import { isRecord } from "../base/utils";
import { GraphNode } from "../graph/node";
import type { NodeContext } from "../graph/node";
import type {
    HarnessValue,
    InputPortSpec,
    ModelBinding,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "../graph/type";
import type { AttachmentRef } from "../../session/type";
import { isGenerationProvider, isChatProvider } from "../../session/protocol";
import type { GenerationModality } from "../../session/protocol";
import { system } from "../../session/message";
import { RunStatus, Session, SessionHistory } from "../../session/session";
import type { Run } from "../../session/session";
import { SessionEventType, SessionPermission } from "../../session/type";
import type { SessionRuntimeOptions } from "../../session/type";
import {
    applyInputOverrides,
    attachmentRefs,
    buildUserContent,
    contentAttachments,
    contentToText,
    errorText,
    findLastAssistant,
    jsonInputValue,
    readAttachmentRefs,
    readConfig,
    readOptionalBoolean,
    readOptionalString,
    readRequiredString,
    requireText,
    resolveModelBinding,
    textInputValue,
    usageToJson,
} from "./helpers";

const MODEL_CALL = HarnessBuiltinNodeType.ModelCall;

/** A 类节点：一次模型调用，无工具、无循环 */
export class ModelCallNode extends GraphNode{

    override readonly type = MODEL_CALL;

    override get inputs(): readonly InputPortSpec[]{
        return [
            { name: "model", type: "model" },
            { name: "prompt", type: "text" },
            { name: "system", type: "text" },
            { name: "parameters", type: "json" },
            { name: "attachments", type: "attachments" },
        ];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [
            {
                name: "text",
                type: "text",
                supportedModes: ["value", "stream"],
                defaultMode: "value",
            },
            {
                name: "attachments",
                type: "attachments",
                supportedModes: ["value"],
                defaultMode: "value",
            },
            {
                name: "usage",
                type: "json",
                supportedModes: ["value"],
                defaultMode: "value",
            },
            {
                name: "thinking",
                type: "text",
                supportedModes: ["value", "stream"],
                defaultMode: "value",
            },
        ];
    }

    override async execute(
        ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const config = applyInputOverrides(readConfig(this.config, this.type), inputs, {
            system: (value) => textInputValue(value, "system"),
            parameters: (value) => jsonInputValue(value, "parameters"),
        });
        const mode = readMode(config);
        const binding = resolveModelBinding(inputs.model, config, this.type);
        const prompt = inputs.prompt === undefined
            ? readRequiredString(config, "prompt", this.type)
            : requireText(inputs.prompt, "prompt");
        const refs = inputs.attachments === undefined
            ? readAttachmentRefs(config, this.type)
            : attachmentRefs(inputs.attachments);
        const systemPrompt = mode === "chat"
            ? readOptionalString(config, "system", this.type)
            : undefined;
        const startedAt = Date.now();

        try{
            if (mode === "generate"){
                return await this._generate(ctx, binding, prompt, refs, config, startedAt);
            }
            return await this._chat(
                ctx,
                binding,
                prompt,
                refs,
                config,
                systemPrompt,
                startedAt,
            );
        }catch(error){
            ctx.collect({
                kind: "model-call",
                providerId: binding.providerId,
                modelId: binding.modelId,
                mode,
                status: "failed",
                startedAt,
                endedAt: Date.now(),
                input: {
                    prompt,
                    ...(systemPrompt === undefined ? {} : { system: systemPrompt }),
                    ...(refs.length === 0 ? {} : { attachments: [...refs] }),
                },
                error: errorText(error),
            });
            throw error;
        }
    }

    private async _chat(
        ctx: NodeContext,
        binding: ModelBinding,
        prompt: string,
        refs: readonly AttachmentRef[],
        config: Record<string, unknown>,
        systemPrompt: string | undefined,
        startedAt: number,
    ): Promise<NodeOutputValues>{
        const provider = ctx.services.resolveModel(binding);
        if (!isChatProvider(provider)){
            throw new HarnessError(
                HarnessErrorCode.InvalidNode,
                `Model "${binding.modelId}" does not support chat`,
                { nodeId: this.id },
            );
        }

        const history = new SessionHistory(
            undefined,
            systemPrompt === undefined ? [] : [system(systemPrompt)],
        );
        const runtimeOptions = readRuntimeOptions(config, binding);
        const session = new Session(
            provider,
            history,
            runtimeOptions,
            ctx.services.attachments,
            { hostTools: false },
        );

        const unsubscribe = session.subscribe((event) =>{
            if (event.type !== SessionEventType.ASSISTANT_TOKEN) return;
            ctx.emit(event.isThinking ? "thinking" : "text", {
                type: "text",
                text: event.token,
            });
        });

        let run: Run;
        try{
            run = await session.run(
                buildUserContent(prompt, refs),
                {
                    maxSteps: 1,
                    permission: SessionPermission.ReadOnly,
                    enableUserInput: false,
                    toolProgressDelayMs: 0,
                },
            );
        }finally{
            unsubscribe();
        }

        if (run.status !== RunStatus.Completed){
            throw new HarnessError(
                HarnessErrorCode.NodeExecutionFailed,
                `A 类模型调用失败: ${run.error === undefined ? run.status : errorText(run.error)}`,
                { nodeId: this.id, origin: run.error },
            );
        }

        const assistant = findLastAssistant(run.pendingMessages);
        if (assistant === undefined){
            throw new HarnessError(
                HarnessErrorCode.NodeExecutionFailed,
                "A 类模型调用没有返回 assistant 消息",
                { nodeId: this.id },
            );
        }

        const outputs: Record<string, HarnessValue> = {
            text: { type: "text", text: contentToText(assistant.content) },
            attachments: {
                type: "attachments",
                attachments: contentAttachments(assistant.content),
            },
            usage: { type: "json", value: usageToJson(assistant.usage) },
        };
        if (assistant.thinking !== undefined){
            outputs.thinking = { type: "text", text: assistant.thinking };
        }

        const outputAttachments = contentAttachments(assistant.content);
        ctx.collect({
            kind: "model-call",
            providerId: binding.providerId,
            modelId: binding.modelId,
            mode: "chat",
            status: "completed",
            startedAt,
            endedAt: Date.now(),
            input: {
                prompt,
                ...(systemPrompt === undefined ? {} : { system: systemPrompt }),
                ...(refs.length === 0 ? {} : { attachments: [...refs] }),
            },
            output: {
                text: contentToText(assistant.content),
                ...(assistant.thinking === undefined
                    ? {}
                    : { thinking: assistant.thinking }),
                ...(outputAttachments.length === 0
                    ? {}
                    : { attachments: [...outputAttachments] }),
                usage: assistant.usage,
                ...(assistant.stopReason === undefined
                    ? {}
                    : { stopReason: assistant.stopReason }),
                ...(assistant.failureReason === undefined
                    ? {}
                    : { failureReason: assistant.failureReason }),
            },
        });
        return outputs;
    }

    private async _generate(
        ctx: NodeContext,
        binding: ModelBinding,
        prompt: string,
        refs: readonly AttachmentRef[],
        config: Record<string, unknown>,
        startedAt: number,
    ): Promise<NodeOutputValues>{
        const provider = ctx.services.resolveModel(binding);
        if (!isGenerationProvider(provider)){
            throw new HarnessError(
                HarnessErrorCode.InvalidNode,
                `Model "${binding.modelId}" does not support generation`,
                { nodeId: this.id },
            );
        }

        const manager = ctx.services.attachments;
        if (manager === undefined){
            throw new HarnessError(
                HarnessErrorCode.InvalidRequest,
                "Generation requires an AttachmentFileManager",
                { nodeId: this.id },
            );
        }

        const referenceFiles = [];
        for (const ref of refs){
            const file = await manager.get(ref.contentHash);
            if (file === undefined){
                throw new HarnessError(
                    HarnessErrorCode.MissingValue,
                    `Generation reference "${ref.contentHash}" is missing`,
                    { nodeId: this.id },
                );
            }
            referenceFiles.push(file);
        }

        const modality = readModality(config);
        const parameters = readParameters(config);
        const task = await provider.generate({
            modality,
            prompt,
            references: refs,
            referenceFiles,
            ...(parameters === undefined ? {} : { parameters }),
        }, { signal: ctx.signal });

        const media = await task.wait({ signal: ctx.signal });
        const ingestor = new AttachmentIngestor(manager);
        const attachments: AttachmentRef[] = [];
        for (const item of media){
            const pending: PendingAttachment = { ...item, origin: "generation" };
            const ref = await ingestor.ingest(pending, { signal: ctx.signal });
            attachments.push(ref);
        }

        ctx.collect({
            kind: "model-call",
            providerId: binding.providerId,
            modelId: binding.modelId,
            mode: "generate",
            status: "completed",
            startedAt,
            endedAt: Date.now(),
            input: {
                prompt,
                ...(refs.length === 0 ? {} : { attachments: [...refs] }),
            },
            output: {
                text: "",
                ...(attachments.length === 0 ? {} : { attachments: [...attachments] }),
            },
        });

        return {
            text: { type: "text", text: "" },
            attachments: { type: "attachments", attachments },
        };
    }
}

function readMode(config: Record<string, unknown>): "chat" | "generate"{
    const value = config.mode;
    if (value === undefined) return "chat";
    if (value !== "chat" && value !== "generate"){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${MODEL_CALL}.mode must be "chat" or "generate"`,
        );
    }
    return value;
}

function readModality(config: Record<string, unknown>): GenerationModality{
    const value = config.modality;
    if (value === undefined) return "image";
    if (value !== "image" && value !== "audio" && value !== "video"){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${MODEL_CALL}.modality must be image, audio or video`,
        );
    }
    return value;
}

function readParameters(
    config: Record<string, unknown>,
): Record<string, unknown> | undefined{
    const value = config.parameters;
    if (value === undefined) return undefined;
    if (!isRecord(value)){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${MODEL_CALL}.parameters must be an object`,
        );
    }
    return value;
}

function readRuntimeOptions(
    config: Record<string, unknown>,
    binding: ModelBinding,
): SessionRuntimeOptions{
    const think = readOptionalBoolean(config, "think", MODEL_CALL);
    const thinkingLv = config.thinkingLv;
    if (thinkingLv !== undefined
        && typeof thinkingLv !== "string"
        && typeof thinkingLv !== "number"){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${MODEL_CALL}.thinkingLv must be a string or number`,
        );
    }

    const temperature = config.temperature;
    if (temperature !== undefined && typeof temperature !== "number"){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${MODEL_CALL}.temperature must be a number`,
        );
    }

    return {
        model: binding.modelId,
        ...(think === undefined ? {} : { think }),
        ...(thinkingLv === undefined ? {} : { thinkingLv }),
        ...(temperature === undefined ? {} : { temperature }),
    };
}
