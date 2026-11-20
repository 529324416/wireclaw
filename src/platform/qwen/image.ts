import { uniqueId } from "../../base";
import { SessionError, SessionErrorType } from "../../session/error";
import type { GeneratedMedia } from "../../session/media";
import { AIProvider } from "../../session/protocol";
import type {
    GenerationCapability,
    GenerationOptions,
    GenerationRequest,
    GenerationTask,
    GenerationTaskStatus,
    ModelInfo,
} from "../../session/protocol";
import {
    buildBearerHeaders,
    createRequestSignal,
    httpError,
    normalizeBaseUrl,
    normalizeTimeout,
    resolveFetch,
} from "../shared/http";
import {
    QWEN_DEFAULT_BASE_URL,
    QWEN_DEFAULT_IMAGE_COUNT,
    QWEN_DEFAULT_IMAGE_MODEL,
    QWEN_DEFAULT_IMAGE_SIZE,
    resolveQwenImageEndpoint,
} from "./common";

export type QwenImageProviderOptions = {
    /** DashScope API key；由宿主读取并注入 */
    apiKey: string;

    /** OpenAI 兼容入口，用于同账号体系；默认国内站 */
    baseUrl?: string;

    /** 生图端点；不传时由 baseUrl 推导 */
    imageBaseUrl?: string;

    /** 生图模型，默认 qwen-image-2.0 */
    model?: string;

    /** 默认尺寸，默认 1024*1024 */
    size?: string;

    /** 默认数量，默认 1 */
    count?: number;

    /** 自定义请求头 */
    headers?: Record<string, string>;

    /** 自定义 fetch */
    fetch?: typeof fetch;

    /** 请求超时，默认 600s */
    timeoutMs?: number;
};

/** Qwen 生图模型：只实现 GenerationCapability，不实现 ChatCapability
 *
 * qwen-image* 是独立的生图端点（multimodal-generation），虽然请求体是 messages 形式，
 * 但不支持多轮对话、工具调用或自由文本推理。需要会话级生图时，应由宿主用工具/编排
 * 方式调用本 Provider，而不是把生图模型塞进 chat 路由。
 */
export class QwenImageProvider extends AIProvider implements GenerationCapability {

    private readonly _model: string;
    private readonly _size: string;
    private readonly _count: number;
    private readonly _headers: Record<string, string>;
    private readonly _fetch: typeof fetch;
    private readonly _timeoutMs: number;
    private readonly _endpoint: string;

    constructor(options: QwenImageProviderOptions){
        super();

        const apiKey = options.apiKey?.trim();
        if (apiKey === undefined || apiKey.length === 0){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "Qwen image requires an API key",
            );
        }

        const count = options.count ?? QWEN_DEFAULT_IMAGE_COUNT;
        if (!Number.isInteger(count) || count < 1 || count > 6){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                `Qwen image count must be an integer between 1 and 6, got ${String(options.count)}`,
            );
        }

        const baseUrl = normalizeBaseUrl(options.baseUrl, QWEN_DEFAULT_BASE_URL);
        this._model = options.model ?? QWEN_DEFAULT_IMAGE_MODEL;
        this._size = options.size ?? QWEN_DEFAULT_IMAGE_SIZE;
        this._count = count;
        this._headers = {
            ...buildBearerHeaders(apiKey, options.headers, "Qwen image"),
            "Content-Type": "application/json",
        };
        this._fetch = resolveFetch(options.fetch, "Qwen image");
        this._timeoutMs = normalizeTimeout(options.timeoutMs ?? 600_000, "Qwen image") ?? 600_000;
        this._endpoint = options.imageBaseUrl === undefined
            ? resolveQwenImageEndpoint(baseUrl)
            : options.imageBaseUrl.replace(/\/+$/, "");
    }

    get title(): string{
        return "Qwen Image";
    }

    get modelInfo(): ModelInfo{
        return {
            id: this._model,
            name: this._model,
            description: "Qwen image generation model",
            size: 0,
            supportCompletion: false,
            supportToolCall: false,
            supportThink: false,
            isVisionModel: false,
            isEmbeddingModel: false,
            capabilities: {
                generate: {
                    input: ["text"],
                    output: ["image"],
                    image: true,
                    audio: false,
                    video: false,
                    async: false,
                },
            },
        };
    }

    async generate(
        request: GenerationRequest,
        options: GenerationOptions = {},
    ): Promise<GenerationTask>{
        if (request.modality !== "image"){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                `Qwen image only supports image generation, got "${request.modality}"`,
            );
        }
        if ((request.references?.length ?? 0) > 0
            || (request.referenceFiles?.length ?? 0) > 0
            || (request.referenceUrls?.length ?? 0) > 0){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "Qwen image reference/editing is not implemented yet",
            );
        }

        const prompt = request.prompt.trim();
        if (prompt.length === 0){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "Qwen image generation requires a non-empty prompt",
            );
        }

        const parameters = request.parameters ?? {};
        const size = typeof parameters.size === "string" && parameters.size.length > 0
            ? parameters.size
            : this._size;
        const count = parameters.n ?? this._count;
        if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 6){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                `Qwen image n must be an integer between 1 and 6, got ${String(count)}`,
            );
        }

        const requestBody: Record<string, unknown> = {
            model: this._model,
            input: {
                messages: [{
                    role: "user",
                    content: [{ text: prompt }],
                }],
            },
            parameters: {
                size,
                n: count,
                prompt_extend: true,
                watermark: false,
            },
        };

        const requestSignal = createRequestSignal(options.signal, this._timeoutMs);
        let response: Response;
        try{
            response = await this._fetch(this._endpoint, {
                method: "POST",
                headers: this._headers,
                body: JSON.stringify(requestBody),
                signal: requestSignal.signal,
            });
        }catch(error){
            if (options.signal?.aborted === true) throw error;
            if (requestSignal.timedOut()){
                throw new SessionError(
                    SessionErrorType.NetworkError,
                    `Qwen image generation timed out after ${String(this._timeoutMs)}ms`,
                    error,
                );
            }
            throw new SessionError(
                SessionErrorType.NetworkError,
                "Qwen image generation request failed",
                error,
            );
        }finally{
            requestSignal.cleanup();
        }

        if (!response.ok){
            throw await httpError("Qwen image generation", response);
        }

        let payload: unknown;
        try{
            payload = await response.json();
        }catch(error){
            throw new SessionError(
                SessionErrorType.ProviderError,
                "Qwen image generation returned invalid JSON",
                error,
            );
        }

        const parsed = parseImageResponse(payload);
        options.onProgress?.({
            progress: 1,
            total: 1,
            message: "image generated",
            updatedAt: Date.now(),
        });

        return new QwenImageTask(parsed.requestId ?? uniqueId(), parsed.media);
    }
}

class QwenImageTask implements GenerationTask {

    readonly id: string;
    readonly status: GenerationTaskStatus = "succeeded";
    readonly result: readonly GeneratedMedia[];

    constructor(id: string, result: readonly GeneratedMedia[]){
        this.id = id;
        this.result = result;
    }

    async cancel(): Promise<void>{
        // 同步生图没有可取消的远端任务
    }

    async wait(): Promise<readonly GeneratedMedia[]>{
        return this.result;
    }
}

function parseImageResponse(payload: unknown): {
    media: GeneratedMedia[];
    requestId?: string;
} {
    if (!isRecord(payload)){
        throw new SessionError(
            SessionErrorType.ProviderError,
            "Invalid Qwen image generation response",
        );
    }

    const output = isRecord(payload.output) ? payload.output : {};
    const images: string[] = [];

    if (Array.isArray(output.choices)){
        for (const choice of output.choices){
            if (!isRecord(choice)) continue;
            const message = isRecord(choice.message) ? choice.message : {};
            if (!Array.isArray(message.content)) continue;

            for (const part of message.content){
                if (isRecord(part) && typeof part.image === "string" && part.image.length > 0){
                    images.push(part.image);
                }
            }
        }
    }

    if (images.length === 0 && Array.isArray(output.results)){
        for (const result of output.results){
            if (isRecord(result) && typeof result.url === "string" && result.url.length > 0){
                images.push(result.url);
            }
        }
    }

    if (images.length === 0){
        throw new SessionError(
            SessionErrorType.ProviderError,
            "Qwen image generation returned no images",
        );
    }

    return {
        media: images.map((url, index) => ({
            kind: "url",
            url,
            name: `qwen-image-${index}.png`,
            mimeType: "image/png",
        })),
        requestId: typeof payload.request_id === "string" && payload.request_id.length > 0
            ? payload.request_id
            : undefined,
    };
}

function isRecord(value: unknown): value is Record<string, unknown>{
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
