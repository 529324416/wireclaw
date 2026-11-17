import { SessionError, SessionErrorType } from "../../../session/error";
import type { Message } from "../../../session/message";
import { AIProvider } from "../../../session/protocol";
import type { ChatCapability, ModelProvider } from "../../../session/protocol";
import type {
    ChatOptions,
    ChatResult,
    SessionRuntimeOptions,
} from "../../../session/type";
import {
    buildBearerHeaders,
    createRequestSignal,
    httpError,
    normalizeBaseUrl,
    normalizeTimeout,
    resolveFetch,
} from "../http";
import { consumeChatStream } from "../stream";
import type { OpenAIProtocolAdapter } from "./adapter";

export type OpenAICompatibleProviderOptions = {
    /** 平台名称，用于错误消息与默认 title */
    label: string;

    /** UI 展示名称；默认与 label 相同 */
    title?: string;

    /** 平台 base URL；尾部斜杠会被去掉 */
    baseUrl: string;

    /** API key；由宿主读取并注入 */
    apiKey: string;

    /** 额外请求头 */
    headers?: Record<string, string>;

    /** 自定义 fetch；浏览器/Electron 可注入宿主代理 */
    fetch?: typeof fetch;

    /** 单次请求超时；不设置表示不主动超时 */
    timeoutMs?: number;

    /** chat 端点路径，默认 /chat/completions */
    chatPath?: string;

    /** 模型目录；由平台实现提供 */
    modelProvider: ModelProvider;

    /** 平台协议适配器 */
    protocolAdapter: OpenAIProtocolAdapter;

    /** 是否支持工具调用，默认 true */
    supportsTools?: boolean;

    /** 是否请求流式 usage，默认 true */
    includeStreamUsage?: boolean;

    /** 流式工具调用缺少名称时的兜底；默认 tool_<index> */
    toolNameFallback?: (index: number) => string;
};

/**
 * OpenAI 兼容对话 Provider 基类。
 *
 * 负责：鉴权头、端点、请求体骨架、超时/取消、HTTP 错误映射、SSE 流聚合。
 * 平台差异通过覆写 buildPayload / decoratePayload / checkChatOptions / 适配器方法表达。
 */
export class OpenAICompatibleProvider extends AIProvider implements ChatCapability{

    private readonly _label: string;
    private readonly _title: string;
    private readonly _baseUrl: string;
    private readonly _headers: Record<string, string>;
    private readonly _fetch: typeof fetch;
    private readonly _timeoutMs: number | undefined;
    private readonly _chatPath: string;
    private readonly _modelProvider: ModelProvider;
    private readonly _protocolAdapter: OpenAIProtocolAdapter;
    private readonly _supportsTools: boolean;
    private readonly _includeStreamUsage: boolean;
    private readonly _toolNameFallback: (index: number) => string;

    constructor(options: OpenAICompatibleProviderOptions){
        super();

        this._label = options.label;
        this._title = options.title ?? options.label;
        this._baseUrl = normalizeBaseUrl(options.baseUrl, options.baseUrl);
        this._headers = buildBearerHeaders(options.apiKey, options.headers, options.label);
        this._fetch = resolveFetch(options.fetch, options.label);
        this._timeoutMs = normalizeTimeout(options.timeoutMs, options.label);
        this._chatPath = options.chatPath === undefined
            ? "/chat/completions"
            : `/${options.chatPath.replace(/^\/+/, "")}`;
        this._modelProvider = options.modelProvider;
        this._protocolAdapter = options.protocolAdapter;
        this._supportsTools = options.supportsTools ?? true;
        this._includeStreamUsage = options.includeStreamUsage ?? true;
        this._toolNameFallback = options.toolNameFallback ?? ((index: number) => `tool_${index}`);
    }

    get title(): string{ return this._title; }

    override get modelProvider(): ModelProvider{ return this._modelProvider; }

    get protocolAdapter(): OpenAIProtocolAdapter{ return this._protocolAdapter; }

    override get supportsTools(): boolean{ return this._supportsTools; }

    async chat(
        messages: readonly Message[],
        options: SessionRuntimeOptions,
        turn?: ChatOptions,
    ): Promise<ChatResult>{
        if (options.model === undefined || options.model.length === 0){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                `${this._label} requires SessionRuntimeOptions.model`,
            );
        }

        this.checkChatOptions(messages, options, turn);

        const payload = this.buildPayload(messages, options, turn);
        const response = await this.postChat(payload, turn?.signal);

        const { message, raw } = await consumeChatStream(response, {
            format: "sse",
            label: this._label,
            adapter: this._protocolAdapter,
            turn,
            invalidJsonMessage: `${this._label} returned invalid SSE JSON`,
            toolNameFallback: this._toolNameFallback,
            invalidToolArgumentsMessage: (index) =>
                `Invalid ${this._label} tool arguments at index ${index}`,
            streamErrorMessage: (message) => message ?? `${this._label} stream error`,
        });

        return { message, raw };
    }

    /** 组装请求体；平台可以整体覆写 */
    protected buildPayload(
        messages: readonly Message[],
        options: SessionRuntimeOptions,
        turn?: ChatOptions,
    ): Record<string, unknown>{
        const payload: Record<string, unknown> = {
            model: options.model,
            messages: this._protocolAdapter.toPayloads([...messages], turn?.attachmentRefs),
            stream: true,
        };

        if (this._includeStreamUsage){
            payload.stream_options = { include_usage: true };
        }

        this.decoratePayload(payload, options, turn);
        return payload;
    }

    /** 在基础请求体上补充通用可选项；平台特有字段通过覆写追加 */
    protected decoratePayload(
        payload: Record<string, unknown>,
        options: SessionRuntimeOptions,
        turn?: ChatOptions,
    ): void{
        if (options.temperature !== undefined){
            payload.temperature = options.temperature;
        }
        if (turn?.tools !== undefined && turn.tools.length > 0){
            payload.tools = this._protocolAdapter.toolDefinitionsToPayload(turn.tools);
        }
    }

    /** 调用前的平台校验（例如模型是否支持图片输入） */
    protected checkChatOptions(
        _messages: readonly Message[],
        _options: SessionRuntimeOptions,
        _turn?: ChatOptions,
    ): void{
        // 默认没有额外校验
    }

    /** 发送请求并处理网络/HTTP 错误 */
    protected async postChat(
        payload: Record<string, unknown>,
        signal: AbortSignal | undefined,
    ): Promise<Response>{
        const requestSignal = createRequestSignal(signal, this._timeoutMs);

        try{
            let response: Response;
            try{
                response = await this._fetch(`${this._baseUrl}${this._chatPath}`, {
                    method: "POST",
                    headers: {
                        ...this._headers,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(payload),
                    signal: requestSignal.signal,
                });
            }catch(error){
                if (signal?.aborted === true) throw error;
                if (requestSignal.timedOut()){
                    throw new SessionError(
                        SessionErrorType.NetworkError,
                        `${this._label} chat request timed out after ${String(this._timeoutMs)}ms`,
                        error,
                    );
                }
                throw new SessionError(
                    SessionErrorType.NetworkError,
                    `${this._label} chat request failed`,
                    error,
                );
            }

            if (!response.ok){
                throw await httpError(`${this._label} chat`, response);
            }

            return response;
        }finally{
            requestSignal.cleanup();
        }
    }
}
