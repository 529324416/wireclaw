import { fromBase64, InvalidParameterError, uniqueId } from "../../base";
import { SessionError, SessionErrorType } from "../../session/error";
import { detectMediaMimeType, normalizeMediaName } from "../../session/media";
import type { GeneratedMedia } from "../../session/media";
import { AIProvider } from "../../session/protocol";
import type {
    GenerationCapability,
    GenerationOptions,
    GenerationRequest,
    GenerationTask,
    ModelInfo,
} from "../../session/protocol";
import { MINIMAX_DEFAULT_BASE_URL } from "./common";

/** H3-Image 模型名 */
export const MINIMAX_H3_IMAGE_MODEL = "MiniMax-H3-Image";

/** H3-Image 高速版模型名 */
export const MINIMAX_H3_IMAGE_HIGHSPEED_MODEL = "MiniMax-H3-Image-Highspeed";

/** H3-Image 的最小模型能力描述 */
export const MINIMAX_H3_IMAGE_MODEL_INFO: ModelInfo = {
    id: MINIMAX_H3_IMAGE_MODEL,
    name: MINIMAX_H3_IMAGE_MODEL,
    description: "MiniMax H3 text-to-image model",
    size: 0,
    supportCompletion: false,
    supportToolCall: false,
    supportThink: false,
    isVisionModel: false,
    isEmbeddingModel: false,
    capabilities: {
        generate: {
            image: true,
            audio: false,
            video: false,
            async: false,
            context: false,
        },
    },
};

export type MiniMaxH3ImageProviderOptions = {
    /** MiniMax API key；由宿主读取并注入，Provider 不读文件 */
    apiKey: string;

    /** 默认 https://api.minimax.io；国内站可传 https://api.minimaxi.com */
    baseUrl?: string;

    /** 默认 MiniMax-H3-Image */
    model?: string;

    /** 单次请求超时；H3-Image 服务端最长等待 600s */
    timeoutMs?: number;

    /** 自定义 fetch；浏览器/Electron 可注入宿主代理 */
    fetch?: typeof fetch;
};

type MiniMaxImageData = {
    url?: string;
    b64_json?: string;
    size?: string;
    output_format?: string;
    revised_prompt?: string;
};

type MiniMaxImageResponse = {
    id?: string;
    data?: MiniMaxImageData[];
    usage?: Record<string, unknown>;
};

/** MiniMax H3-Image 的 GenerationCapability 实现
 *
 * 这是纯生成模型：不实现 ChatCapability，也不持有会话历史。
 * 结果通过 GeneratedMedia 返回，由 GenerationRuntime/Session 决定如何落盘。
 */
export class MiniMaxH3ImageProvider extends AIProvider implements GenerationCapability {

    private readonly _baseUrl: string;
    private readonly _apiKey: string;
    private readonly _model: string;
    private readonly _timeoutMs: number;
    private readonly _fetch: typeof fetch | undefined;

    constructor(options: MiniMaxH3ImageProviderOptions) {
        super();

        const apiKey = options.apiKey?.trim();
        if (apiKey === undefined || apiKey.length === 0) {
            throw new InvalidParameterError("MiniMaxH3ImageProvider requires an API key");
        }

        const timeoutMs = options.timeoutMs ?? 600_000;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            throw new InvalidParameterError(
                `timeoutMs must be a positive number, got ${String(options.timeoutMs)}`,
            );
        }

        this._baseUrl = (options.baseUrl ?? MINIMAX_DEFAULT_BASE_URL).replace(/\/+$/, "");
        this._apiKey = apiKey;
        this._model = options.model ?? MINIMAX_H3_IMAGE_MODEL;
        this._timeoutMs = Math.floor(timeoutMs);
        this._fetch = options.fetch ?? (typeof fetch === "function" ? fetch : undefined);
    }

    get title(): string {
        return "MiniMax H3 Image";
    }

    get modelInfo(): ModelInfo {
        return {
            ...MINIMAX_H3_IMAGE_MODEL_INFO,
            id: this._model,
            name: this._model,
            capabilities: {
                generate: {
                    image: true,
                    audio: false,
                    video: false,
                    async: false,
                    context: false,
                },
            },
        };
    }

    async generate(
        request: GenerationRequest,
        options: GenerationOptions = {},
    ): Promise<GenerationTask> {
        if (request.modality !== "image") {
            throw new InvalidParameterError(
                `MiniMax H3-Image only supports image generation, got "${request.modality}"`,
            );
        }
        if (request.references !== undefined && request.references.length > 0) {
            throw new InvalidParameterError(
                "MiniMax H3-Image text-to-image currently does not support reference images",
            );
        }

        const payload = this._buildPayload(request);
        const response = await this._request(payload, options.signal);
        const requestedFormat = typeof payload.output_format === "string"
            ? payload.output_format
            : "png";
        const media = this._parseResponse(response, requestedFormat);

        return new CompletedGenerationTask(response.id ?? uniqueId(), media);
    }

    private _buildPayload(request: GenerationRequest): Record<string, unknown> {
        const prompt = request.prompt.trim();
        if (prompt.length === 0) {
            throw new InvalidParameterError("MiniMax H3-Image requires a non-empty prompt");
        }

        const parameters = request.parameters ?? {};
        const size = optionalString(parameters.size);
        const aspectRatio = optionalString(parameters.aspect_ratio);
        const area = optionalString(parameters.area);

        if (size !== undefined && (aspectRatio !== undefined || area !== undefined)) {
            throw new InvalidParameterError(
                "Use either size or area/aspect_ratio for MiniMax H3-Image, not both",
            );
        }

        const n = parameters.n === undefined ? 1 : parameters.n;
        if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 10) {
            throw new InvalidParameterError(`n must be an integer between 1 and 10, got ${String(n)}`);
        }

        const outputFormat = optionalString(parameters.output_format) ?? "png";
        if (!["png", "jpeg", "webp"].includes(outputFormat)) {
            throw new InvalidParameterError(`Unsupported output_format: ${outputFormat}`);
        }

        const responseFormat = optionalString(parameters.response_format) ?? "url";
        if (responseFormat !== "url" && responseFormat !== "b64_json") {
            throw new InvalidParameterError(`Unsupported response_format: ${responseFormat}`);
        }

        if (parameters.stream === true) {
            throw new InvalidParameterError("MiniMax H3-Image streaming is not supported yet");
        }

        const payload: Record<string, unknown> = {
            model: this._model,
            prompt,
            n,
            output_format: outputFormat,
            response_format: responseFormat,
            stream: false,
        };

        if (size !== undefined) {
            payload.size = size;
        } else {
            payload.area = area ?? "1K";
            if (aspectRatio !== undefined) payload.aspect_ratio = aspectRatio;
        }

        if (parameters.seed !== undefined) {
            if (!Number.isInteger(parameters.seed)) {
                throw new InvalidParameterError("seed must be an integer");
            }
            payload.seed = parameters.seed;
        }
        if (parameters.aigc_watermark !== undefined) {
            if (typeof parameters.aigc_watermark !== "boolean") {
                throw new InvalidParameterError("aigc_watermark must be a boolean");
            }
            payload.aigc_watermark = parameters.aigc_watermark;
        }

        return payload;
    }

    private async _request(
        payload: Record<string, unknown>,
        signal: AbortSignal | undefined,
    ): Promise<MiniMaxImageResponse> {
        if (this._fetch === undefined) {
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "MiniMax H3-Image requires a fetch implementation",
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
                response = await this._fetch(`${this._baseUrl}/v1/images/generations`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${this._apiKey}`,
                    },
                    body: JSON.stringify(payload),
                    signal: controller.signal,
                });
            } catch (error) {
                if (signal?.aborted === true) throw error;
                if (timedOut) {
                    throw new SessionError(
                        SessionErrorType.NetworkError,
                        `MiniMax H3-Image request timed out after ${this._timeoutMs}ms`,
                        error,
                    );
                }
                throw new SessionError(
                    SessionErrorType.NetworkError,
                    "MiniMax H3-Image request failed",
                    error,
                );
            }

            if (!response.ok) {
                const body = await response.text().catch(() => "");
                throw new SessionError(
                    SessionErrorType.ProviderError,
                    `MiniMax H3-Image returned HTTP ${response.status}`
                        + (body.length > 0 ? `: ${body.slice(0, 500)}` : ""),
                );
            }

            let parsed: unknown;
            try {
                parsed = await response.json();
            } catch (error) {
                throw new SessionError(
                    SessionErrorType.ProviderError,
                    "MiniMax H3-Image returned invalid JSON",
                    error,
                );
            }

            if (!isRecord(parsed)) {
                throw new SessionError(
                    SessionErrorType.ProviderError,
                    "MiniMax H3-Image returned an invalid response body",
                );
            }

            return parsed as MiniMaxImageResponse;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        }
    }

    private _parseResponse(
        response: MiniMaxImageResponse,
        requestedFormat: string,
    ): GeneratedMedia[] {
        const data = Array.isArray(response.data) ? response.data : [];
        if (data.length === 0) {
            throw new SessionError(
                SessionErrorType.ProviderError,
                "MiniMax H3-Image returned no images",
            );
        }

        const media: GeneratedMedia[] = [];
        for (const [index, item] of data.entries()) {
            const outputFormat = item.output_format ?? requestedFormat;
            const mimeType = mimeTypeOf(outputFormat);
            const name = `minimax-h3-image-${index}.${extensionOf(outputFormat)}`;

            if (typeof item.b64_json === "string" && item.b64_json.length > 0) {
                let dataBytes: Uint8Array;
                try {
                    dataBytes = fromBase64(item.b64_json);
                } catch (error) {
                    throw new SessionError(
                        SessionErrorType.ProviderError,
                        "MiniMax H3-Image returned invalid base64 data",
                        error,
                    );
                }
                const actualMime = detectMediaMimeType(dataBytes) ?? mimeType;
                media.push({
                    kind: "bytes",
                    name: normalizeMediaName(name, actualMime),
                    mimeType: actualMime,
                    data: dataBytes,
                });
                continue;
            }

            if (typeof item.url === "string" && item.url.length > 0) {
                media.push({
                    kind: "url",
                    url: item.url,
                    name,
                    mimeType,
                });
                continue;
            }

            throw new SessionError(
                SessionErrorType.ProviderError,
                `MiniMax H3-Image result ${index} contains neither url nor b64_json`,
            );
        }

        return media;
    }
}

class CompletedGenerationTask implements GenerationTask {
    readonly status = "succeeded" as const;
    readonly result: readonly GeneratedMedia[];

    constructor(
        readonly id: string,
        result: readonly GeneratedMedia[],
    ) {
        this.result = result;
    }

    async cancel(): Promise<void> {
        // 同步接口已经完成，没有可取消的服务端任务
    }

    async wait(): Promise<readonly GeneratedMedia[]> {
        return this.result;
    }
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mimeTypeOf(format: string): string {
    switch (format.toLowerCase()) {
        case "png": return "image/png";
        case "webp": return "image/webp";
        case "jpeg":
        case "jpg": return "image/jpeg";
        default: return "application/octet-stream";
    }
}

function extensionOf(format: string): string {
    const normalized = format.toLowerCase();
    return normalized === "jpeg" || normalized === "jpg" ? "jpg" : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
