import { uniqueId } from "../base";
import { SessionError, SessionErrorType } from "../session/error";
import { AssistantMessage, ToolMessage } from "../session";
import type { Message } from "../session";
import { LLMProvider, ModelProvider, ProtocolAdapter } from "../session/protocol";
import type { ModelInfo } from "../session";
import type {
    ChatOptions,
    ChatResult,
    ChatUsage,
    MessageContent,
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
    tool_calls?: unknown[];
    tool_name?: string;
    tool_call_id?: string;
};

type OllamaToolCall = {
    id?: string;
    function?: {
        name?: string;
        arguments?: unknown;
    };
};

type OllamaModelTag = {
    name?: string;
    model?: string;
    modified_at?: string;
    size?: number;
    digest?: string;
    details?: Record<string, unknown>;
};

type OllamaShowResponse = {
    capabilities?: unknown[];
    details?: Record<string, unknown>;
};

function emptyUsage(): ChatUsage{
    return {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
    };
}

function isRecord(value: unknown): value is Record<string, unknown>{
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined{
    if (record === undefined) return undefined;
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}

function contentToText(content: MessageContent): string{
    if (typeof content === "string") return content;

    const pieces: string[] = [];
    for (const part of content){
        if (part.type === "attachment"){
            throw new SessionError(
                SessionErrorType.InvalidData,
                "Ollama adapter does not support attachment content yet",
            );
        }
        pieces.push(part.text);
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

/** Ollama 协议适配器：Rotom Message <-> Ollama chat message */
export class OllamaProtocolAdapter extends ProtocolAdapter{

    /** 将 Rotom Message 转成 Ollama chat message */
    toPayload(msg: Message): OllamaMessage{
        const content = contentToText(msg.content);

        switch (msg.role){
            case "system":
                return { role: "system", content };

            case "user":
                return { role: "user", content };

            case "assistant": {
                const assistant = msg as AssistantMessage;
                const payload: OllamaMessage = { role: "assistant", content };
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
                    content,
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
            isEmbeddingModel: capabilities.includes("embedding") || name.toLowerCase().includes("embed"),
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

/** Ollama LLMProvider：整合 ModelProvider + ProtocolAdapter + /api/chat */
export class OllamaLLMProvider extends LLMProvider{

    private readonly _baseUrl: string;
    private readonly _headers: Record<string, string>;
    private readonly _modelProvider: OllamaModelProvider;
    private readonly _protocolAdapter: OllamaProtocolAdapter;

    constructor(
        baseUrl: string = "http://127.0.0.1:11434",
        headers: Record<string, string> = {},
    ){
        super();
        this._baseUrl = baseUrl.replace(/\/+$/, "");
        this._headers = { ...headers };
        this._modelProvider = new OllamaModelProvider(this._baseUrl, this._headers);
        this._protocolAdapter = new OllamaProtocolAdapter();
    }

    get modelProvider(): OllamaModelProvider{ return this._modelProvider; }
    get protocolAdapter(): OllamaProtocolAdapter{ return this._protocolAdapter; }
    get title(): string{ return "Ollama"; }

    async send(
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

        const requestOptions: Record<string, unknown> = {};
        if (options.temperature !== undefined){
            requestOptions.temperature = options.temperature;
        }

        const payload: Record<string, unknown> = {
            model: options.model,
            messages: this._protocolAdapter.toPayloads([...messages]),
            stream: true,
        };
        if (Object.keys(requestOptions).length > 0){
            payload.options = requestOptions;
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

        let content = "";
        let thinking = "";
        let usage = emptyUsage();
        let stopReason: ChatStopReason | undefined;
        let lastRaw: unknown;
        const toolCalls = new Map<number, {
            id?: string;
            name?: string;
            argumentsText: string;
        }>();

        const consumeLine = (line: string): void => {
            const trimmed = line.trim();
            if (trimmed.length === 0) return;

            let raw: unknown;
            try{
                raw = JSON.parse(trimmed);
            }catch(error){
                throw new SessionError(
                    SessionErrorType.ProviderError,
                    "Ollama returned invalid NDJSON",
                    error,
                );
            }
            lastRaw = raw;

            for (const chunk of this._protocolAdapter.parseStreamChunk(raw)){
                switch (chunk.type){
                    case "text_delta":
                        content += chunk.text;
                        if (chunk.text.length > 0){
                            turn?.onToken?.(chunk.text, false);
                        }
                        break;

                    case "thinking_delta":
                        thinking += chunk.text;
                        if (chunk.text.length > 0){
                            turn?.onToken?.(chunk.text, true);
                        }
                        break;

                    case "tool_call_delta": {
                        const current = toolCalls.get(chunk.toolCall.index) ?? { argumentsText: "" };
                        if (chunk.toolCall.id !== undefined) current.id = chunk.toolCall.id;
                        if (chunk.toolCall.name !== undefined) current.name = chunk.toolCall.name;
                        if (chunk.toolCall.argumentsDelta !== undefined){
                            current.argumentsText += chunk.toolCall.argumentsDelta;
                        }
                        toolCalls.set(chunk.toolCall.index, current);
                        break;
                    }

                    case "usage":
                        usage = { ...chunk.usage };
                        break;

                    case "done":
                        stopReason = chunk.stopReason;
                        break;

                    case "error":
                        throw new SessionError(
                            SessionErrorType.ProviderError,
                            chunk.message ?? "Ollama stream error",
                            chunk.failureReason,
                        );
                }
            }
        };

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try{
            while (true){
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                let newlineIndex = buffer.indexOf("\n");
                while (newlineIndex >= 0){
                    const line = buffer.slice(0, newlineIndex);
                    buffer = buffer.slice(newlineIndex + 1);
                    consumeLine(line);
                    newlineIndex = buffer.indexOf("\n");
                }
            }

            buffer += decoder.decode();
            if (buffer.trim().length > 0){
                consumeLine(buffer);
            }
        }catch(error){
            if (turn?.signal?.aborted) throw error;
            if (error instanceof SessionError) throw error;
            throw new SessionError(
                SessionErrorType.ProviderError,
                "Failed to read the Ollama stream",
                error,
            );
        }finally{
            reader.releaseLock();
        }

        const calls: ToolCall[] = [...toolCalls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([index, call]) => {
                let params: Record<string, unknown> = {};
                if (call.argumentsText.trim().length > 0){
                    try{
                        const parsed: unknown = JSON.parse(call.argumentsText);
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
                    id: call.id ?? uniqueId(),
                    name: call.name ?? `tool_${index}`,
                    params,
                };
            });

        return {
            message: new AssistantMessage(
                content,
                false,
                thinking.length > 0 ? thinking : undefined,
                usage,
                calls.length > 0 ? calls : undefined,
                stopReason,
            ),
            raw: lastRaw,
        };
    }
}
