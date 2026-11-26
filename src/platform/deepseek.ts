import { InvalidParameterError } from "../base";
import { detectImageMimeType } from "../file";
import type { AttachmentFile } from "../session/attachment";
import { SessionError, SessionErrorType } from "../session/error";
import type { Message } from "../session";
import { CloudFileManager, ModelProvider, normalizeInputTypes } from "../session/protocol";
import type { ChatModelCapabilities, ModelInfo } from "../session";
import type {
    ChatOptions,
    RemoteFileRef,
    SessionRuntimeOptions,
} from "../session/type";
import {
    buildBearerHeaders,
    normalizeBaseUrl,
    resolveFetch,
} from "./shared/http";
import { OpenAIProtocolAdapter } from "./shared/openai/adapter";
import type { OpenAIContentPart } from "./shared/openai/adapter";
import { OpenAICompatibleProvider } from "./shared/openai/provider";

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

/** 将 DeepSeek 的 OpenAI 兼容响应/流转换为 Wireclaw 消息与片段 */
export class DeepSeekProtocolAdapter extends OpenAIProtocolAdapter {

    constructor() {
        super({ label: "DeepSeek" });
    }

    /** DeepSeek Files API 的远端文件使用 file 块引用 */
    protected override attachmentPart(ref: RemoteFileRef): OpenAIContentPart {
        if (ref.kind === "remote-id") {
            return { type: "file", file_id: ref.fileId };
        }
        return super.attachmentPart(ref);
    }
}

/** DeepSeek 模型目录提供者 */
export class DeepSeekModelProvider extends ModelProvider {

    private readonly _baseUrl: string;
    private readonly _headers: Record<string, string>;
    private readonly _fetch: DeepSeekFetch;

    constructor(options: DeepSeekEndpointOptions) {
        super();
        this._baseUrl = normalizeBaseUrl(options.baseUrl, DEEPSEEK_DEFAULT_BASE_URL);
        this._headers = buildBearerHeaders(options.apiKey, options.headers, "DeepSeek");
        this._fetch = resolveFetch(options.fetch, "DeepSeek");
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
        const input = normalizeInputTypes(modalities);

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
            isVisionModel: input.includes("image"),
            isEmbeddingModel: false,
            capabilities: {
                chat: {
                    input,
                    output: ["text"],
                    streaming: true,
                    tools: true,
                    thinking: supportThink,
                },
            },
            limits: {
                maxContextTokens: contextWindow,
                maxOutputTokens,
            },
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
                undefined,
                response.status,
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
        this._baseUrl = normalizeBaseUrl(options.baseUrl, DEEPSEEK_DEFAULT_BASE_URL);
        this._headers = buildBearerHeaders(options.apiKey, options.headers, "DeepSeek");
        this._fetch = resolveFetch(options.fetch, "DeepSeek");
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
                undefined,
                response.status,
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
                undefined,
                response.status,
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

/** DeepSeek Provider：OpenAI 兼容 Chat Completions + Files API */
export class DeepSeekProvider extends OpenAICompatibleProvider {

    private readonly _deepSeekModelProvider: DeepSeekModelProvider;
    private readonly _deepSeekProtocolAdapter: DeepSeekProtocolAdapter;
    private readonly _cloudFileManager: DeepSeekCloudFileManager;

    constructor(options: DeepSeekProviderOptions) {
        const modelProvider = new DeepSeekModelProvider(options);
        const protocolAdapter = new DeepSeekProtocolAdapter();

        super({
            label: "DeepSeek",
            baseUrl: normalizeBaseUrl(options.baseUrl, DEEPSEEK_DEFAULT_BASE_URL),
            apiKey: options.apiKey,
            headers: options.headers,
            fetch: options.fetch,
            chatPath: "/chat/completions",
            modelProvider,
            protocolAdapter,
        });

        this._deepSeekModelProvider = modelProvider;
        this._deepSeekProtocolAdapter = protocolAdapter;
        this._cloudFileManager = new DeepSeekCloudFileManager({
            ...options,
            ...(options.files ?? {}),
        });
    }

    override get modelProvider(): DeepSeekModelProvider { return this._deepSeekModelProvider; }

    override get protocolAdapter(): DeepSeekProtocolAdapter { return this._deepSeekProtocolAdapter; }

    override get cloudFileManager(): DeepSeekCloudFileManager { return this._cloudFileManager; }

    override async resolveDefaultModel(): Promise<string | undefined> {
        const models = this._deepSeekModelProvider.availableModels
            ?? await this._deepSeekModelProvider.initModels();
        const preferred = models.find(
            (model) => model.id === "deepseek-flash" || model.name === "deepseek-flash",
        ) ?? models.find(
            (model) => model.supportCompletion && !model.isEmbeddingModel,
        );

        return preferred === undefined ? undefined : (preferred.id || preferred.name);
    }

    protected override decoratePayload(
        payload: Record<string, unknown>,
        options: SessionRuntimeOptions,
        turn?: ChatOptions,
        chatCapabilities?: ChatModelCapabilities,
    ): void {
        super.decoratePayload(payload, options, turn, chatCapabilities);

        // 模型明确声明 thinking:false 时不发送思考参数；能力未知时保持旧行为。
        if (chatCapabilities?.thinking !== false) {
            applyThinkingOptions(payload, options);
        }
    }

    protected override checkChatOptions(
        _messages: readonly Message[],
        options: SessionRuntimeOptions,
        turn?: ChatOptions,
    ): void {
        if (turn?.attachmentRefs !== undefined && turn.attachmentRefs.size > 0) {
            const model = this._deepSeekModelProvider.availableModels?.find(
                (item) => item.id === options.model || item.name === options.model,
            );
            if (model !== undefined && !model.isVisionModel) {
                throw new SessionError(
                    SessionErrorType.InvalidRequest,
                    `DeepSeek model "${options.model}" does not support image attachments`,
                );
            }
        }
    }
}

/* ---------------------------------------------------------------------------
 * 通用辅助
 * ------------------------------------------------------------------------- */

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
