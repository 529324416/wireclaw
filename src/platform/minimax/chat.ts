import { uniqueId } from "../../base";
import { SessionError, SessionErrorType } from "../../session/error";
import { ModelProvider } from "../../session/protocol";
import type { ModelInfo, ModelModality } from "../../session/protocol";
import { ChatStopReason } from "../../session/type";
import type { ChatUsage, ToolCall } from "../../session/type";
import { OpenAIProtocolAdapter } from "../shared/openai/adapter";
import { OpenAICompatibleProvider } from "../shared/openai/provider";
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

/** MiniMax OpenAI 兼容 Chat Completions 适配器 */
export class MiniMaxProtocolAdapter extends OpenAIProtocolAdapter {

    constructor() {
        super({
            label: "MiniMax Chat",
            supportsAttachments: false,
            attachmentText: (context) =>
                `MiniMax Chat does not support attachments in ${context} yet`,
        });
    }

    /** MiniMax 同时返回 prompt_tokens / input_tokens 两种用量字段 */
    protected override parseUsage(value: unknown): ChatUsage | undefined {
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

    /** MiniMax 使用 end_turn / max_tokens 作为结束原因别名 */
    protected override parseStopReason(value: unknown): ChatStopReason | undefined {
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
                return super.parseStopReason(value);
        }
    }

    /** 非流式工具调用容错：忽略空名称与非法参数 JSON */
    protected override parseToolCalls(value: unknown): ToolCall[] {
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
export class MiniMaxChatProvider extends OpenAICompatibleProvider {

    private readonly _miniMaxModelProvider: MiniMaxModelProvider;
    private readonly _miniMaxProtocolAdapter: MiniMaxProtocolAdapter;
    private readonly _defaultModel: string;

    constructor(options: MiniMaxChatProviderOptions) {
        const apiKey = options.apiKey?.trim();
        if (apiKey === undefined || apiKey.length === 0) {
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "MiniMax Chat requires an API key",
            );
        }

        const timeoutMs = options.timeoutMs ?? 120_000;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                `timeoutMs must be a positive number, got ${String(options.timeoutMs)}`,
            );
        }

        const baseUrl = (options.baseUrl ?? MINIMAX_DEFAULT_BASE_URL).replace(/\/+$/, "");
        const headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            ...(options.headers ?? {}),
        };
        const modelProvider = new MiniMaxModelProvider(baseUrl, headers, options.fetch);
        const protocolAdapter = new MiniMaxProtocolAdapter();

        super({
            label: "MiniMax",
            title: "MiniMax",
            baseUrl,
            apiKey,
            headers: options.headers,
            fetch: options.fetch,
            timeoutMs,
            chatPath: "/v1/chat/completions",
            modelProvider,
            protocolAdapter,
            supportsTools: true,
            toolNameFallback: () => "unknown",
        });

        this._miniMaxModelProvider = modelProvider;
        this._miniMaxProtocolAdapter = protocolAdapter;
        this._defaultModel = options.model ?? MINIMAX_DEFAULT_CHAT_MODEL;
    }

    override get modelProvider(): MiniMaxModelProvider { return this._miniMaxModelProvider; }

    override get protocolAdapter(): MiniMaxProtocolAdapter { return this._miniMaxProtocolAdapter; }

    override async resolveDefaultModel(): Promise<string | undefined> {
        const models = this._miniMaxModelProvider.availableModels
            ?? await this._miniMaxModelProvider.initModels();
        const preferred = models.find((model) => model.id === this._defaultModel)
            ?? models.find((model) => model.id === MINIMAX_DEFAULT_CHAT_MODEL)
            ?? models.find((model) => model.id === "MiniMax-M3")
            ?? models.find((model) => model.id.startsWith("MiniMax-M3"))
            ?? models[0];
        return preferred?.id;
    }
}

function toModelInfo(raw: unknown): ModelInfo | null {
    if (!isRecord(raw)) return null;

    const id = typeof raw.id === "string" ? raw.id : "";
    if (id.length === 0) return null;

    const name = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : id;
    const input: ModelModality[] = ["text"];
    const output: ModelModality[] = ["text"];

    return {
        id,
        name,
        description: id,
        size: 0,
        supportCompletion: true,
        supportToolCall: true,
        supportThink: true,
        isVisionModel: false,
        isEmbeddingModel: false,
        capabilities: {
            chat: {
                input,
                output,
                streaming: true,
                tools: true,
                thinking: true,
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
