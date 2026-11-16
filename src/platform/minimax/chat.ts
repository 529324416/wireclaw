import { uniqueId } from "../../base";
import { SessionError, SessionErrorType } from "../../session/error";
import { AssistantMessage, ToolMessage } from "../../session/message";
import type { Message } from "../../session/message";
import { AIProvider, ModelProvider, ProtocolAdapter } from "../../session/protocol";
import type { ChatCapability, ModelInfo, ModelModality } from "../../session/protocol";
import { ChatFailureReason, ChatStopReason } from "../../session/type";
import type {
    AttachmentWireMap,
    ChatOptions,
    ChatResult,
    ChatUsage,
    MessageContent,
    SessionRuntimeOptions,
    StreamChunk,
    ToolCall,
} from "../../session/type";
import { MINIMAX_DEFAULT_BASE_URL } from "./common";

/** MiniMax Chat 默认模型 */
export const MINIMAX_DEFAULT_CHAT_MODEL = "MiniMax-M3.1-Flash";

export type MiniMaxChatProviderOptions = {
    /** MiniMax API key；由宿主读取并注入 */
    apiKey: string;

    /** 默认 https://api.minimax.io；国内站可传 https://api.minimax.cn */
    baseUrl?: string;

    /** 默认 MiniMax-M3.1-Flash */
    model?: string;

    /** 自定义请求头 */
    headers?: Record<string, string>;

    /** 单次请求超时，默认 120s */
    timeoutMs?: number;

    /** 自定义 fetch */
    fetch?: typeof fetch;
};

type MiniMaxChatMessage = {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    [key: string]: unknown;
};

/** MiniMax OpenAI 兼容 Chat Completions 适配器 */
export class MiniMaxProtocolAdapter extends ProtocolAdapter {

    toPayload(msg: Message, _attachmentRefs?: AttachmentWireMap): MiniMaxChatMessage {
        switch (msg.role) {
            case "system":
                return {
                    role: "system",
                    content: contentToText(msg.content, "system messages"),
                };

            case "user":
                return {
                    role: "user",
                    content: contentToText(msg.content, "user messages"),
                };

            case "assistant": {
                return this._assistantPayload(msg as AssistantMessage);
            }

            case "tool": {
                const tool = msg as ToolMessage;
                return {
                    role: "tool",
                    content: contentToText(tool.content, "tool messages"),
                    tool_call_id: tool.callId,
                };
            }

            default:
                throw new SessionError(
                    SessionErrorType.InvalidData,
                    `Unsupported MiniMax message role: ${msg.role}`,
                );
        }
    }

    toAssistantMessage(payload: unknown): AssistantMessage {
        if (!isRecord(payload)) {
            throw new SessionError(SessionErrorType.ProviderError, "Invalid MiniMax response");
        }
        const apiError = readError(payload);
        if (apiError !== undefined) throw apiError;

        const choice = firstChoice(payload);
        if (choice === undefined) {
            throw new SessionError(
                SessionErrorType.ProviderError,
                "MiniMax response has no choices",
            );
        }

        const message = isRecord(choice.message) ? choice.message : {};
        const content = typeof message.content === "string" ? message.content : "";
        const thinking = typeof message.reasoning_content === "string"
            && message.reasoning_content.length > 0
            ? message.reasoning_content
            : undefined;
        const toolCalls = parseToolCalls(message.tool_calls);
        const usage = parseUsage(payload.usage);
        const stopReason = parseStopReason(choice.finish_reason);

        return new AssistantMessage(
            content,
            false,
            thinking,
            usage,
            toolCalls.length > 0 ? toolCalls : undefined,
            stopReason,
        );
    }

    parseStreamChunk(raw: unknown): StreamChunk[] {
        if (!isRecord(raw)) return [];

        const apiError = readError(raw);
        if (apiError !== undefined) {
            return [{
                type: "error",
                failureReason: ChatFailureReason.Unknown,
                message: apiError.message,
            }];
        }

        const chunks: StreamChunk[] = [];
        const usage = parseUsage(raw.usage);
        if (usage !== undefined) {
            chunks.push({ type: "usage", usage });
        }

        const choice = firstChoice(raw);
        if (choice === undefined) return chunks;

        const delta = isRecord(choice.delta) ? choice.delta : {};

        if (typeof delta.content === "string" && delta.content.length > 0) {
            chunks.push({ type: "text_delta", text: delta.content });
        }
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
            chunks.push({ type: "thinking_delta", text: delta.reasoning_content });
        }

        if (Array.isArray(delta.tool_calls)) {
            for (const [position, entry] of delta.tool_calls.entries()) {
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

        const finishReason = typeof choice.finish_reason === "string"
            ? choice.finish_reason
            : undefined;
        if (finishReason !== undefined) {
            chunks.push({
                type: "done",
                stopReason: parseStopReason(finishReason),
            });
        }

        return chunks;
    }

    private _assistantPayload(assistant: AssistantMessage): MiniMaxChatMessage {
        const content = contentToText(assistant.content, "assistant messages");
        const payload: MiniMaxChatMessage = {
            role: "assistant",
            content: content.length > 0 ? content : null,
        };

        if (assistant.thinking !== undefined) {
            payload.reasoning_content = assistant.thinking;
        }

        if (assistant.hasToolCall) {
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
}

/** MiniMax 模型目录 */
export class MiniMaxModelProvider extends ModelProvider {

    private readonly _baseUrl: string;
    private readonly _headers: Record<string, string>;
    private readonly _fetch: typeof fetch | undefined;
    private _cache: ModelInfo[] | undefined;

    constructor(
        baseUrl: string,
        headers: Record<string, string>,
        fetchImpl: typeof fetch | undefined,
    ) {
        super();
        this._baseUrl = baseUrl.replace(/\/+$/, "");
        this._headers = { ...headers };
        this._fetch = fetchImpl;
    }

    async validateNetwork(): Promise<void> {
        this._cache = await this._fetchModels();
    }

    protected async fetchModels(): Promise<ModelInfo[]> {
        if (this._cache !== undefined) return this._cache;
        return await this._fetchModels();
    }

    private async _fetchModels(): Promise<ModelInfo[]> {
        if (this._fetch === undefined) {
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "MiniMax requires a fetch implementation",
            );
        }

        let response: Response;
        try {
            response = await this._fetch(`${this._baseUrl}/v1/models`, {
                method: "GET",
                headers: this._headers,
            });
        } catch (error) {
            throw new SessionError(
                SessionErrorType.NetworkError,
                "MiniMax /v1/models request failed",
                error,
            );
        }

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new SessionError(
                SessionErrorType.ProviderError,
                `MiniMax /v1/models returned HTTP ${response.status}`
                    + (body.length > 0 ? `: ${body.slice(0, 300)}` : ""),
            );
        }

        let payload: unknown;
        try {
            payload = await response.json();
        } catch (error) {
            throw new SessionError(
                SessionErrorType.ProviderError,
                "MiniMax /v1/models returned invalid JSON",
                error,
            );
        }

        if (!isRecord(payload) || !Array.isArray(payload.data)) {
            throw new SessionError(
                SessionErrorType.ProviderError,
                "MiniMax /v1/models response is missing data",
            );
        }

        return payload.data
            .map((item) => toModelInfo(item))
            .filter((item): item is ModelInfo => item !== null);
    }
}

/** MiniMax OpenAI 兼容 Chat Provider
 *
 * 仅实现 ChatCapability；图片/视频生成走同目录的 image/video Provider。
 */
export class MiniMaxChatProvider extends AIProvider implements ChatCapability {

    private readonly _baseUrl: string;
    private readonly _apiKey: string;
    private readonly _model: string;
    private readonly _headers: Record<string, string>;
    private readonly _timeoutMs: number;
    private readonly _fetch: typeof fetch | undefined;
    private readonly _modelProvider: MiniMaxModelProvider;
    private readonly _protocolAdapter = new MiniMaxProtocolAdapter();

    constructor(options: MiniMaxChatProviderOptions) {
        super();

        const apiKey = options.apiKey?.trim();
        if (apiKey === undefined || apiKey.length === 0) {
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "MiniMaxChatProvider requires an API key",
            );
        }

        const timeoutMs = options.timeoutMs ?? 120_000;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                `timeoutMs must be a positive number, got ${String(options.timeoutMs)}`,
            );
        }

        this._baseUrl = (options.baseUrl ?? MINIMAX_DEFAULT_BASE_URL).replace(/\/+$/, "");
        this._apiKey = apiKey;
        this._model = options.model ?? MINIMAX_DEFAULT_CHAT_MODEL;
        this._headers = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this._apiKey}`,
            ...(options.headers ?? {}),
        };
        this._timeoutMs = Math.floor(timeoutMs);
        this._fetch = options.fetch ?? (typeof fetch === "function" ? fetch : undefined);
        this._modelProvider = new MiniMaxModelProvider(
            this._baseUrl,
            this._headers,
            this._fetch,
        );
    }

    get title(): string {
        return "MiniMax";
    }

    override get modelProvider(): MiniMaxModelProvider {
        return this._modelProvider;
    }

    override get supportsTools(): boolean {
        return true;
    }

    get protocolAdapter(): MiniMaxProtocolAdapter {
        return this._protocolAdapter;
    }

    override async resolveDefaultModel(): Promise<string | undefined> {
        const models = this._modelProvider.availableModels
            ?? await this._modelProvider.initModels();
        const preferred = models.find((model) => model.id === this._model)
            ?? models.find((model) => model.id === MINIMAX_DEFAULT_CHAT_MODEL)
            ?? models.find((model) => model.id === "MiniMax-M3")
            ?? models.find((model) => model.id.startsWith("MiniMax-M3"))
            ?? models[0];
        return preferred?.id;
    }

    async chat(
        messages: readonly Message[],
        options: SessionRuntimeOptions,
        turn?: ChatOptions,
    ): Promise<ChatResult> {
        if (options.model === undefined || options.model.length === 0) {
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "MiniMax requires SessionRuntimeOptions.model",
            );
        }

        const payload: Record<string, unknown> = {
            model: options.model,
            messages: this._protocolAdapter.toPayloads([...messages]),
            stream: true,
            stream_options: { include_usage: true },
        };

        if (turn?.tools !== undefined && turn.tools.length > 0) {
            payload.tools = this._protocolAdapter.toolDefinitionsToPayload(turn.tools);
        }
        if (typeof options.temperature === "number") {
            payload.temperature = options.temperature;
        }

        const response = await this._request(payload, turn?.signal);
        if (response.body === null) {
            throw new SessionError(
                SessionErrorType.ProviderError,
                "MiniMax returned an empty response body",
            );
        }

        let content = "";
        let thinking = "";
        let usage: ChatUsage | undefined;
        let stopReason: ChatStopReason | undefined;
        let streamDone = false;
        const toolCalls = new Map<number, { id?: string; name?: string; argumentsText: string }>();

        const consumeLine = (line: string): void => {
            if (!line.startsWith("data:")) return;

            const data = line.slice(5).trim();
            if (data.length === 0) return;
            if (data === "[DONE]") {
                streamDone = true;
                return;
            }

            let raw: unknown;
            try {
                raw = JSON.parse(data);
            } catch (error) {
                throw new SessionError(
                    SessionErrorType.ProviderError,
                    "MiniMax returned invalid SSE JSON",
                    error,
                );
            }

            for (const chunk of this._protocolAdapter.parseStreamChunk(raw)) {
                switch (chunk.type) {
                    case "text_delta":
                        content += chunk.text;
                        if (chunk.text.length > 0) turn?.onToken?.(chunk.text, false);
                        break;

                    case "thinking_delta":
                        thinking += chunk.text;
                        if (chunk.text.length > 0) turn?.onToken?.(chunk.text, true);
                        break;

                    case "attachment":
                        turn?.onAttachment?.(chunk.attachment);
                        break;

                    case "tool_call_delta": {
                        const current = toolCalls.get(chunk.toolCall.index)
                            ?? { argumentsText: "" };
                        if (chunk.toolCall.id !== undefined) current.id = chunk.toolCall.id;
                        if (chunk.toolCall.name !== undefined) current.name = chunk.toolCall.name;
                        if (chunk.toolCall.argumentsDelta !== undefined) {
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
                            chunk.message ?? "MiniMax stream error",
                            chunk.failureReason,
                        );
                }
            }
        };

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
            while (!streamDone) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                let newlineIndex = buffer.indexOf("\n");
                while (newlineIndex >= 0 && !streamDone) {
                    const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
                    buffer = buffer.slice(newlineIndex + 1);
                    consumeLine(line);
                    newlineIndex = buffer.indexOf("\n");
                }
            }

            if (!streamDone) {
                buffer += decoder.decode();
                if (buffer.trim().length > 0) consumeLine(buffer);
            }
        } catch (error) {
            if (turn?.signal?.aborted === true) throw error;
            if (error instanceof SessionError) throw error;
            throw new SessionError(
                SessionErrorType.ProviderError,
                "Failed to read MiniMax stream",
                error,
            );
        } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
        }

        const calls: ToolCall[] = [...toolCalls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([index, call]) => {
                let params: Record<string, unknown> = {};
                if (call.argumentsText.trim().length > 0) {
                    try {
                        const parsed: unknown = JSON.parse(call.argumentsText);
                        if (!isRecord(parsed)) throw new Error("tool arguments should be an object");
                        params = parsed;
                    } catch (error) {
                        throw new SessionError(
                            SessionErrorType.ProviderError,
                            `MiniMax returned invalid tool arguments for call ${index}`,
                            error,
                        );
                    }
                }
                return {
                    id: call.id ?? uniqueId(),
                    name: call.name ?? "unknown",
                    params,
                };
            });

        return {
            message: new AssistantMessage(
                content,
                false,
                thinking.length > 0 ? thinking : undefined,
                usage,
                calls,
                stopReason,
            ),
        };
    }

    private async _request(
        payload: Record<string, unknown>,
        signal: AbortSignal | undefined,
    ): Promise<Response> {
        if (this._fetch === undefined) {
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "MiniMax requires a fetch implementation",
            );
        }

        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, this._timeoutMs);
        const onAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener("abort", onAbort, { once: true });

        try {
            let response: Response;
            try {
                response = await this._fetch(`${this._baseUrl}/v1/chat/completions`, {
                    method: "POST",
                    headers: this._headers,
                    body: JSON.stringify(payload),
                    signal: controller.signal,
                });
            } catch (error) {
                if (signal?.aborted === true) throw error;
                if (timedOut) {
                    throw new SessionError(
                        SessionErrorType.NetworkError,
                        `MiniMax chat request timed out after ${this._timeoutMs}ms`,
                        error,
                    );
                }
                throw new SessionError(
                    SessionErrorType.NetworkError,
                    "MiniMax chat request failed",
                    error,
                );
            }

            if (!response.ok) {
                const body = await response.text().catch(() => "");
                throw new SessionError(
                    SessionErrorType.ProviderError,
                    `MiniMax chat returned HTTP ${response.status}`
                        + (body.length > 0 ? `: ${body.slice(0, 500)}` : ""),
                );
            }

            return response;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        }
    }
}

function contentToText(content: MessageContent, context: string): string {
    if (typeof content === "string") return content;

    const pieces: string[] = [];
    for (const part of content) {
        if (part.type === "attachment") {
            throw new SessionError(
                SessionErrorType.InvalidData,
                `MiniMax Chat does not support attachments in ${context} yet`,
            );
        }
        pieces.push(part.text);
    }
    return pieces.join("\n");
}

function firstChoice(payload: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!Array.isArray(payload.choices)) return undefined;
    const first = payload.choices[0];
    return isRecord(first) ? first : undefined;
}

function parseToolCalls(value: unknown): ToolCall[] {
    if (!Array.isArray(value)) return [];

    return value.map((entry, index) => {
        if (!isRecord(entry)) {
            throw new SessionError(
                SessionErrorType.ProviderError,
                `Invalid MiniMax tool call at index ${index}`,
            );
        }
        const fn = isRecord(entry.function) ? entry.function : {};
        const name = typeof fn.name === "string" ? fn.name : "";
        let params: Record<string, unknown> = {};
        if (typeof fn.arguments === "string" && fn.arguments.trim().length > 0) {
            try {
                const parsed: unknown = JSON.parse(fn.arguments);
                if (isRecord(parsed)) params = parsed;
            } catch {
                // 非流式响应中的工具参数错误交给上层处理
            }
        }
        return {
            id: typeof entry.id === "string" ? entry.id : uniqueId(),
            name,
            params,
        };
    }).filter((call) => call.name.length > 0);
}

function parseUsage(value: unknown): ChatUsage | undefined {
    if (!isRecord(value)) return undefined;

    const prompt = numberField(value, "prompt_tokens") ?? numberField(value, "input_tokens") ?? 0;
    const completion = numberField(value, "completion_tokens")
        ?? numberField(value, "output_tokens")
        ?? 0;
    const total = numberField(value, "total_tokens") ?? prompt + completion;

    return {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: total,
    };
}

function parseStopReason(value: unknown): ChatStopReason | undefined {
    switch (value) {
        case "stop":
        case "end_turn":
            return ChatStopReason.Stop;
        case "length":
        case "max_tokens":
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

function readError(payload: Record<string, unknown>): Error | undefined {
    if (typeof payload.error === "string" && payload.error.length > 0) {
        return new SessionError(SessionErrorType.ProviderError, payload.error);
    }
    if (isRecord(payload.error)) {
        const message = typeof payload.error.message === "string"
            ? payload.error.message
            : "MiniMax response error";
        return new SessionError(SessionErrorType.ProviderError, message);
    }
    return undefined;
}

function toModelInfo(raw: unknown): ModelInfo | null {
    if (!isRecord(raw)) return null;

    const id = typeof raw.id === "string" ? raw.id : "";
    if (id.length === 0) return null;

    const name = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : id;
    const isVision = id.startsWith("MiniMax-M3") || id.toLowerCase().includes("vision");
    const input: ModelModality[] = isVision ? ["text", "image"] : ["text"];
    const output: ModelModality[] = ["text"];

    return {
        id,
        name,
        description: id,
        size: 0,
        supportCompletion: true,
        supportToolCall: true,
        supportThink: true,
        isVisionModel: isVision,
        isEmbeddingModel: false,
        capabilities: {
            chat: {
                input,
                output,
                streaming: true,
                tools: true,
                context: true,
            },
        },
    };
}

function numberField(record: Record<string, unknown>, field: string): number | undefined {
    const value = record[field];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
