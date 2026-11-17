import { toBase64 } from "../../base";
import { normalizeImageMimeType } from "../../file";
import type { AttachmentFile } from "../../session/attachment";
import { SessionError, SessionErrorType } from "../../session/error";
import { detectMediaMimeType, mediaModalityFromMimeType } from "../../session/media";
import type { Message } from "../../session/message";
import { CloudFileManager, ModelProvider } from "../../session/protocol";
import type { ModelInfo } from "../../session/protocol";
import type {
    ChatOptions,
    ChatResult,
    RemoteFileRef,
    SessionRuntimeOptions,
} from "../../session/type";
import {
    buildBearerHeaders,
    httpError,
    normalizeBaseUrl,
    normalizeTimeout,
    resolveFetch,
} from "../shared/http";
import { OpenAIProtocolAdapter } from "../shared/openai/adapter";
import type { OpenAIContentPart } from "../shared/openai/adapter";
import { OpenAICompatibleProvider } from "../shared/openai/provider";
import {
    QWEN_DEFAULT_BASE_URL,
    QWEN_DEFAULT_CHAT_MODEL,
    isQwenImageModel,
} from "./common";

/** Qwen / DashScope 对话配置 */
export type QwenProviderOptions = {
    /** DashScope API key；由宿主读取并注入 */
    apiKey: string;

    /** OpenAI 兼容入口，默认国内站 */
    baseUrl?: string;

    /** 默认对话模型，默认 qwen-plus */
    model?: string;

    /** 自定义请求头 */
    headers?: Record<string, string>;

    /** 自定义 fetch */
    fetch?: typeof fetch;

    /** 对话请求超时，默认 120s */
    timeoutMs?: number;
};

/** Qwen 协议适配器：当前只支持图片输入，音频/视频按架构预留 */
export class QwenProtocolAdapter extends OpenAIProtocolAdapter {

    constructor() {
        super({ label: "Qwen" });
    }

    protected override attachmentPart(ref: RemoteFileRef): OpenAIContentPart {
        if (ref.kind === "remote-id"){
            throw new SessionError(
                SessionErrorType.UnsupportedInput,
                "Qwen does not support remote file attachments",
            );
        }

        const mimeType = ref.kind === "inline"
            ? (detectMediaMimeType(ref.data) ?? ref.mimeType)
            : ref.mimeType;
        const modality = mediaModalityFromMimeType(mimeType);

        if (modality === "audio"){
            const format = audioFormatForMimeType(mimeType);
            if (format === undefined){
                throw new SessionError(
                    SessionErrorType.UnsupportedMediaFormat,
                    `Qwen does not support audio format "${mimeType ?? "unknown"}"`,
                );
            }
            const data = ref.kind === "inline"
                ? `data:${mimeType};base64,${toBase64(ref.data)}`
                : ref.url;
            return { type: "input_audio", input_audio: { data, format } };
        }

        if (modality === "video"){
            const url = ref.kind === "inline"
                ? `data:${mimeType};base64,${toBase64(ref.data)}`
                : ref.url;
            return { type: "video_url", video_url: { url } };
        }

        return super.attachmentPart(ref);
    }
}

/** Qwen 输入附件转换器：DashScope 兼容入口使用 inline data URL，无需上传 */
export class QwenCloudFileManager extends CloudFileManager {

    async ensureFile(file: AttachmentFile): Promise<RemoteFileRef> {
        const mimeType = detectMediaMimeType(file.content)
            ?? normalizeImageMimeType(file.mimeType)
            ?? normalizeMimeType(file.mimeType);

        if (mimeType === undefined){
            throw new SessionError(
                SessionErrorType.UnsupportedMediaFormat,
                `Qwen does not support media format "${file.mimeType ?? "unknown"}"`,
            );
        }

        const normalized = normalizeMimeType(mimeType) ?? mimeType;
        const image = normalizeImageMimeType(normalized);
        if (image === undefined
            && !QWEN_AUDIO_MIME_TYPES.has(normalized)
            && !QWEN_VIDEO_MIME_TYPES.has(normalized)){
            throw new SessionError(
                SessionErrorType.UnsupportedMediaFormat,
                `Qwen does not support media format "${normalized}"`,
            );
        }

        const encodedSize = 4 * Math.ceil(file.size / 3);
        if (encodedSize > QWEN_MAX_INLINE_ENCODED_BYTES){
            throw new SessionError(
                SessionErrorType.InputLimitExceeded,
                `Qwen inline media exceeds ${QWEN_MAX_INLINE_ENCODED_BYTES} bytes after base64 encoding`,
            );
        }

        return {
            kind: "inline",
            data: file.content,
            name: file.name,
            mimeType: image ?? normalized,
        };
    }
}

/** Qwen 模型目录 */
export class QwenModelProvider extends ModelProvider {

    private readonly _baseUrl: string;
    private readonly _headers: Record<string, string>;
    private readonly _fetch: typeof fetch | undefined;
    private _cache: ModelInfo[] | undefined;

    constructor(
        baseUrl: string,
        headers: Record<string, string>,
        fetchImpl: typeof fetch | undefined,
    ){
        super();
        this._baseUrl = baseUrl.replace(/\/+$/, "");
        this._headers = { ...headers };
        this._fetch = fetchImpl;
    }

    async validateNetwork(): Promise<void>{
        this._cache = await this.fetchModels();
    }

    protected async fetchModels(): Promise<ModelInfo[]>{
        if (this._cache !== undefined) return this._cache;

        if (this._fetch === undefined){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "Qwen requires a fetch implementation",
            );
        }

        let response: Response;
        try{
            response = await this._fetch(`${this._baseUrl}/models`, {
                method: "GET",
                headers: this._headers,
            });
        }catch(error){
            throw new SessionError(
                SessionErrorType.NetworkError,
                "Qwen /models request failed",
                error,
            );
        }

        if (!response.ok){
            throw await httpError("Qwen /models", response);
        }

        let payload: unknown;
        try{
            payload = await response.json();
        }catch(error){
            throw new SessionError(
                SessionErrorType.ProviderError,
                "Qwen /models returned invalid JSON",
                error,
            );
        }

        if (!isRecord(payload) || !Array.isArray(payload.data)){
            throw new SessionError(
                SessionErrorType.ProviderError,
                "Qwen /models response is missing data",
            );
        }

        return payload.data
            .map((item) => toModelInfo(item))
            .filter((item): item is ModelInfo => item !== null);
    }
}

/** Qwen 对话 Provider
 *
 * 只处理 OpenAI 兼容 chat completions。qwen-image* 属于独立的 GenerationCapability，
 * 不允许从 chat 入口调用；选择生图模型时会直接报错。
 */
export class QwenChatProvider extends OpenAICompatibleProvider {

    private readonly _qwenModelProvider: QwenModelProvider;
    private readonly _qwenProtocolAdapter: QwenProtocolAdapter;
    private readonly _qwenCloudFileManager = new QwenCloudFileManager();
    private readonly _defaultModel: string;

    constructor(options: QwenProviderOptions){
        const apiKey = options.apiKey?.trim();
        if (apiKey === undefined || apiKey.length === 0){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "Qwen requires an API key",
            );
        }

        const baseUrl = normalizeBaseUrl(options.baseUrl, QWEN_DEFAULT_BASE_URL);
        const timeoutMs = normalizeTimeout(options.timeoutMs ?? 120_000, "Qwen") ?? 120_000;
        const headers = buildBearerHeaders(apiKey, options.headers, "Qwen");
        const fetchImpl = resolveFetch(options.fetch, "Qwen");

        const modelProvider = new QwenModelProvider(baseUrl, headers, fetchImpl);
        const protocolAdapter = new QwenProtocolAdapter();

        super({
            label: "Qwen",
            title: "Qwen",
            baseUrl,
            apiKey,
            headers: options.headers,
            fetch: options.fetch,
            timeoutMs,
            chatPath: "/chat/completions",
            modelProvider,
            protocolAdapter,
            supportsTools: true,
        });

        this._qwenModelProvider = modelProvider;
        this._qwenProtocolAdapter = protocolAdapter;
        this._defaultModel = options.model ?? QWEN_DEFAULT_CHAT_MODEL;
    }

    override get modelProvider(): QwenModelProvider{ return this._qwenModelProvider; }

    override get protocolAdapter(): QwenProtocolAdapter{ return this._qwenProtocolAdapter; }

    override get cloudFileManager(): QwenCloudFileManager{ return this._qwenCloudFileManager; }

    override async resolveDefaultModel(): Promise<string | undefined>{
        const models = this._qwenModelProvider.availableModels
            ?? await this._qwenModelProvider.initModels();
        const preferred = models.find((model) => model.id === this._defaultModel)
            ?? models.find((model) => model.supportCompletion
                && !model.isEmbeddingModel
                && !isQwenImageModel(model.id))
            ?? models[0];
        return preferred?.id;
    }

    override async chat(
        messages: readonly Message[],
        options: SessionRuntimeOptions,
        turn?: ChatOptions,
    ): Promise<ChatResult>{
        if (isQwenImageModel(options.model)){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                `Qwen model "${options.model}" is an image generation model and cannot be used for chat; `
                    + "use QwenImageProvider instead",
            );
        }
        return await super.chat(messages, options, turn);
    }

    protected override decoratePayload(
        payload: Record<string, unknown>,
        options: SessionRuntimeOptions,
        turn?: ChatOptions,
    ): void{
        super.decoratePayload(payload, options, turn);
        // Omni 默认可能输出音频；本轮只消费文本
        if (options.model?.toLowerCase().includes("omni")){
            payload.modalities = ["text"];
        }
    }
}

function toModelInfo(raw: unknown): ModelInfo | null{
    if (!isRecord(raw)) return null;

    const id = typeof raw.id === "string" ? raw.id : "";
    if (id.length === 0) return null;

    const name = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : id;
    return modelInfoFromId(id, name);
}

function modelInfoFromId(id: string, name: string): ModelInfo{
    const image = isQwenImageModel(id);

    return {
        id,
        name,
        description: id,
        size: 0,
        supportCompletion: !image,
        supportToolCall: !image,
        supportThink: false,
        isVisionModel: false,
        isEmbeddingModel: false,
        capabilities: image
            ? {
                generate: {
                    input: ["text"],
                    output: ["image"],
                    image: true,
                    audio: false,
                    video: false,
                    async: false,
                },
            }
            : {
                chat: {
                    input: ["text"],
                    output: ["text"],
                    streaming: true,
                    tools: true,
                },
            },
    };
}

const QWEN_MAX_INLINE_ENCODED_BYTES = 10 * 1024 * 1024;

const QWEN_AUDIO_MIME_TYPES = new Set([
    "audio/amr",
    "audio/wav",
    "audio/x-wav",
    "audio/3gpp",
    "audio/aac",
    "audio/mpeg",
    "audio/mp3",
]);

const QWEN_VIDEO_MIME_TYPES = new Set([
    "video/mp4",
    "video/quicktime",
    "video/3gpp",
    "video/x-msvideo",
    "video/x-matroska",
    "video/x-flv",
    "video/x-ms-wmv",
]);

function normalizeMimeType(value: string | undefined): string | undefined{
    if (value === undefined) return undefined;
    const normalized = value.split(";")[0]?.trim().toLowerCase();
    if (normalized === undefined || normalized.length === 0) return undefined;

    switch (normalized){
        case "audio/x-wav":
            return "audio/wav";
        case "audio/mp3":
            return "audio/mpeg";
        case "video/avi":
            return "video/x-msvideo";
        default:
            return normalized;
    }
}

function audioFormatForMimeType(value: string | undefined): string | undefined{
    switch (normalizeMimeType(value)){
        case "audio/wav":
            return "wav";
        case "audio/mpeg":
            return "mp3";
        case "audio/aac":
            return "aac";
        case "audio/amr":
            return "amr";
        case "audio/3gpp":
            return "3gp";
        default:
            return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown>{
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
