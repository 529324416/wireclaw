import { McpTransportError } from "./error";
import { isRecord } from "./type";
import type { JsonRpcMessage } from "./type";
import type { McpSendOptions, McpTransport } from "./transport";

export type McpHttpTransportOptions = {

    /** MCP HTTP 端点，例如 http://127.0.0.1:5000/mcp */
    url: string;

    /** 额外请求头（鉴权等） */
    headers?: Record<string, string>;

    /** 可注入的 fetch（测试用） */
    fetch?: typeof fetch;

    /** 通知流断线重试的初始间隔（毫秒），默认 500 */
    eventStreamRetryMs?: number;
};

type SseEvent = {
    id?: string;
    data: string;
};

/**
 * Streamable HTTP 传输：
 * - 每个 JSON-RPC 消息用一次 POST 发送；
 * - 响应支持 application/json 与 text/event-stream；
 * - 自动记录并在后续请求回传 Mcp-Session-Id / MCP-Protocol-Version；
 * - 后台 GET SSE 接收服务端通知，断线后用 Last-Event-ID 续传；
 * - 关闭时尽力发送 DELETE 终止会话。
 */
export class McpHttpTransport implements McpTransport {

    private readonly _options: McpHttpTransportOptions;
    private readonly _fetch: typeof fetch;
    private readonly _messageListeners = new Set<(message: JsonRpcMessage) => void>();
    private readonly _closeListeners = new Set<(error?: Error) => void>();

    private _sessionId: string | null = null;
    private _protocolVersion: string | null = null;
    private _started = false;
    private _closed = false;

    /** 通知流状态 */
    private _lastEventId: string | null = null;
    private _eventStreamAbort: AbortController | null = null;
    private _eventStreamSupported = true;
    private _eventStreamGeneration = 0;
    private _eventStreamRetryMs: number;
    private _eventStreamWake: (() => void) | null = null;

    constructor(options: McpHttpTransportOptions) {
        this._options = options;
        this._fetch = options.fetch ?? fetch;
        this._eventStreamRetryMs = options.eventStreamRetryMs ?? 500;
    }

    async start(): Promise<void> {
        if (this._started && !this._closed) return;

        let url: URL;
        try {
            url = new URL(this._options.url);
        } catch (error) {
            throw new McpTransportError(
                `Invalid MCP HTTP URL: ${this._options.url}`,
                { cause: error },
            );
        }

        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new McpTransportError(`Unsupported MCP HTTP protocol: ${url.protocol}`);
        }

        // 允许重连：清理旧会话状态
        this._sessionId = null;
        this._protocolVersion = null;
        this._lastEventId = null;
        this._eventStreamSupported = true;
        this._eventStreamRetryMs = this._options.eventStreamRetryMs ?? 500;
        this._closed = false;
        this._started = true;
    }

    async send(message: JsonRpcMessage, options?: McpSendOptions): Promise<void> {
        if (!this._started) {
            throw new McpTransportError("MCP HTTP transport is not started");
        }
        if (this._closed) {
            throw new McpTransportError("MCP HTTP transport is closed");
        }

        let response: Response;
        try {
            response = await this._fetch(this._options.url, {
                method: "POST",
                headers: this._buildHeaders("application/json, text/event-stream", true),
                body: JSON.stringify(message),
                signal: options?.signal,
            });
        } catch (error) {
            if (options?.signal?.aborted === true) throw error;
            throw new McpTransportError(
                `MCP HTTP request failed: ${errorMessage(error)}`,
                { cause: error },
            );
        }

        const sessionId = response.headers.get("mcp-session-id");
        if (sessionId !== null && sessionId.length > 0) {
            this._sessionId = sessionId;
        }

        // 通知类消息通常返回 202/204
        if (response.status === 202 || response.status === 204) return;

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new McpTransportError(
                `MCP HTTP server returned ${response.status}${body.length > 0 ? `: ${body.slice(0, 200)}` : ""}`,
            );
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("text/event-stream")) {
            await this._consumeResponseStream(response);
            return;
        }

        let payload: unknown;
        try {
            payload = await response.json();
        } catch (error) {
            throw new McpTransportError("MCP HTTP server returned invalid JSON", { cause: error });
        }
        this._dispatchPayload(payload);
    }

    onMessage(listener: (message: JsonRpcMessage) => void): () => void {
        this._messageListeners.add(listener);
        return () => {
            this._messageListeners.delete(listener);
        };
    }

    onClose(listener: (error?: Error) => void): () => void {
        this._closeListeners.add(listener);
        return () => {
            this._closeListeners.delete(listener);
        };
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;

        this._eventStreamGeneration += 1;
        this._eventStreamAbort?.abort();
        this._eventStreamAbort = null;
        this._eventStreamWake?.();

        // 有会话时尽力发送 DELETE 终止会话（服务端不支持也不会阻塞关闭）
        const sessionId = this._sessionId;
        if (sessionId !== null) {
            const headers: Record<string, string> = { ...(this._options.headers ?? {}) };
            headers["mcp-session-id"] = sessionId;
            if (this._protocolVersion !== null) {
                headers["mcp-protocol-version"] = this._protocolVersion;
            }

            try {
                await this._fetch(this._options.url, {
                    method: "DELETE",
                    headers,
                    signal: AbortSignal.timeout(2_000),
                });
            } catch {
                // 关闭是尽力而为
            }
        }

        for (const listener of [...this._closeListeners]) {
            listener();
        }
    }

    /** 握手后由 McpClient 调用，后续请求附加协议版本头 */
    setProtocolVersion(version: string): void {
        this._protocolVersion = version;
    }

    /** 当前会话 ID（调试用） */
    get sessionId(): string | null {
        return this._sessionId;
    }

    /** 启动服务端通知流（GET SSE） */
    startEventStream(): void {
        if (!this._started || this._closed || !this._eventStreamSupported) return;

        this._eventStreamGeneration += 1;
        void this._runEventStream(this._eventStreamGeneration);
    }

    private _buildHeaders(accept: string, includeContentType: boolean): Record<string, string> {
        const headers: Record<string, string> = {
            accept,
            ...(includeContentType ? { "content-type": "application/json" } : {}),
            ...(this._options.headers ?? {}),
        };

        if (this._sessionId !== null) {
            headers["mcp-session-id"] = this._sessionId;
        }
        if (this._protocolVersion !== null) {
            headers["mcp-protocol-version"] = this._protocolVersion;
        }

        return headers;
    }

    /** 通知流主循环：连接 -> 断线 -> 使用 Last-Event-ID 重连 */
    private async _runEventStream(generation: number): Promise<void> {
        try {
            while (generation === this._eventStreamGeneration
                && !this._closed
                && this._eventStreamSupported) {

                const controller = new AbortController();
                this._eventStreamAbort = controller;
                let failed = false;

                try {
                    const headers = this._buildHeaders("text/event-stream", false);
                    if (this._lastEventId !== null) {
                        headers["last-event-id"] = this._lastEventId;
                    }

                    const response = await this._fetch(this._options.url, {
                        method: "GET",
                        headers,
                        signal: controller.signal,
                    });

                    if (response.status === 404 || response.status === 405) {
                        this._eventStreamSupported = false;
                        return;
                    }
                    if (!response.ok) {
                        throw new McpTransportError(
                            `MCP HTTP event stream returned ${response.status}`,
                        );
                    }
                    if (response.body === null) return;

                    const reader = response.body.getReader();
                    try {
                        await this._consumeSse(reader, (event) => {
                            if (event.id !== undefined) this._lastEventId = event.id;
                            if (event.data === "[DONE]") return;
                            try {
                                this._dispatchPayload(JSON.parse(event.data) as unknown);
                            } catch {
                                // 忽略无法解析的事件
                            }
                        });
                    } finally {
                        reader.releaseLock();
                    }

                    this._eventStreamRetryMs = this._options.eventStreamRetryMs ?? 500;
                } catch {
                    if (this._closed || controller.signal.aborted) return;
                    failed = true;
                } finally {
                    if (generation === this._eventStreamGeneration) {
                        this._eventStreamAbort = null;
                    }
                }

                if (generation !== this._eventStreamGeneration
                    || this._closed
                    || !this._eventStreamSupported) {
                    return;
                }

                await this._sleep(failed ? this._eventStreamRetryMs : 100);
                this._eventStreamRetryMs = Math.min(30_000, this._eventStreamRetryMs * 2);
            }
        } finally {
            // 新代次的通知流会自行管理生命周期
        }
    }

    private async _consumeResponseStream(response: Response): Promise<void> {
        const body = response.body;
        if (body === null) return;

        const reader = body.getReader();
        try {
            await this._consumeSse(reader, (event) => {
                if (event.id !== undefined) this._lastEventId = event.id;
                if (event.data === "[DONE]") return;
                try {
                    this._dispatchPayload(JSON.parse(event.data) as unknown);
                } catch {
                    // 忽略无法解析的事件
                }
            });
        } finally {
            reader.releaseLock();
        }
    }

    /** 解析 SSE 字节流，按事件回调 */
    private async _consumeSse(
        reader: ReadableStreamDefaultReader<Uint8Array>,
        onEvent: (event: SseEvent) => void,
    ): Promise<void> {
        const decoder = new TextDecoder();
        let buffer = "";
        let dataLines: string[] = [];
        let eventId: string | undefined;

        const flush = (): void => {
            if (dataLines.length === 0) {
                eventId = undefined;
                return;
            }

            const data = dataLines.join("\n");
            dataLines = [];
            const id = eventId;
            eventId = undefined;
            onEvent({ id, data });
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            let index = buffer.indexOf("\n");
            while (index >= 0) {
                const line = buffer.slice(0, index).replace(/\r$/, "");
                buffer = buffer.slice(index + 1);

                if (line === "") {
                    flush();
                } else if (line.startsWith("id:")) {
                    eventId = line.slice(3).trim();
                } else if (line.startsWith("data:")) {
                    dataLines.push(line.slice(5).trimStart());
                }

                index = buffer.indexOf("\n");
            }
        }

        buffer += decoder.decode();
        if (buffer.startsWith("data:")) {
            dataLines.push(buffer.slice(5).trimStart());
        } else if (buffer.startsWith("id:")) {
            eventId = buffer.slice(3).trim();
        }
        flush();
    }

    private _sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this._eventStreamWake = null;
                resolve();
            }, ms);
            timer.unref?.();

            this._eventStreamWake = () => {
                clearTimeout(timer);
                this._eventStreamWake = null;
                resolve();
            };
        });
    }

    private _dispatchPayload(payload: unknown): void {
        if (Array.isArray(payload)) {
            for (const item of payload) this._dispatch(item);
            return;
        }
        this._dispatch(payload);
    }

    private _dispatch(value: unknown): void {
        if (!isRecord(value) || this._closed) return;

        for (const listener of [...this._messageListeners]) {
            listener(value as JsonRpcMessage);
        }
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
