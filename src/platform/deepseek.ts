import { InvalidParameterError, toBase64, uniqueId } from "../base";
import { detectImageMimeType, normalizeImageMimeType } from "../file";
import type { AttachmentFile } from "../file";
import { SessionError, SessionErrorType } from "../session/error";
import { AssistantMessage, ToolMessage } from "../session";
import type { Message } from "../session";
import { CloudFileManager, LLMProvider, ModelProvider, ProtocolAdapter } from "../session/protocol";
import type { ModelInfo } from "../session";
import {
    ChatFailureReason,
    ChatStopReason,
} from "../session/type";
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

/** DeepSeek OpenAI 兼容接口默认地址 */
export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";

/** DeepSeek 文件默认有效期：3 小时 */
export const DEEPSEEK_DEFAULT_FILE_TTL_SECONDS = 3 * 60 * 60;

const DEEPSEEK_MIN_FILE_TTL_SECONDS = 60 * 60;
const DEEPSEEK_MAX_FILE_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEEPSEEK_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEEPSEEK_FILE_VERIFY_MARGIN_MS = 5 * 60 * 1000;
const DEEPSEEK_FILE_PURPOSE = "user_data";

type DeepSeekFetch = typeof fetch;

/** DeepSeek 端点/鉴权配置 */
export type DeepSeekEndpointOptions = {
    apiKey: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    /** 浏览器/Electron 可注入代理 fetch，避免 CORS 与 API key 暴露 */
    fetch?: DeepSeekFetch;
};

/** DeepSeek 文件上传配置 */
export type DeepSeekFileOptions = {
    /** 上传时设置的有效期；null 表示不设置（由 DeepSeek 永久保存） */
    expiresAfterSeconds?: number | null;
    /** 使用缓存中的 file_id 前是否向云端确认文件仍存在，默认 true */
    verify?: boolean;
};

/** DeepSeek Provider 完整配置 */
export type DeepSeekProviderOptions = DeepSeekEndpointOptions & {
    files?: DeepSeekFileOptions;
};

type DeepSeekRemoteFileRef = Extract<RemoteFileRef, { kind: "remote-id" }>;

type DeepSeekContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail?: string } }
    | { type: "file"; file_id?: string; file_data?: string; filename?: string };

type DeepSeekMessage = {
    role: string;
    content: string | DeepSeekContentPart[] | null;
    reasoning_content?: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
};

/** 将 DeepSeek 的 OpenAI 兼容响应/流转换为 Rotom 消息与片段 */
export class DeepSeekProtocolAdapter extends ProtocolAdapter {

    /** 将 Rotom Message 转成 DeepSeek OpenAI 兼容消息
     * @note 图片/文件编码属于 DeepSeek 平台协议：file_id 使用 file 块，
     *       内联图片使用 image_url + data URL。
     */
    toPayload(msg: Message, attachmentRefs?: AttachmentWireMap): DeepSeekMessage {
        switch (msg.role) {
            case "system":
                return {
                    role: "system",
                    content: contentToText(msg.content, "system messages"),
                };

            case "user":
                return {
                    role: "user",
                    content: userContent(msg.content, attachmentRefs),
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
                    `Unsupported DeepSeek message role: ${msg.role}`,
                );
        }
    }

    /** 解析非流式 chat completion 响应 */
    toAssistantMessage(payload: unknown): AssistantMessage {
        if (!isRecord(payload)) {
            throw new SessionError(SessionErrorType.ProviderError, "Invalid DeepSeek response");
        }
        if (typeof payload.error === "string") {
            throw new SessionError(SessionErrorType.ProviderError, payload.error);
        }
        if (isRecord(payload.error)) {
            throw new SessionError(
                SessionErrorType.ProviderError,
                typeof payload.error.message === "string" ? payload.error.message : "DeepSeek response error",
            );
        }

        const choice = firstChoice(payload);
        if (choice === undefined) {
            throw new SessionError(SessionErrorType.ProviderError, "DeepSeek response has no choices");
        }

        const message = isRecord(choice.message) ? choice.message : {};
        const content = typeof message.content === "string" ? message.content : "";
        const thinking = typeof message.reasoning_content === "string" && message.reasoning_content.length > 0
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

    /** 解析 SSE 中的一个 JSON chunk */
    parseStreamChunk(raw: unknown): StreamChunk[] {
        if (!isRecord(raw)) return [];

        if (typeof raw.error === "string") {
            return [{
                type: "error",
                failureReason: ChatFailureReason.Unknown,
                message: raw.error,
            }];
        }

        if (isRecord(raw.error)) {
            return [{
                type: "error",
                failureReason: ChatFailureReason.Unknown,
                message: typeof raw.error.message === "string" ? raw.error.message : "DeepSeek stream error",
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
        const content = typeof delta.content === "string" ? delta.content : "";
        if (content.length > 0) {
            chunks.push({ type: "text_delta", text: content });
        }

        const thinking = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
        if (thinking.length > 0) {
            chunks.push({ type: "thinking_delta", text: thinking });
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

        const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;
        if (finishReason !== undefined) {
            chunks.push({
                type: "done",
                stopReason: parseStopReason(finishReason),
            });
        }

        return chunks;
    }

    private _assistantPayload(assistant: AssistantMessage): DeepSeekMessage {
        const content = contentToText(assistant.content, "assistant messages");
        const payload: DeepSeekMessage = {
            role: "assistant",
            content: content.length > 0 ? content : null,
        };

        if (assistant.thinking !== undefined) {
            // 携带 tools 的请求必须回传 reasoning_content；未携带 tools 时 API 会忽略它
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

/** DeepSeek 模型目录提供者 */
export class DeepSeekModelProvider extends ModelProvider {

    private readonly _baseUrl: string;
    private readonly _headers: Record<string, string>;
    private readonly _fetch: DeepSeekFetch;

    constructor(options: DeepSeekEndpointOptions) {
        super();
        this._baseUrl = normalizeBaseUrl(options.baseUrl);
        this._headers = buildHeaders(options.apiKey, options.headers);
        this._fetch = resolveFetch(options.fetch);
    }

    async validateNetwork(): Promise<void> {
        await this._requestJson("/models", "list models");
    }

    protected async fetchModels(): Promise<ModelInfo[]> {
        const payload = await this._requestJson("/models", "list models");
        if (!isRecord(payload) || !Array.isArray(payload.data)) {
            throw new SessionError(
                SessionErrorType.ProviderError,
                "DeepSeek /models response is missing data",
            );
        }

        return payload.data
            .map((item) => this._toModelInfo(item))
            .filter((item): item is ModelInfo => item !== null);
    }

    private _toModelInfo(raw: unknown): ModelInfo | null {
        if (!isRecord(raw)) return null;

        const id = typeof raw.id === "string" ? raw.id : "";
        if (id.length === 0) return null;

        const displayName = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : id;
        const contextWindow = numberField(raw, "context_window");
        const maxOutputTokens = numberField(raw, "max_output_tokens");
        const modalities = stringArrayField(raw, "input_modalities");
        const isVisionModel = modalities.includes("image")
            || id.includes("vision")
            || id.includes("flash");

        const effort = isRecord(raw.effort) ? raw.effort : undefined;
        const thinkingLevels = effort === undefined
            ? undefined
            : stringArrayField(effort, "supported_levels");
        const supportThink = thinkingLevels === undefined
            ? true
            : thinkingLevels.length > 0;

        const context = contextWindow === undefined ? "" : ` / ${contextWindow} context`;
        const output = maxOutputTokens === undefined ? "" : ` / ${maxOutputTokens} output`;

        return {
            id,
            name: id,
            description: `${displayName}${context}${output}`,
            size: 0,
            supportCompletion: true,
            supportToolCall: true,
            supportThink,
            thinkingLevels: thinkingLevels === undefined ? undefined : [...thinkingLevels],
            isVisionModel,
            isEmbeddingModel: false,
            version: typeof raw.owned_by === "string" ? raw.owned_by : undefined,
            extraInfo: {
                ...raw,
                displayName,
                contextWindow,
                maxOutputTokens,
                inputModalities: modalities,
                defaultEffort: effort === undefined ? undefined : effort.default_level,
            },
        };
    }

    private async _requestJson(path: string, action: string): Promise<unknown> {
        const url = `${this._baseUrl}${path}`;
        let response: Response;

        try {
            response = await this._fetch(url, {
                method: "GET",
                headers: this._headers,
                signal: AbortSignal.timeout(15_000),
            });
        } catch (error) {
            throw new SessionError(
                SessionErrorType.NetworkError,
                `DeepSeek ${action} failed`,
                error,
            );
        }

        if (!response.ok) {
            throw new SessionError(
                SessionErrorType.ProviderError,
                await httpError(`DeepSeek ${action}`, response),
            );
        }

        try {
            return await response.json();
        } catch (error) {
            throw new SessionError(
                SessionErrorType.ProviderError,
                `DeepSeek ${action} returned invalid JSON`,
                error,
            );
        }
    }
}

/** DeepSeek Files API 管理器
 * @note 上传一次后缓存 file_id；每次使用前通过 GET /files/{id} 校验是否仍存在。
 */
export class DeepSeekCloudFileManager extends CloudFileManager {

    private readonly _baseUrl: string;
    private readonly _headers: Record<string, string>;
    private readonly _fetch: DeepSeekFetch;
    private readonly _expiresAfterSeconds: number | null;
    private readonly _verify: boolean;

    private readonly _cache = new Map<string, DeepSeekRemoteFileRef>();
    private readonly _pending = new Map<string, Promise<RemoteFileRef>>();

    constructor(options: DeepSeekEndpointOptions & DeepSeekFileOptions) {
        super();
        this._baseUrl = normalizeBaseUrl(options.baseUrl);
        this._headers = buildHeaders(options.apiKey, options.headers);
        this._fetch = resolveFetch(options.fetch);
        this._expiresAfterSeconds = resolveFileTtl(options.expiresAfterSeconds);
        this._verify = options.verify ?? true;
    }

    async ensureFile(file: AttachmentFile, signal?: AbortSignal): Promise<RemoteFileRef> {
        const mimeType = detectImageMimeType(file.content);
        if (mimeType === undefined) {
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                `DeepSeek only supports JPEG/PNG/GIF/WebP images, got "${file.mimeType ?? "unknown"}"`,
            );
        }
        if (file.size > DEEPSEEK_MAX_FILE_BYTES) {
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                `DeepSeek file is too large: ${file.size} bytes (max ${DEEPSEEK_MAX_FILE_BYTES})`,
            );
        }
        if (signal?.aborted === true) {
            throw new SessionError(SessionErrorType.InvalidRequest, "DeepSeek file resolution was aborted");
        }

        const key = file.contentHash;
        const pending = this._pending.get(key);
        if (pending !== undefined) return await pending;

        const task = this._ensureFile(key, file, mimeType, signal)
            .finally(() => {
                this._pending.delete(key);
            });
        this._pending.set(key, task);
        return await task;
    }

    override async close(): Promise<void> {
        this._cache.clear();
        this._pending.clear();
    }

    private async _ensureFile(
        key: string,
        file: AttachmentFile,
        mimeType: string,
        signal?: AbortSignal,
    ): Promise<RemoteFileRef> {
        const cached = this._cache.get(key);

        if (cached !== undefined) {
            const nearExpiry = cached.expiresAt !== undefined
                && cached.expiresAt - Date.now() <= DEEPSEEK_FILE_VERIFY_MARGIN_MS;

            if (!nearExpiry && (!this._verify || await this._verifyFile(cached.fileId, signal))) {
                return cached;
            }

            this._cache.delete(key);
        }

        const ref = await this._uploadFile(file, mimeType, signal);
        this._cache.set(key, ref);
        return ref;
    }

    private async _verifyFile(fileId: string, signal?: AbortSignal): Promise<boolean> {
        const url = `${this._baseUrl}/files/${encodeURIComponent(fileId)}`;
        let response: Response;

        try {
            response = await this._fetch(url, {
                method: "GET",
                headers: this._headers,
                signal,
            });
        } catch (error) {
            if (signal?.aborted === true) throw error;
            throw new SessionError(
                SessionErrorType.NetworkError,
                `DeepSeek verify file failed: ${fileId}`,
                error,
            );
        }

        if (response.status === 404 || response.status === 410) return false;
        if (!response.ok) {
            throw new SessionError(
                SessionErrorType.ProviderError,
                await httpError(`DeepSeek verify file ${fileId}`, response),
            );
        }

        return true;
    }

    private async _uploadFile(
        file: AttachmentFile,
        mimeType: string,
        signal?: AbortSignal,
    ): Promise<DeepSeekRemoteFileRef> {
        const bytes = new Uint8Array(file.content.byteLength);
        bytes.set(file.content);

        const form = new FormData();
        form.append("file", new Blob([bytes], { type: mimeType }), file.name);
        form.append("purpose", DEEPSEEK_FILE_PURPOSE);

        if (this._expiresAfterSeconds !== null) {
            form.append("expires_after[anchor]", "created_at");
            form.append("expires_after[seconds]", String(this._expiresAfterSeconds));
        }

        let response: Response;
        try {
            response = await this._fetch(`${this._baseUrl}/files`, {
                method: "POST",
                headers: this._headers,
                body: form,
                signal,
            });
        } catch (error) {
            if (signal?.aborted === true) throw error;
            throw new SessionError(
                SessionErrorType.NetworkError,
                "DeepSeek upload file failed",
                error,
            );
        }

        if (!response.ok) {
            throw new SessionError(
                SessionErrorType.ProviderError,
                await httpError("DeepSeek upload file", response),
            );
        }

        let payload: unknown;
        try {
            payload = await response.json();
        } catch (error) {
            throw new SessionError(
                SessionErrorType.ProviderError,
                "DeepSeek upload file returned invalid JSON",
                error,
            );
        }

        if (!isRecord(payload) || typeof payload.id !== "string" || payload.id.length === 0) {
            throw new SessionError(
                SessionErrorType.ProviderError,
                "DeepSeek upload file response is missing id",
            );
        }

        const expiresAt = numberField(payload, "expires_at");

        return {
            kind: "remote-id",
            fileId: payload.id,
            name: file.name,
            mimeType,
            expiresAt: expiresAt === undefined ? undefined : expiresAt * 1000,
        };
    }
}

/** DeepSeek LLMProvider：OpenAI 兼容 Chat Completions + Files API */
export class DeepSeekLLMProvider extends LLMProvider {

    private readonly _baseUrl: string;
    private readonly _headers: Record<string, string>;
    private readonly _fetch: DeepSeekFetch;
    private readonly _modelProvider: DeepSeekModelProvider;
    private readonly _protocolAdapter: DeepSeekProtocolAdapter;
    private readonly _cloudFileManager: DeepSeekCloudFileManager;

    constructor(options: DeepSeekProviderOptions) {
        super();
        this._baseUrl = normalizeBaseUrl(options.baseUrl);
        this._headers = buildHeaders(options.apiKey, options.headers);
        this._fetch = resolveFetch(options.fetch);
        this._modelProvider = new DeepSeekModelProvider(options);
        this._protocolAdapter = new DeepSeekProtocolAdapter();
        this._cloudFileManager = new DeepSeekCloudFileManager({
            ...options,
            ...(options.files ?? {}),
        });
    }

    get modelProvider(): DeepSeekModelProvider { return this._modelProvider; }
    get protocolAdapter(): DeepSeekProtocolAdapter { return this._protocolAdapter; }
    override get cloudFileManager(): DeepSeekCloudFileManager { return this._cloudFileManager; }
    get title(): string { return "DeepSeek"; }

    override get supportsTools(): boolean { return true; }

    async send(
        messages: readonly Message[],
        options: SessionRuntimeOptions,
        turn?: ChatOptions,
    ): Promise<ChatResult> {
        if (options.model === undefined || options.model.length === 0) {
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "DeepSeek requires SessionRuntimeOptions.model",
            );
        }

        if (turn?.attachmentRefs !== undefined && turn.attachmentRefs.size > 0) {
            const model = this._modelProvider.availableModels?.find(
                (item) => item.id === options.model || item.name === options.model,
            );
            if (model !== undefined && !model.isVisionModel) {
                throw new SessionError(
                    SessionErrorType.InvalidRequest,
                    `DeepSeek model "${options.model}" does not support image attachments`,
                );
            }
        }

        const payload: Record<string, unknown> = {
            model: options.model,
            messages: this._protocolAdapter.toPayloads([...messages], turn?.attachmentRefs),
            stream: true,
            stream_options: { include_usage: true },
        };

        if (options.temperature !== undefined) {
            payload.temperature = options.temperature;
        }
        if (turn?.tools !== undefined && turn.tools.length > 0) {
            payload.tools = this._protocolAdapter.toolDefinitionsToPayload(turn.tools);
        }
        applyThinkingOptions(payload, options);

        let response: Response;
        try {
            response = await this._fetch(`${this._baseUrl}/chat/completions`, {
                method: "POST",
                headers: {
                    ...this._headers,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(payload),
                signal: turn?.signal,
            });
        } catch (error) {
            if (turn?.signal?.aborted === true) throw error;
            throw new SessionError(
                SessionErrorType.NetworkError,
                "DeepSeek chat request failed",
                error,
            );
        }

        if (!response.ok) {
            throw new SessionError(
                SessionErrorType.ProviderError,
                await httpError("DeepSeek /chat/completions", response),
            );
        }
        if (response.body === null) {
            throw new SessionError(
                SessionErrorType.ProviderError,
                "DeepSeek returned an empty response body",
            );
        }

        let content = "";
        let thinking = "";
        let usage: ChatUsage | undefined;
        let stopReason: ChatStopReason | undefined;
        let lastRaw: unknown;
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
                    "DeepSeek returned invalid SSE JSON",
                    error,
                );
            }
            lastRaw = raw;

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

                    case "tool_call_delta": {
                        const current = toolCalls.get(chunk.toolCall.index) ?? { argumentsText: "" };
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
                            chunk.message ?? "DeepSeek stream error",
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
                "Failed to read the DeepSeek stream",
                error,
            );
        } finally {
            await reader.cancel().catch(() => {
                // 读取结束/中断时取消流失败不影响结果
            });
            reader.releaseLock();
        }

        const calls: ToolCall[] = [...toolCalls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([index, call]) => {
                let params: Record<string, unknown> = {};
                if (call.argumentsText.trim().length > 0) {
                    try {
                        const parsed: unknown = JSON.parse(call.argumentsText);
                        if (!isRecord(parsed)) {
                            throw new Error("tool arguments should be an object");
                        }
                        params = parsed;
                    } catch (error) {
                        throw new SessionError(
                            SessionErrorType.ProviderError,
                            `Invalid DeepSeek tool arguments at index ${index}`,
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

/* ---------------------------------------------------------------------------
 * 通用辅助
 * ------------------------------------------------------------------------- */

function normalizeBaseUrl(baseUrl: string | undefined): string {
    const trimmed = (baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL).trim();
    const resolved = trimmed.length > 0 ? trimmed : DEEPSEEK_DEFAULT_BASE_URL;
    return resolved.replace(/\/+$/, "");
}

function buildHeaders(apiKey: string, headers: Record<string, string> | undefined): Record<string, string> {
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
        throw new InvalidParameterError("DeepSeek requires a non-empty API key");
    }

    return {
        Authorization: `Bearer ${apiKey.trim()}`,
        ...(headers ?? {}),
    };
}

function resolveFetch(fetchImpl: DeepSeekFetch | undefined): DeepSeekFetch {
    const resolved = fetchImpl ?? globalThis.fetch;
    if (typeof resolved !== "function") {
        throw new InvalidParameterError("DeepSeek requires a fetch implementation");
    }
    return resolved;
}

function resolveFileTtl(value: number | null | undefined): number | null {
    if (value === null) return null;

    const ttl = value ?? DEEPSEEK_DEFAULT_FILE_TTL_SECONDS;
    if (!Number.isInteger(ttl)
        || ttl < DEEPSEEK_MIN_FILE_TTL_SECONDS
        || ttl > DEEPSEEK_MAX_FILE_TTL_SECONDS) {
        throw new InvalidParameterError(
            `DeepSeek file expiresAfterSeconds must be an integer between `
            + `${DEEPSEEK_MIN_FILE_TTL_SECONDS} and ${DEEPSEEK_MAX_FILE_TTL_SECONDS}, or null`,
        );
    }

    return ttl;
}

function contentToText(content: MessageContent, context: string): string {
    if (typeof content === "string") return content;

    const pieces: string[] = [];
    for (const part of content) {
        if (part.type === "attachment") {
            throw new SessionError(
                SessionErrorType.InvalidData,
                `DeepSeek does not support attachments in ${context}`,
            );
        }
        pieces.push(part.text);
    }
    return pieces.join("\n");
}

function userContent(
    content: MessageContent,
    attachmentRefs: AttachmentWireMap | undefined,
): string | DeepSeekContentPart[] {
    if (typeof content === "string") return content;

    const parts: DeepSeekContentPart[] = [];

    for (const part of content) {
        if (part.type === "text") {
            parts.push({ type: "text", text: part.text });
            continue;
        }

        if (attachmentRefs === undefined) {
            throw new SessionError(
                SessionErrorType.InvalidData,
                `Missing DeepSeek attachment wire map for "${part.attachment.contentHash}"`,
            );
        }

        const ref = attachmentRefs.get(part.attachment.contentHash);
        if (ref === undefined) {
            throw new SessionError(
                SessionErrorType.InvalidData,
                `DeepSeek attachment reference was not resolved: ${part.attachment.contentHash}`,
            );
        }

        parts.push(attachmentToContentPart(ref));
    }

    return parts;
}

function attachmentToContentPart(ref: RemoteFileRef): DeepSeekContentPart {
    switch (ref.kind) {
        case "remote-id":
            return { type: "file", file_id: ref.fileId };

        case "url":
            return { type: "image_url", image_url: { url: ref.url } };

        case "inline": {
            const mimeType = detectImageMimeType(ref.data)
                ?? normalizeImageMimeType(ref.mimeType);
            if (mimeType === undefined) {
                throw new SessionError(
                    SessionErrorType.InvalidData,
                    `DeepSeek only supports JPEG/PNG/GIF/WebP images, got "${ref.mimeType ?? "unknown"}"`,
                );
            }
            return {
                type: "image_url",
                image_url: {
                    url: `data:${mimeType};base64,${toBase64(ref.data)}`,
                },
            };
        }
    }
}

function parseToolCalls(value: unknown): ToolCall[] {
    if (!Array.isArray(value)) return [];

    return value.map((entry, index) => {
        const record = isRecord(entry) ? entry : {};
        const fn = isRecord(record.function) ? record.function : {};
        const name = typeof fn.name === "string" ? fn.name : "";
        let params: Record<string, unknown> = {};

        if (isRecord(fn.arguments)) {
            params = { ...fn.arguments };
        } else if (typeof fn.arguments === "string" && fn.arguments.trim().length > 0) {
            try {
                const parsed: unknown = JSON.parse(fn.arguments);
                if (!isRecord(parsed)) {
                    throw new Error("tool arguments should be an object");
                }
                params = parsed;
            } catch (error) {
                throw new SessionError(
                    SessionErrorType.ProviderError,
                    `Invalid DeepSeek tool arguments at index ${index}`,
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

function parseUsage(value: unknown): ChatUsage | undefined {
    if (!isRecord(value)) return undefined;

    const prompt = typeof value.prompt_tokens === "number" ? value.prompt_tokens : undefined;
    const completion = typeof value.completion_tokens === "number" ? value.completion_tokens : undefined;
    if (prompt === undefined && completion === undefined) return undefined;

    const promptTokens = prompt ?? 0;
    const completionTokens = completion ?? 0;
    return {
        promptTokens,
        completionTokens,
        totalTokens: typeof value.total_tokens === "number"
            ? value.total_tokens
            : promptTokens + completionTokens,
    };
}

function parseStopReason(value: unknown): ChatStopReason | undefined {
    switch (value) {
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

function firstChoice(payload: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!Array.isArray(payload.choices) || payload.choices.length === 0) return undefined;
    const choice = payload.choices[0];
    return isRecord(choice) ? choice : undefined;
}

function applyThinkingOptions(payload: Record<string, unknown>, options: SessionRuntimeOptions): void {
    const level = normalizeThinkingLevel(options.thinkingLv);

    if (options.think === false || level === "none") {
        payload.thinking = { type: "disabled" };
        return;
    }

    if (options.think === true) {
        payload.thinking = { type: "enabled" };
    }

    if (level !== undefined) {
        payload.reasoning_effort = level;
    }
}

function normalizeThinkingLevel(value: unknown): "none" | "low" | "high" | "max" | undefined {
    if (typeof value === "number") {
        if (value <= 1) return "low";
        if (value <= 2) return "high";
        return "max";
    }
    if (typeof value !== "string") return undefined;

    switch (value.toLowerCase()) {
        case "none":
            return "none";
        case "minimal":
        case "low":
            return "low";
        case "medium":
        case "high":
        case "xhigh":
            return "high";
        case "max":
        case "ultra":
            return "max";
        default:
            return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
    const value = record[key];
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
}

async function httpError(action: string, response: Response): Promise<string> {
    const body = await response.text().catch(() => "");
    const detail = body.length > 0 ? `: ${body.slice(0, 500)}` : "";
    return `${action} returned HTTP ${response.status}${detail}`;
}
