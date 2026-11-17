import { toBase64, uniqueId } from "../base";
import { detectImageMimeType } from "../file";
import { consumeChatStream } from "./shared/stream";
import type { AttachmentFile } from "../session/attachment";
import { SessionError, SessionErrorType } from "../session/error";
import { AssistantMessage, ToolMessage } from "../session";
import type { Message } from "../session";
import { AIProvider, CloudFileManager, ModelProvider, ProtocolAdapter } from "../session/protocol";
import type { ChatCapability } from "../session/protocol";
import type { ModelInfo } from "../session";
import type {
    AttachmentWireMap,
    ChatOptions,
    ChatResult,
    ChatUsage,
    MessageContent,
    RemoteFileRef,
    SessionRuntimeOptions,
    StreamChunk,
    ToolCall,
} from "../session/type";
import {
    ChatFailureReason,
    ChatStopReason,
} from "../session/type";

/** Ollama 的一轮 chat 请求/响应结构（只声明本项目用到的字段） */
type OllamaMessage = {
    role: string;
    content?: string;
    thinking?: string;
    images?: string[];
    tool_calls?: unknown[];
    tool_name?: string;
    tool_call_id?: string;
};

type OllamaShowResponse = {
    capabilities?: unknown[];
    details?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown>{
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined{
    if (record === undefined) return undefined;
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}

type OllamaContent = {
    text: string;
    images: string[];
};

/** 把 Wireclaw 内容转换为 Ollama 的文本 + images(base64)
 * @note Ollama 没有远端文件 ID，图片必须以 base64 放在消息的 images 字段中
 */
function contentToOllama(
    content: MessageContent,
    attachmentRefs?: AttachmentWireMap,
): OllamaContent{
    if (typeof content === "string") return { text: content, images: [] };

    const pieces: string[] = [];
    const images: string[] = [];

    for (const part of content){
        if (part.type === "text"){
            pieces.push(part.text);
            continue;
        }

        if (attachmentRefs === undefined){
            throw new SessionError(
                SessionErrorType.InvalidData,
                `Missing attachment wire map for "${part.attachment.contentHash}"`,
            );
        }

        const ref = attachmentRefs.get(part.attachment.contentHash);
        if (ref === undefined){
            throw new SessionError(
                SessionErrorType.InvalidData,
                `Attachment reference was not resolved: ${part.attachment.contentHash}`,
            );
        }

        if (ref.kind !== "inline"){
            throw new SessionError(
                SessionErrorType.InvalidData,
                `Ollama only supports inline attachments, got "${ref.kind}"`,
            );
        }

        const mimeType = detectImageMimeType(ref.data);
        if (mimeType === undefined){
            throw new SessionError(
                SessionErrorType.InvalidData,
                `Ollama only supports image attachments, got "${ref.mimeType ?? "unknown"}"`,
            );
        }

        images.push(toBase64(ref.data));
    }

    return { text: pieces.join("\n"), images };
}

/** 非 user 消息只发送文本；附件片段由 Session 回放策略剥离 */
function contentTextOnly(content: MessageContent): string{
    if (typeof content === "string") return content;

    const pieces: string[] = [];
    for (const part of content){
        if (part.type === "text") pieces.push(part.text);
    }
    return pieces.join("\n");
}

function parseUsage(record: Record<string, unknown>): ChatUsage | undefined{
    const prompt = typeof record.prompt_eval_count === "number" ? record.prompt_eval_count : undefined;
    const completion = typeof record.eval_count === "number" ? record.eval_count : undefined;
    if (prompt === undefined && completion === undefined) return undefined;

    const promptTokens = prompt ?? 0;
    const completionTokens = completion ?? 0;
    return {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
    };
}

function parseStopReason(value: unknown): ChatStopReason | undefined{
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

function parseToolCalls(value: unknown): ToolCall[]{
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
                    `Invalid Ollama tool arguments at index ${index}`,
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

/** Ollama 协议适配器：Wireclaw Message <-> Ollama chat message
 * @note 图片附件按 Ollama 协议编码为 base64，并放入 user 消息的 images 数组
 */
export class OllamaProtocolAdapter extends ProtocolAdapter{

    /** 将 Wireclaw Message 转成 Ollama chat message
     * @note Ollama 的图片协议是 base64 inline；其他平台可能是 file_id / URL / data URL
     */
    toPayload(msg: Message, attachmentRefs?: AttachmentWireMap): OllamaMessage{
        switch (msg.role){
            case "system":
                return { role: "system", content: contentTextOnly(msg.content) };

            case "user": {
                const { text, images } = contentToOllama(msg.content, attachmentRefs);
                const payload: OllamaMessage = { role: "user", content: text };
                if (images.length > 0) payload.images = images;
                return payload;
            }

            case "assistant": {
                const assistant = msg as AssistantMessage;
                const payload: OllamaMessage = {
                    role: "assistant",
                    content: contentTextOnly(assistant.content),
                };
                if (assistant.thinking !== undefined){
                    payload.thinking = assistant.thinking;
                }
                if (assistant.hasToolCall){
                    payload.tool_calls = assistant.toolCalls.map(call => ({
                        id: call.id,
                        function: {
                            name: call.name,
                            arguments: call.params,
                        },
                    }));
                }
                return payload;
            }

            case "tool": {
                const tool = msg as ToolMessage;
                return {
                    role: "tool",
                    content: contentTextOnly(tool.content),
                    tool_name: tool.toolName,
                    tool_call_id: tool.callId,
                };
            }

            default:
                throw new SessionError(
                    SessionErrorType.InvalidData,
                    `Unsupported message role: ${msg.role}`,
                );
        }
    }

    /** 解析 Ollama 的完整响应 */
    toAssistantMessage(payload: unknown): AssistantMessage{
        if (!isRecord(payload)){
            throw new SessionError(SessionErrorType.ProviderError, "Invalid Ollama response");
        }
        if (typeof payload.error === "string"){
            throw new SessionError(SessionErrorType.ProviderError, payload.error);
        }

        const message = isRecord(payload.message) ? payload.message : {};
        const content = typeof message.content === "string" ? message.content : "";
        const thinking = typeof message.thinking === "string" && message.thinking.length > 0
            ? message.thinking
            : undefined;
        const toolCalls = parseToolCalls(message.tool_calls);
        const usage = parseUsage(payload);
        const stopReason = parseStopReason(payload.done_reason);

        return new AssistantMessage(
            content,
            false,
            thinking,
            usage,
            toolCalls.length > 0 ? toolCalls : undefined,
            stopReason,
        );
    }

    /** 将 Ollama 的单行流式 JSON 解析为归一化片段 */
    parseStreamChunk(raw: unknown): StreamChunk[]{
        if (!isRecord(raw)) return [];

        if (typeof raw.error === "string"){
            return [{
                type: "error",
                failureReason: ChatFailureReason.Unknown,
                message: raw.error,
            }];
        }

        const chunks: StreamChunk[] = [];
        const message = isRecord(raw.message) ? raw.message : undefined;

        if (message !== undefined){
            const content = stringField(message, "content");
            if (content !== undefined && content.length > 0){
                chunks.push({ type: "text_delta", text: content });
            }

            const thinking = stringField(message, "thinking");
            if (thinking !== undefined && thinking.length > 0){
                chunks.push({ type: "thinking_delta", text: thinking });
            }

            if (Array.isArray(message.tool_calls)){
                for (const [index, entry] of message.tool_calls.entries()){
                    const record = isRecord(entry) ? entry : {};
                    const fn = isRecord(record.function) ? record.function : {};
                    const name = typeof fn.name === "string" ? fn.name : undefined;
                    const id = typeof record.id === "string" ? record.id : undefined;
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
        }

        const usage = parseUsage(raw);
        if (usage !== undefined){
            chunks.push({ type: "usage", usage });
        }

        if (raw.done === true){
            chunks.push({
                type: "done",
                stopReason: parseStopReason(raw.done_reason),
            });
        }

        return chunks;
    }
}

/** Ollama 模型目录提供者 */
export class OllamaModelProvider extends ModelProvider{

    private readonly _baseUrl: string;
    private readonly _headers: Record<string, string>;

    constructor(
        baseUrl: string = "http://127.0.0.1:11434",
        headers: Record<string, string> = {},
    ){
        super();
        this._baseUrl = baseUrl.replace(/\/+$/, "");
        this._headers = { ...headers };
    }

    async validateNetwork(): Promise<void>{
        try{
            const response = await fetch(`${this._baseUrl}/api/tags`, {
                method: "HEAD",
                headers: this._headers,
                signal: AbortSignal.timeout(5000),
            });

            // 部分 Ollama 版本不支持 HEAD，能返回 405 说明服务是可达的
            if (response.ok || response.status === 405) return;

            throw new SessionError(
                SessionErrorType.NetworkError,
                `Ollama returned HTTP ${response.status}`,
            );
        }catch(error){
            if (error instanceof SessionError) throw error;
            throw new SessionError(
                SessionErrorType.NetworkError,
                "Cannot reach Ollama",
                error,
            );
        }
    }

    protected async fetchModels(): Promise<ModelInfo[]>{
        let response: Response;
        try{
            response = await fetch(`${this._baseUrl}/api/tags`, {
                headers: this._headers,
                signal: AbortSignal.timeout(10000),
            });
        }catch(error){
            throw new SessionError(
                SessionErrorType.NetworkError,
                "Failed to fetch Ollama models",
                error,
            );
        }

        if (!response.ok){
            const body = await response.text().catch(() => "");
            throw new SessionError(
                SessionErrorType.ProviderError,
                `Ollama /api/tags returned HTTP ${response.status}: ${body}`,
            );
        }

        const data: unknown = await response.json();
        const tags = isRecord(data) && Array.isArray(data.models) ? data.models : [];
        return Promise.all(tags.map(tag => this._toModelInfo(tag)));
    }

    private async _toModelInfo(tag: unknown): Promise<ModelInfo>{
        const record = isRecord(tag) ? tag : {};
        const name = stringField(record, "name")
            ?? stringField(record, "model")
            ?? "unknown";
        const modelId = stringField(record, "model") ?? name;
        const show = await this._fetchShow(name);
        const capabilities = Array.isArray(show.capabilities)
            ? show.capabilities.filter((item): item is string => typeof item === "string")
            : [];
        const tagDetails = isRecord(record.details) ? record.details : undefined;
        const showDetails = isRecord(show.details) ? show.details : undefined;
        const details = showDetails ?? tagDetails;

        const family = stringField(details, "family");
        const parameterSize = stringField(details, "parameter_size");
        const quantization = stringField(details, "quantization_level");
        const description = [family, parameterSize, quantization]
            .filter((item): item is string => item !== undefined && item.length > 0)
            .join(" / ") || `Ollama model ${name}`;

        const supportCompletion = capabilities.length === 0
            ? true
            : capabilities.includes("completion");
        const isEmbeddingModel = capabilities.includes("embedding");
        const input = supportCompletion
            ? [
                "text" as const,
                ...(capabilities.includes("vision") ? ["image" as const] : []),
            ]
            : [];

        return {
            id: modelId,
            name,
            description,
            size: typeof record.size === "number" ? record.size : 0,
            supportCompletion,
            supportToolCall: capabilities.includes("tools"),
            supportThink: capabilities.includes("thinking"),
            thinkingLevels: undefined,
            isVisionModel: capabilities.includes("vision"),
            isEmbeddingModel,
            capabilities: supportCompletion
                ? {
                    chat: {
                        input,
                        output: ["text"],
                        streaming: true,
                        tools: capabilities.includes("tools"),
                        thinking: capabilities.includes("thinking"),
                    },
                }
                : isEmbeddingModel
                    ? { embed: { input: ["text"], output: ["embedding"] } }
                    : undefined,
            version: stringField(record, "digest")?.slice(0, 12),
            extraInfo: {
                modifiedAt: stringField(record, "modified_at"),
                digest: stringField(record, "digest"),
                details,
                capabilities,
            },
        };
    }

    private async _fetchShow(name: string): Promise<OllamaShowResponse>{
        try{
            const response = await fetch(`${this._baseUrl}/api/show`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...this._headers,
                },
                body: JSON.stringify({ model: name }),
                signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) return {};
            const data: unknown = await response.json();
            return isRecord(data) ? data : {};
        }catch{
            return {};
        }
    }
}

/** Ollama 的 CloudFileManager：Ollama 没有文件上传协议，图片以 inline base64 发送
 * @note 因此 ensureFile 只做图片校验并返回原始字节，不产生远端文件 ID / 过期时间
 */
export class OllamaCloudFileManager extends CloudFileManager{

    async ensureFile(file: AttachmentFile, _signal?: AbortSignal): Promise<RemoteFileRef>{
        const mimeType = detectImageMimeType(file.content);

        if (mimeType === undefined){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                `Ollama only supports image attachments, got "${file.mimeType ?? "unknown"}"`,
            );
        }

        return {
            kind: "inline",
            data: file.content,
            name: file.name,
            mimeType,
        };
    }
}

/** Ollama Provider：整合 ModelProvider + ProtocolAdapter + CloudFileManager + /api/chat */
export class OllamaProvider extends AIProvider implements ChatCapability{

    private readonly _baseUrl: string;
    private readonly _headers: Record<string, string>;
    private readonly _modelProvider: OllamaModelProvider;
    private readonly _protocolAdapter: OllamaProtocolAdapter;
    private readonly _cloudFileManager: OllamaCloudFileManager;

    constructor(
        baseUrl: string = "http://127.0.0.1:11434",
        headers: Record<string, string> = {},
    ){
        super();
        this._baseUrl = baseUrl.replace(/\/+$/, "");
        this._headers = { ...headers };
        this._modelProvider = new OllamaModelProvider(this._baseUrl, this._headers);
        this._protocolAdapter = new OllamaProtocolAdapter();
        this._cloudFileManager = new OllamaCloudFileManager();
    }

    override get modelProvider(): OllamaModelProvider{ return this._modelProvider; }
    get protocolAdapter(): OllamaProtocolAdapter{ return this._protocolAdapter; }
    override get cloudFileManager(): OllamaCloudFileManager{ return this._cloudFileManager; }
    get title(): string{ return "Ollama"; }

    override get supportsTools(): boolean{ return true; }

    override async resolveDefaultModel(): Promise<string | undefined>{
        const models = this._modelProvider.availableModels ?? await this._modelProvider.initModels();
        const candidates = models.filter(
            (model) => model.supportCompletion && !model.isEmbeddingModel,
        );

        const preferred = candidates.find((model) => model.name === "qwen3.5:9b")
            ?? candidates.find((model) => /qwen3\.5.*9b/i.test(model.name));

        return (preferred ?? candidates[0])?.name;
    }

    async chat(
        messages: readonly Message[],
        options: SessionRuntimeOptions,
        turn?: ChatOptions,
    ): Promise<ChatResult>{
        if (options.model === undefined || options.model.length === 0){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "Ollama requires SessionRuntimeOptions.model",
            );
        }

        if (turn?.attachmentRefs !== undefined && turn.attachmentRefs.size > 0){
            const model = this._modelProvider.availableModels?.find(
                (item) => item.id === options.model || item.name === options.model,
            );
            if (model !== undefined && !model.isVisionModel){
                throw new SessionError(
                    SessionErrorType.InvalidRequest,
                    `Ollama model "${options.model}" does not support image attachments`,
                );
            }
        }

        const requestOptions: Record<string, unknown> = {};
        if (options.temperature !== undefined){
            requestOptions.temperature = options.temperature;
        }

        const payload: Record<string, unknown> = {
            model: options.model,
            messages: this._protocolAdapter.toPayloads([...messages], turn?.attachmentRefs),
            stream: true,
        };
        if (Object.keys(requestOptions).length > 0){
            payload.options = requestOptions;
        }
        if (turn?.tools !== undefined && turn.tools.length > 0){
            payload.tools = this._protocolAdapter.toolDefinitionsToPayload(turn.tools);
        }
        if (options.think !== undefined){
            payload.think = options.think;
        }

        let response: Response;
        try{
            response = await fetch(`${this._baseUrl}/api/chat`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...this._headers,
                },
                body: JSON.stringify(payload),
                signal: turn?.signal,
            });
        }catch(error){
            if (turn?.signal?.aborted) throw error;
            throw new SessionError(
                SessionErrorType.NetworkError,
                "Ollama chat request failed",
                error,
            );
        }

        if (!response.ok){
            const body = await response.text().catch(() => "");
            throw new SessionError(
                SessionErrorType.ProviderError,
                `Ollama /api/chat returned HTTP ${response.status}: ${body}`,
            );
        }

        if (response.body === null){
            throw new SessionError(
                SessionErrorType.ProviderError,
                "Ollama returned an empty response body",
            );
        }

        const { message, raw } = await consumeChatStream(response, {
            format: "ndjson",
            label: "Ollama",
            adapter: this._protocolAdapter,
            turn,
            invalidJsonMessage: "Ollama returned invalid NDJSON",
            toolNameFallback: (index) => `tool_${index}`,
            invalidToolArgumentsMessage: (index) =>
                `Invalid Ollama tool arguments at index ${index}`,
            streamErrorMessage: (message) => message ?? "Ollama stream error",
        });

        return { message, raw };
    }
}
