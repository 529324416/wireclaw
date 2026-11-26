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
    ProviderRef,
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
