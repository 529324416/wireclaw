import { toBase64, uniqueId } from "../../../base";
import { detectImageMimeType, normalizeImageMimeType } from "../../../file";
import { SessionError, SessionErrorType } from "../../../session/error";
import { AssistantMessage, ToolMessage } from "../../../session/message";
import type { Message } from "../../../session/message";
import { ProtocolAdapter } from "../../../session/protocol";
import { ChatFailureReason, ChatStopReason } from "../../../session/type";
import type {
    AttachmentWireMap,
    ChatUsage,
    MessageContent,
    RemoteFileRef,
    StreamChunk,
    ToolCall,
} from "../../../session/type";

/** OpenAI 兼容消息中的内容块 */
export type OpenAIContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail?: string } }
    | { type: "input_audio"; input_audio: { data: string; format: string } }
    | { type: "video_url"; video_url: { url: string } }
    | { type: "file"; file_id?: string; file_data?: string; filename?: string };

/** OpenAI 兼容 chat message；各平台可以在此基础上扩展字段 */
export type OpenAIChatMessage = {
    role: string;
    content: string | OpenAIContentPart[] | null;
    reasoning_content?: string;
    tool_calls?: OpenAIToolCall[];
    tool_call_id?: string;
    name?: string;
    [key: string]: unknown;
};

export type OpenAIToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
};

export type OpenAIProtocolAdapterOptions = {
    /** 平台名称，用于默认错误消息 */
    label: string;

    /** 是否允许 user 消息携带附件；false 时遇到附件直接报错，默认 true */
    supportsAttachments?: boolean;

    /** 思考内容所在的 delta/message 字段；null 表示该平台没有思考内容 */
    thinkingField?: string | null;

    /** 附件错误消息；默认 `${label} does not support attachments in ${context}` */
    attachmentText?: (context: string) => string;
};

/**
 * OpenAI 兼容协议适配器基类。
 *
 * 负责消息/工具/流式片段的公共转换；平台差异通过覆写受保护方法表达：
 * - 附件编码：attachmentPart
 * - 非流式工具解析：parseToolCalls
 * - 用量/结束原因映射：parseUsage / parseStopReason
 * - 其他 delta 字段：parseDeltaExtras
 */
export class OpenAIProtocolAdapter extends ProtocolAdapter{

    protected readonly label: string;
    private readonly _supportsAttachments: boolean;
    private readonly _thinkingField: string | null;
    private readonly _attachmentText: (context: string) => string;

    constructor(options: OpenAIProtocolAdapterOptions){
        super();
        this.label = options.label;
        this._supportsAttachments = options.supportsAttachments ?? true;
        this._thinkingField = options.thinkingField === undefined
            ? "reasoning_content"
            : options.thinkingField;
        this._attachmentText = options.attachmentText
            ?? ((context: string) => `${this.label} does not support attachments in ${context}`);
    }

    override toPayload(msg: Message, attachmentRefs?: AttachmentWireMap): OpenAIChatMessage{
        switch (msg.role){
            case "system":
                return {
                    role: "system",
                    content: this.convertText(msg.content, "system messages"),
                };

            case "user":
                return {
                    role: "user",
                    content: this.convertUserContent(msg.content, attachmentRefs),
                };

            case "assistant":
                return this.assistantPayload(msg as AssistantMessage);

            case "tool":
                return this.toolPayload(msg as ToolMessage);

            default:
                throw new SessionError(
                    SessionErrorType.InvalidData,
                    `Unsupported ${this.label} message role: ${msg.role}`,
                );
        }
    }

    override toAssistantMessage(payload: unknown): AssistantMessage{
        if (!isRecord(payload)){
            throw new SessionError(
                SessionErrorType.ProviderError,
                `Invalid ${this.label} response`,
            );
        }

        const apiError = readPayloadError(payload);
        if (apiError !== undefined){
            throw new SessionError(SessionErrorType.ProviderError, apiError);
        }

        const choice = firstChoice(payload);
        if (choice === undefined){
            throw new SessionError(
                SessionErrorType.ProviderError,
                `${this.label} response has no choices`,
            );
        }

        const message = isRecord(choice.message) ? choice.message : {};
        const content = typeof message.content === "string" ? message.content : "";
        const thinking = this._thinkingField === null
            ? undefined
            : optionalString(message[this._thinkingField]);
        const toolCalls = this.parseToolCalls(message.tool_calls);
        const usage = this.parseUsage(payload.usage);
        const stopReason = this.parseStopReason(choice.finish_reason);

        return new AssistantMessage(
            content,
            false,
            thinking,
            usage,
            toolCalls.length > 0 ? toolCalls : undefined,
            stopReason,
        );
    }

    override parseStreamChunk(raw: unknown): StreamChunk[]{
        if (!isRecord(raw)) return [];

        const apiError = readPayloadError(raw);
        if (apiError !== undefined){
            return [{
                type: "error",
                failureReason: ChatFailureReason.Unknown,
                message: apiError,
            }];
        }

        const chunks: StreamChunk[] = [];

        const usage = this.parseUsage(raw.usage);
        if (usage !== undefined) chunks.push({ type: "usage", usage });

        const choice = firstChoice(raw);
        if (choice === undefined) return chunks;

        const delta = isRecord(choice.delta) ? choice.delta : {};

        if (typeof delta.content === "string" && delta.content.length > 0){
            chunks.push({ type: "text_delta", text: delta.content });
        }

        if (this._thinkingField !== null){
            const thinking = delta[this._thinkingField];
            if (typeof thinking === "string" && thinking.length > 0){
                chunks.push({ type: "thinking_delta", text: thinking });
            }
        }

        if (Array.isArray(delta.tool_calls)){
            this.parseStreamToolCalls(delta.tool_calls, chunks);
        }

        this.parseDeltaExtras(delta, chunks);

        if (typeof choice.finish_reason === "string"){
            chunks.push({
                type: "done",
                stopReason: this.parseStopReason(choice.finish_reason),
            });
        }

        return chunks;
    }

    /* -----------------------------------------------------------------------
     * 可覆写的协议细节
     * --------------------------------------------------------------------- */

    /** 把纯文本内容转换为字符串；出现附件时按平台策略报错 */
    protected convertText(content: MessageContent, context: string): string{
        if (typeof content === "string") return content;

        const pieces: string[] = [];
        for (const part of content){
            if (part.type === "attachment"){
                throw new SessionError(SessionErrorType.InvalidData, this._attachmentText(context));
            }
            pieces.push(part.text);
        }
        return pieces.join("\n");
    }

    /** 转换 user 内容；附件通过 attachmentPart 编码 */
    protected convertUserContent(
        content: MessageContent,
        attachmentRefs: AttachmentWireMap | undefined,
    ): string | OpenAIContentPart[]{
        if (typeof content === "string") return content;

        const parts: OpenAIContentPart[] = [];

        for (const part of content){
            if (part.type === "text"){
                parts.push({ type: "text", text: part.text });
                continue;
            }

            if (!this._supportsAttachments){
                throw new SessionError(
                    SessionErrorType.InvalidData,
                    this._attachmentText("user messages"),
                );
            }

            if (attachmentRefs === undefined){
                throw new SessionError(
                    SessionErrorType.InvalidData,
                    `Missing ${this.label} attachment wire map for "${part.attachment.contentHash}"`,
                );
            }

            const ref = attachmentRefs.get(part.attachment.contentHash);
            if (ref === undefined){
                throw new SessionError(
                    SessionErrorType.InvalidData,
                    `${this.label} attachment reference was not resolved: ${part.attachment.contentHash}`,
                );
            }

            parts.push(this.attachmentPart(ref));
        }

        return parts;
    }

    /** 把 Provider 侧附件表示编码为 OpenAI 内容块；默认支持图片 URL / data URL */
    protected attachmentPart(ref: RemoteFileRef): OpenAIContentPart{
        switch (ref.kind){
            case "remote-id":
                throw new SessionError(
                    SessionErrorType.InvalidData,
                    `${this.label} does not support remote file attachments`,
                );

            case "url":
                return { type: "image_url", image_url: { url: ref.url } };

            case "inline": {
                const mimeType = detectImageMimeType(ref.data)
                    ?? normalizeImageMimeType(ref.mimeType);
                if (mimeType === undefined){
                    throw new SessionError(
                        SessionErrorType.InvalidData,
                        `${this.label} only supports JPEG/PNG/GIF/WebP images, got "${ref.mimeType ?? "unknown"}"`,
                    );
                }
                return {
                    type: "image_url",
                    image_url: { url: `data:${mimeType};base64,${toBase64(ref.data)}` },
                };
            }
        }
    }

    /** 转换 assistant 文本；附件片段默认被丢弃（历史回放策略）
     * @note 历史/UI 仍通过 AttachmentRef 渲染媒体；当前消息协议不接受 assistant 媒体输入。
     */
    protected assistantText(content: MessageContent): string{
        if (typeof content === "string") return content;

        const pieces: string[] = [];
        for (const part of content){
            if (part.type === "text") pieces.push(part.text);
        }
        return pieces.join("\n");
    }

    /** 转换 assistant 消息；默认不把附件回传给模型 */
    protected assistantPayload(assistant: AssistantMessage): OpenAIChatMessage{
        const content = this.assistantText(assistant.content);
        const payload: OpenAIChatMessage = {
            role: "assistant",
            content: content.length > 0 ? content : null,
        };

        if (assistant.thinking !== undefined && this._thinkingField !== null){
            payload[this._thinkingField] = assistant.thinking;
        }

        if (assistant.hasToolCall){
            payload.tool_calls = assistant.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: {
                    name: call.name,
                    arguments: JSON.stringify(call.params),
                },
            }));
        }

        return payload;
    }

    /** 转换 tool 消息；OpenAI 协议只接受文本或内容块 */
    protected toolPayload(tool: ToolMessage): OpenAIChatMessage{
        return {
            role: "tool",
            content: this.convertText(tool.content, "tool messages"),
            tool_call_id: tool.callId,
        };
    }

    /** 解析 OpenAI 风格 usage；子类可覆写以支持 input_tokens/output_tokens */
    protected parseUsage(value: unknown): ChatUsage | undefined{
        if (!isRecord(value)) return undefined;

        const prompt = numberField(value, "prompt_tokens");
        const completion = numberField(value, "completion_tokens");
        if (prompt === undefined && completion === undefined) return undefined;

        const promptTokens = prompt ?? 0;
        const completionTokens = completion ?? 0;
        return {
            promptTokens,
            completionTokens,
            totalTokens: numberField(value, "total_tokens") ?? promptTokens + completionTokens,
        };
    }

    /** 解析 finish_reason；子类可补充平台别名 */
    protected parseStopReason(value: unknown): ChatStopReason | undefined{
        switch (value){
            case "stop":
                return ChatStopReason.Stop;
            case "length":
                return ChatStopReason.Length;
            case "tool_calls":
            case "tool_call":
                return ChatStopReason.ToolCall;
            case "content_filter":
                return ChatStopReason.ContentFilter;
            default:
                return undefined;
        }
    }

    /** 解析非流式响应中的 tool_calls；子类可按平台容错策略覆写 */
    protected parseToolCalls(value: unknown): ToolCall[]{
        if (!Array.isArray(value)) return [];

        return value.map((entry, index) => {
            const record = isRecord(entry) ? entry : {};
            const fn = isRecord(record.function) ? record.function : {};
            const name = typeof fn.name === "string" ? fn.name : "";
            let params: Record<string, unknown> = {};

            if (isRecord(fn.arguments)){
                params = { ...fn.arguments };
            }else if (typeof fn.arguments === "string" && fn.arguments.trim().length > 0){
                try{
                    const parsed: unknown = JSON.parse(fn.arguments);
                    if (!isRecord(parsed)){
                        throw new Error("tool arguments should be an object");
                    }
                    params = parsed;
                }catch(error){
                    throw new SessionError(
                        SessionErrorType.ProviderError,
                        `Invalid ${this.label} tool arguments at index ${index}`,
                        error,
                    );
                }
            }

            return {
                id: typeof record.id === "string" ? record.id : uniqueId(),
                name,
                params,
            };
        });
    }

    /** 解析流式 tool_calls 增量；默认按 OpenAI delta 结构处理 */
    protected parseStreamToolCalls(entries: unknown[], chunks: StreamChunk[]): void{
        for (const [position, entry] of entries.entries()){
            if (!isRecord(entry)) continue;

            const fn = isRecord(entry.function) ? entry.function : {};
            const index = numberField(entry, "index") ?? position;
            const id = typeof entry.id === "string" ? entry.id : undefined;
            const name = typeof fn.name === "string" ? fn.name : undefined;
            const args = fn.arguments;
            const argumentsDelta = typeof args === "string"
                ? args
                : args === undefined
                    ? undefined
                    : JSON.stringify(args);

            chunks.push({
                type: "tool_call_delta",
                toolCall: { index, id, name, argumentsDelta },
            });
        }
    }

    /** 平台特有的 delta 字段（例如生图结果）扩展点 */
    protected parseDeltaExtras(_delta: Record<string, unknown>, _chunks: StreamChunk[]): void{
        // 默认没有额外字段
    }
}

/** 读取 payload.error，兼容字符串与对象两种形式 */
export function readPayloadError(payload: Record<string, unknown>): string | undefined{
    if (typeof payload.error === "string" && payload.error.length > 0){
        return payload.error;
    }
    if (isRecord(payload.error)){
        return typeof payload.error.message === "string"
            ? payload.error.message
            : `${payload.error.type ?? "provider error"}`;
    }
    return undefined;
}

export function firstChoice(payload: Record<string, unknown>): Record<string, unknown> | undefined{
    if (!Array.isArray(payload.choices) || payload.choices.length === 0) return undefined;
    const choice = payload.choices[0];
    return isRecord(choice) ? choice : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown>{
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function numberField(record: Record<string, unknown>, field: string): number | undefined{
    const value = record[field];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringField(record: Record<string, unknown>, field: string): string | undefined{
    const value = record[field];
    return typeof value === "string" ? value : undefined;
}

export function optionalString(value: unknown): string | undefined{
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
