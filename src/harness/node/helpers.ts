import { AssistantMessage } from "../../session/message";
import type { Message } from "../../session/message";
import type {
    AttachmentRef,
    ChatUsage,
    ContentPart,
    MessageContent,
} from "../../session/type";
import { HarnessError, HarnessErrorCode } from "../base/error";
import { isRecord } from "../base/utils";
import type {
    HarnessValue,
    JsonObject,
    JsonValue,
    ModelBinding,
    NodeInputValues,
    ProviderRef,
    ToolSetSpec,
} from "../graph/type";
import { isProviderRef } from "../graph/type";

export function readConfig(
    config: JsonValue | undefined,
    nodeType: string,
): Record<string, unknown>{
    if (config === undefined) return {};
    if (!isRecord(config)){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${nodeType} config must be an object`,
        );
    }
    return config;
}

export function readOptionalString(
    config: Record<string, unknown>,
    key: string,
    nodeType: string,
): string | undefined{
    const value = config[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string"){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${nodeType}.${key} must be a string`,
        );
    }
    return value;
}

export function readRequiredString(
    config: Record<string, unknown>,
    key: string,
    nodeType: string,
): string{
    const value = readOptionalString(config, key, nodeType);
    if (value === undefined || value.length === 0){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${nodeType}.${key} must be a non-empty string`,
        );
    }
    return value;
}

export function readOptionalBoolean(
    config: Record<string, unknown>,
    key: string,
    nodeType: string,
): boolean | undefined{
    const value = config[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean"){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${nodeType}.${key} must be a boolean`,
        );
    }
    return value;
}

export function readOptionalPositiveInteger(
    config: Record<string, unknown>,
    key: string,
    nodeType: string,
): number | undefined{
    const value = config[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${nodeType}.${key} must be a positive integer`,
        );
    }
    return value;
}

export function requireModelBinding(value: HarnessValue | undefined): ModelBinding{
    if (value === undefined || value.type !== "model"){
        throw new HarnessError(
            HarnessErrorCode.InvalidValue,
            "Node input \"model\" must be a model binding",
        );
    }
    return value.model;
}

export function requireProviderRef(value: HarnessValue | undefined): ProviderRef{
    if (value === undefined || value.type !== "provider" || !isProviderRef(value.provider)){
        throw new HarnessError(
            HarnessErrorCode.InvalidValue,
            "Node input \"provider\" must be a provider reference",
        );
    }
    return value.provider;
}

export function readBooleanCondition(value: HarnessValue | undefined): boolean{
    if (value?.type === "json" && typeof value.value === "boolean"){
        return value.value;
    }
    if (value?.type === "text"){
        const normalized = value.text.trim().toLowerCase();
        if (normalized === "true") return true;
        if (normalized === "false") return false;
    }

    throw new HarnessError(
        HarnessErrorCode.InvalidValue,
        "Condition must be a boolean json value (or \"true\"/\"false\" text)",
    );
}

export function requireText(value: HarnessValue | undefined, port: string): string{
    if (value === undefined || value.type !== "text"){
        throw new HarnessError(
            HarnessErrorCode.InvalidValue,
            `Node input "${port}" must be text`,
        );
    }
    return value.text;
}

/** 文本端口值；用于覆盖同名的 string config 字段。 */
export function textInputValue(value: HarnessValue, port: string): string{
    if (value.type !== "text"){
        throw new HarnessError(
            HarnessErrorCode.InvalidValue,
            `Node input "${port}" must be text`,
        );
    }
    return value.text;
}

/** JSON 端口值；用于覆盖同名的 object / number / boolean config 字段。 */
export function jsonInputValue(value: HarnessValue, port: string): JsonValue{
    if (value.type !== "json"){
        throw new HarnessError(
            HarnessErrorCode.InvalidValue,
            `Node input "${port}" must be json`,
        );
    }
    return value.value;
}

/**
 * 端口值覆盖 config 字段：连接存在时以端口为准，未连接时沿用 config。
 *
 * 只覆盖 mapping 中列出的端口；转换函数负责端口类型校验，
 * 合并后的 config 继续走原有的 config 校验代码。
 */
export function applyInputOverrides(
    config: Record<string, unknown>,
    inputs: NodeInputValues,
    mapping: Readonly<Record<string, (value: HarnessValue) => unknown>>,
): Record<string, unknown>{
    let next = config;
    for (const [port, convert] of Object.entries(mapping)){
        const value = inputs[port];
        if (value === undefined) continue;
        if (next === config) next = { ...config };
        next[port] = convert(value);
    }
    return next;
}

/**
 * 模型绑定：优先 `model` 端口，未连接时回退 config 的 providerId / modelId。
 */
export function resolveModelBinding(
    value: HarnessValue | undefined,
    config: Record<string, unknown>,
    nodeType: string,
): ModelBinding{
    if (value !== undefined) return requireModelBinding(value);
    return {
        providerId: readRequiredString(config, "providerId", nodeType),
        modelId: readRequiredString(config, "modelId", nodeType),
    };
}

/**
 * 附件引用：未连接 attachments 端口时读取 config.attachments（只保留 contentHash）。
 */
export function readAttachmentRefs(
    config: Record<string, unknown>,
    nodeType: string,
): readonly AttachmentRef[]{
    const value = config.attachments;
    if (value === undefined) return [];
    if (!Array.isArray(value)){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${nodeType}.attachments must be an array`,
        );
    }

    const refs: AttachmentRef[] = [];
    for (const item of value){
        if (!isRecord(item) || typeof item.contentHash !== "string"
            || item.contentHash.length === 0){
            throw new HarnessError(
                HarnessErrorCode.InvalidNode,
                `${nodeType}.attachments[].contentHash must be a non-empty string`,
            );
        }
        refs.push({ contentHash: item.contentHash });
    }
    return refs;
}

/** ToolSetSpec：未连接 toolset 端口时读取 config.toolset。 */
export function readToolSetSpec(
    value: unknown,
    nodeType: string,
): ToolSetSpec | undefined{
    if (value === undefined) return undefined;
    if (!isRecord(value)){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${nodeType}.toolset must be an object`,
        );
    }

    const include = readStringList(value.include, `${nodeType}.toolset.include`);
    const exclude = readStringList(value.exclude, `${nodeType}.toolset.exclude`);
    const hostTools = readHostToolFlags(value.hostTools, `${nodeType}.toolset.hostTools`);

    return {
        ...(include === undefined ? {} : { include }),
        ...(exclude === undefined ? {} : { exclude }),
        ...(hostTools === undefined ? {} : { hostTools }),
    };
}

function readStringList(value: unknown, label: string): readonly string[] | undefined{
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${label} must be an array of strings`,
        );
    }
    return value as string[];
}

function readHostToolFlags(
    value: unknown,
    label: string,
): { askUser?: boolean; viewMedia?: boolean } | undefined{
    if (value === undefined) return undefined;
    if (!isRecord(value)){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${label} must be an object`,
        );
    }
    const askUser = value.askUser;
    const viewMedia = value.viewMedia;
    if (askUser !== undefined && typeof askUser !== "boolean"){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${label}.askUser must be a boolean`,
        );
    }
    if (viewMedia !== undefined && typeof viewMedia !== "boolean"){
        throw new HarnessError(
            HarnessErrorCode.InvalidNode,
            `${label}.viewMedia must be a boolean`,
        );
    }
    return {
        ...(askUser === undefined ? {} : { askUser }),
        ...(viewMedia === undefined ? {} : { viewMedia }),
    };
}

export function attachmentRefs(value: HarnessValue | undefined): readonly AttachmentRef[]{
    if (value === undefined) return [];
    if (value.type === "attachments") return value.attachments;
    if (value.type === "attachment") return [value.attachment];
    throw new HarnessError(
        HarnessErrorCode.InvalidValue,
        "Node input \"attachments\" must be attachments",
    );
}

export function buildUserContent(
    text: string,
    attachments: readonly AttachmentRef[],
): MessageContent{
    if (attachments.length === 0) return text;

    const parts: ContentPart[] = [];
    if (text.length > 0) parts.push({ type: "text", text });
    for (const attachment of attachments){
        parts.push({ type: "attachment", attachment });
    }
    return parts;
}

export function contentToText(content: MessageContent): string{
    if (typeof content === "string") return content;
    return content
        .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

export function contentAttachments(content: MessageContent): readonly AttachmentRef[]{
    if (typeof content === "string") return [];
    return content
        .filter((part): part is Extract<ContentPart, { type: "attachment" }> =>
            part.type === "attachment")
        .map((part) => part.attachment);
}

export function findLastAssistant(
    messages: readonly Message[],
): AssistantMessage | undefined{
    for (let index = messages.length - 1; index >= 0; index -= 1){
        const message = messages[index];
        if (message instanceof AssistantMessage) return message;
    }
    return undefined;
}

export function usageToJson(usage: ChatUsage): JsonObject{
    return {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
    };
}

export function errorText(error: unknown): string{
    return error instanceof Error ? error.message : String(error);
}
