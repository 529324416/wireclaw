import { InvalidParameterError, uniqueId } from "../../base";
import { SessionError, SessionErrorType } from "../../session/error";
import type { GeneratedMedia } from "../../session/media";
import { AIProvider } from "../../session/protocol";
import type {
    GenerationCapability,
    GenerationOptions,
    GenerationProgress,
    GenerationRequest,
    GenerationTask,
    GenerationTaskStatus,
    ModelInfo,
} from "../../session/protocol";
import { MINIMAX_DEFAULT_BASE_URL } from "./common";

/** H3 视频模型名 */
export const MINIMAX_H3_VIDEO_MODEL = "MiniMax-H3";

/** H3 视频的最小模型能力描述 */
export const MINIMAX_H3_VIDEO_MODEL_INFO: ModelInfo = {
    id: MINIMAX_H3_VIDEO_MODEL,
    name: MINIMAX_H3_VIDEO_MODEL,
    description: "MiniMax H3 text-to-video model",
    size: 0,
    supportCompletion: false,
    supportToolCall: false,
    supportThink: false,
    isVisionModel: false,
    isEmbeddingModel: false,
    capabilities: {
        generate: {
            image: false,
            audio: true,
            video: true,
            async: true,
            context: false,
        },
    },
};

export type MiniMaxH3VideoProviderOptions = {
    /** MiniMax API key；由宿主读取并注入 */
    apiKey: string;

    /** 默认 https://api.minimax.io；国内站可传 https://api.minimax.cn */
    baseUrl?: string;

    /** 默认 MiniMax-H3 */
    model?: string;

    /** 单次 HTTP 请求超时，默认 30s */
    requestTimeoutMs?: number;

    /** 轮询间隔，默认 10s */
    pollIntervalMs?: number;

    /** 最长等待时间，默认 15 分钟 */
    maxWaitMs?: number;

    /** 自定义 fetch */
    fetch?: typeof fetch;
};

type MiniMaxVideoState = {
    status: GenerationTaskStatus;
    progress?: GenerationProgress;
    media?: readonly GeneratedMedia[];
    error?: Error;
};

/** MiniMax H3 的异步视频生成能力
 *
 * generate() 只创建任务并返回 GenerationTask；
 * 调用方通过 task.wait() 轮询，或 task.cancel() 取消服务端任务。
 */
export class MiniMaxH3VideoProvider extends AIProvider implements GenerationCapability {

    private readonly _baseUrl: string;
    private readonly _apiKey: string;
    private readonly _model: string;
    private readonly _requestTimeoutMs: number;
    private readonly _pollIntervalMs: number;
    private readonly _maxWaitMs: number;
    private readonly _fetch: typeof fetch | undefined;

    constructor(options: MiniMaxH3VideoProviderOptions) {
        super();

        const apiKey = options.apiKey?.trim();
        if (apiKey === undefined || apiKey.length === 0) {
            throw new InvalidParameterError("MiniMaxH3VideoProvider requires an API key");
        }

        this._requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? 30_000, "requestTimeoutMs");
        this._pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 10_000, "pollIntervalMs");
        this._maxWaitMs = positiveInteger(options.maxWaitMs ?? 15 * 60 * 1000, "maxWaitMs");
        this._baseUrl = (options.baseUrl ?? MINIMAX_DEFAULT_BASE_URL).replace(/\/+$/, "");
        this._apiKey = apiKey;
        this._model = options.model ?? MINIMAX_H3_VIDEO_MODEL;
        this._fetch = options.fetch ?? (typeof fetch === "function" ? fetch : undefined);
    }

    get title(): string {
        return "MiniMax H3 Video";
    }

    get modelInfo(): ModelInfo {
        return {
            ...MINIMAX_H3_VIDEO_MODEL_INFO,
            id: this._model,
            name: this._model,
            capabilities: {
                generate: {
                    image: false,
                    audio: true,
                    video: true,
                    async: true,
                    context: false,
                },
            },
        };
    }

    async generate(
        request: GenerationRequest,
        options: GenerationOptions = {},
    ): Promise<GenerationTask> {
        if (request.modality !== "video") {
            throw new InvalidParameterError(
                `MiniMax H3 Video only supports video generation, got "${request.modality}"`,
            );
        }
        if (request.references !== undefined && request.references.length > 0) {
            throw new InvalidParameterError(
                "MiniMax H3 Video reference generation is not implemented yet",
            );
        }

        const payload = this._buildPayload(request);
        const response = await this._requestJson(
            "POST",
            "/v2/video_generation",
            payload,
            options.signal,
        );

        const taskId = response.task_id;
        if (typeof taskId !== "string" && typeof taskId !== "number") {
            throw new SessionError(
                SessionErrorType.ProviderError,
                "MiniMax H3 Video did not return task_id",
            );
        }

        return this.getTask(String(taskId), { onProgress: options.onProgress });
    }

    /** 重新绑定一个已存在的任务；用于进程重启后的任务恢复 */
    getTask(
        taskId: string,
        options: {
            pollIntervalMs?: number;
            maxWaitMs?: number;
            onProgress?: (progress: GenerationProgress) => void;
        } = {},
    ): GenerationTask {
        const id = taskId.trim();
        if (id.length === 0) {
            throw new InvalidParameterError("MiniMax H3 Video taskId must be non-empty");
        }

        const pollIntervalMs = options.pollIntervalMs === undefined
            ? this._pollIntervalMs
            : positiveInteger(options.pollIntervalMs, "pollIntervalMs");
        const maxWaitMs = options.maxWaitMs === undefined
            ? this._maxWaitMs
            : positiveInteger(options.maxWaitMs, "maxWaitMs");

        return new MiniMaxVideoTask(id, {
            pollIntervalMs,
            maxWaitMs,
            query: (signal) => this._queryTask(id, signal),
            cancel: (signal) => this._cancelTask(id, signal),
            onProgress: options.onProgress,
        });
    }

    private _buildPayload(request: GenerationRequest): Record<string, unknown> {
        const prompt = request.prompt.trim();
        if (prompt.length === 0) {
            throw new InvalidParameterError("MiniMax H3 Video requires a non-empty prompt");
        }

        const parameters = request.parameters ?? {};
        const duration = parameters.duration === undefined ? 4 : parameters.duration;
        if (!Number.isInteger(duration) || (duration as number) < 4 || (duration as number) > 15) {
            throw new InvalidParameterError(
                `duration must be an integer between 4 and 15 seconds, got ${String(duration)}`,
            );
        }

        const resolution = optionalString(parameters.resolution) ?? "768P";
        if (resolution !== "768P" && resolution !== "2K") {
            throw new InvalidParameterError(`Unsupported resolution: ${resolution}`);
        }

        const ratio = optionalString(parameters.ratio) ?? "16:9";
        if (!["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(ratio)) {
            throw new InvalidParameterError(`Unsupported ratio: ${ratio}`);
        }

        const payload: Record<string, unknown> = {
            model: this._model,
            content: [{ type: "text", text: prompt }],
            resolution,
            duration,
            ratio,
        };

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
        if (parameters.callback_url !== undefined) {
            if (typeof parameters.callback_url !== "string" || parameters.callback_url.length === 0) {
                throw new InvalidParameterError("callback_url must be a non-empty string");
            }
            payload.callback_url = parameters.callback_url;
        }

        return payload;
    }

    private async _queryTask(
        taskId: string,
        signal?: AbortSignal,
    ): Promise<MiniMaxVideoState> {
        const response = await this._requestJson(
            "GET",
            `/v2/query/video_generation/${encodeURIComponent(taskId)}`,
            undefined,
            signal,
        );

        // 查询接口可能返回 { task: {...} }，也可能直接返回任务对象
        const task = isRecord(response.task) ? response.task : response;
        const status = normalizeVideoStatus(task.status);
        const error = parseVideoError(task);
        const progress = parseProgress(task);
        const media = status === "succeeded" ? parseVideoMedia(task, taskId) : undefined;

        return {
            status,
            ...(progress === undefined ? {} : { progress }),
            ...(media === undefined ? {} : { media }),
            ...(error === undefined ? {} : { error }),
        };
    }

    private async _cancelTask(taskId: string, signal?: AbortSignal): Promise<void> {
        await this._requestJson(
            "DELETE",
            `/v2/video_generation/${encodeURIComponent(taskId)}`,
            undefined,
            signal,
            { allowNotFound: true },
        );
    }

    private async _requestJson(
        method: "GET" | "POST" | "DELETE",
        path: string,
        body: Record<string, unknown> | undefined,
        signal: AbortSignal | undefined,
        options: { allowNotFound?: boolean } = {},
    ): Promise<Record<string, unknown>> {
        if (this._fetch === undefined) {
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "MiniMax H3 Video requires a fetch implementation",
            );
        }

        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, this._requestTimeoutMs);

        const onAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener("abort", onAbort, { once: true });

        try {
            let response: Response;
            try {
                response = await this._fetch(`${this._baseUrl}${path}`, {
                    method,
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${this._apiKey}`,
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                    signal: controller.signal,
                });
            } catch (error) {
                if (signal?.aborted === true) throw error;
                if (timedOut) {
                    throw new SessionError(
                        SessionErrorType.NetworkError,
                        `MiniMax H3 Video request timed out after ${this._requestTimeoutMs}ms`,
                        error,
                    );
                }
                throw new SessionError(
                    SessionErrorType.NetworkError,
                    "MiniMax H3 Video request failed",
                    error,
                );
            }

            if (response.status === 404 && options.allowNotFound === true) {
                return {};
            }
            if (response.status === 204) {
                return {};
            }

            if (!response.ok) {
                const text = await response.text().catch(() => "");
                throw new SessionError(
                    SessionErrorType.ProviderError,
                    `MiniMax H3 Video returned HTTP ${response.status}`
                        + (text.length > 0 ? `: ${text.slice(0, 500)}` : ""),
                );
            }

            let parsed: unknown;
            try {
                parsed = await response.json();
            } catch (error) {
                throw new SessionError(
                    SessionErrorType.ProviderError,
                    "MiniMax H3 Video returned invalid JSON",
                    error,
                );
            }

            if (!isRecord(parsed)) {
                throw new SessionError(
                    SessionErrorType.ProviderError,
                    "MiniMax H3 Video returned an invalid response body",
                );
            }

            return parsed;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        }
    }
}

type MiniMaxVideoTaskOptions = {
    pollIntervalMs: number;
    maxWaitMs: number;
    query: (signal?: AbortSignal) => Promise<MiniMaxVideoState>;
    cancel: (signal?: AbortSignal) => Promise<void>;
    onProgress?: (progress: GenerationProgress) => void;
};

/** 可轮询、可取消的 H3 视频任务 */
class MiniMaxVideoTask implements GenerationTask {

    readonly id: string;
    private _status: GenerationTaskStatus = "queued";
    private _progress: GenerationProgress | undefined;
    private _result: readonly GeneratedMedia[] | undefined;
    private _error: Error | undefined;

    private readonly _pollIntervalMs: number;
    private readonly _maxWaitMs: number;
    private readonly _query: MiniMaxVideoTaskOptions["query"];
    private readonly _cancel: MiniMaxVideoTaskOptions["cancel"];
    private readonly _onProgress: MiniMaxVideoTaskOptions["onProgress"];

    constructor(id: string, options: MiniMaxVideoTaskOptions) {
        this.id = id.length > 0 ? id : uniqueId();
        this._pollIntervalMs = options.pollIntervalMs;
        this._maxWaitMs = options.maxWaitMs;
        this._query = options.query;
        this._cancel = options.cancel;
        this._onProgress = options.onProgress;
    }

    get status(): GenerationTaskStatus {
        return this._status;
    }

    get progress(): GenerationProgress | undefined {
        return this._progress;
    }

    get result(): readonly GeneratedMedia[] | undefined {
        return this._result;
    }

    get error(): Error | undefined {
        return this._error;
    }

    async cancel(): Promise<void> {
        if (this._status === "succeeded" || this._status === "failed" || this._status === "cancelled") {
            return;
        }
        await this._cancel();
        this._status = "cancelled";
        this._notify("cancelled");
    }

    async wait(
        options: { signal?: AbortSignal } = {},
    ): Promise<readonly GeneratedMedia[]> {
        if (this._status === "succeeded" && this._result !== undefined) {
            return this._result;
        }
        if (this._status === "failed") {
            throw this._error ?? new SessionError(
                SessionErrorType.ProviderError,
                "MiniMax H3 Video task failed",
            );
        }
        if (this._status === "cancelled") {
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "MiniMax H3 Video task was cancelled",
            );
        }

        const deadline = Date.now() + this._maxWaitMs;

        while (true) {
            await delay(this._pollIntervalMs, options.signal);

            if (Date.now() > deadline) {
                throw new SessionError(
                    SessionErrorType.NetworkError,
                    `MiniMax H3 Video task exceeded ${this._maxWaitMs}ms`,
                );
            }

            const state = await this._query(options.signal);
            this._apply(state);

            const status = this._status as GenerationTaskStatus;
            if (status === "succeeded" && this._result !== undefined) {
                return this._result;
            }
            if (status === "failed") {
                throw this._error ?? new SessionError(
                    SessionErrorType.ProviderError,
                    "MiniMax H3 Video task failed",
                );
            }
            if (status === "cancelled") {
                throw new SessionError(
                    SessionErrorType.InvalidRequest,
                    "MiniMax H3 Video task was cancelled",
                );
            }
        }
    }

    private _apply(state: MiniMaxVideoState): void {
        this._status = state.status;
        this._progress = state.progress;
        this._result = state.media;
        this._error = state.error;

        if (this._status === "failed" && this._error === undefined) {
            this._error = new SessionError(
                SessionErrorType.ProviderError,
                "MiniMax H3 Video task failed",
            );
        }

        this._notify(state.status);
    }

    private _notify(message: string): void {
        if (this._onProgress === undefined) return;

        const progress: GenerationProgress = {
            ...(this._progress ?? {}),
            message: this._progress?.message ?? message,
            updatedAt: Date.now(),
        };
        this._progress = progress;
        this._onProgress(progress);
    }
}

function normalizeVideoStatus(value: unknown): GenerationTaskStatus {
    const status = typeof value === "string" ? value.toLowerCase() : "";

    switch (status) {
        case "queued":
        case "pending":
        case "waiting":
            return "queued";
        case "running":
        case "processing":
        case "in_progress":
            return "running";
        case "succeeded":
        case "success":
        case "completed":
            return "succeeded";
        case "failed":
        case "error":
            return "failed";
        case "cancelled":
        case "canceled":
            return "cancelled";
        default:
            throw new SessionError(
                SessionErrorType.ProviderError,
                `MiniMax H3 Video returned unknown task status: ${String(value)}`,
            );
    }
}

function parseVideoError(response: Record<string, unknown>): Error | undefined {
    const error = response.error;
    if (typeof error === "string" && error.length > 0) {
        return new SessionError(SessionErrorType.ProviderError, error);
    }
    if (!isRecord(error)) return undefined;

    const message = typeof error.message === "string"
        ? error.message
        : "MiniMax H3 Video task failed";
    return new SessionError(SessionErrorType.ProviderError, message, error);
}

function parseProgress(response: Record<string, unknown>): GenerationProgress | undefined {
    const progress = response.progress;
    if (typeof progress !== "number" || !Number.isFinite(progress)) return undefined;

    const total = typeof response.total === "number" && Number.isFinite(response.total)
        ? response.total
        : undefined;

    return {
        progress,
        ...(total === undefined ? {} : { total }),
        updatedAt: Date.now(),
    };
}

function parseVideoMedia(
    response: Record<string, unknown>,
    taskId: string,
): readonly GeneratedMedia[] {
    const url = extractVideoUrl(response.content);
    if (url === undefined) {
        throw new SessionError(
            SessionErrorType.ProviderError,
            "MiniMax H3 Video succeeded but returned no video URL",
        );
    }

    return [{
        kind: "url",
        url,
        name: `minimax-h3-video-${taskId}.mp4`,
        mimeType: "video/mp4",
    }];
}

function extractVideoUrl(content: unknown): string | undefined {
    if (isRecord(content) && typeof content.url === "string" && content.url.length > 0) {
        return content.url;
    }
    if (Array.isArray(content)) {
        for (const item of content) {
            if (isRecord(item) && typeof item.url === "string" && item.url.length > 0) {
                return item.url;
            }
        }
    }
    return undefined;
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveInteger(value: number, field: string): number {
    if (!Number.isInteger(value) || value <= 0) {
        throw new InvalidParameterError(`${field} must be a positive integer, got ${String(value)}`);
    }
    return value;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
            reject(signal.reason);
            return;
        }

        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);

        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(signal?.reason);
        };

        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
