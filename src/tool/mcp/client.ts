import {
    McpAbortError,
    McpProtocolError,
    McpResponseError,
    McpTimeoutError,
    McpTransportError,
} from "./error";
import { MCP_PROTOCOL_VERSION, MCP_SUPPORTED_VERSIONS, McpErrorCode, isRecord } from "./type";
import type {
    JsonRpcErrorObject,
    JsonRpcId,
    JsonRpcMessage,
    JsonRpcNotification,
    JsonRpcRequest,
    McpCallToolResult,
    McpContent,
    McpImplementation,
    McpInitializeResult,
    McpListToolsResult,
    McpProgressNotification,
    McpServerCapabilities,
    McpTool,
    McpToolAnnotations,
} from "./type";
import type { McpTransport } from "./transport";

/** 单次请求默认超时 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** tools/list 最大分页数，防止服务端死循环 */
const MAX_TOOL_PAGES = 100;

export type McpClientOptions = {

    /** 客户端实现信息 */
    clientInfo?: McpImplementation;

    /** 期望的协议版本（默认 2025-06-18） */
    protocolVersion?: string;

    /** 单次请求默认超时（毫秒） */
    timeoutMs?: number;

    /** 收到服务端通知时的回调（日志/进度等） */
    onNotification?: (method: string, params: unknown) => void;

    /** 心跳间隔（毫秒），默认 0 = 关闭；建议 30s */
    heartbeatIntervalMs?: number;
};

/** 单次请求选项 */
export type McpRequestOptions = {
    signal?: AbortSignal;
    timeoutMs?: number;

    /** 进度令牌；会写入 tools/call 的 _meta.progressToken */
    progressToken?: string | number;

    /** 进度回调 */
    onProgress?: (progress: McpProgressNotification) => void;
};

type PendingRequest = {
    method: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    finish: () => void;
};

/**
 * MCP 客户端：负责握手、请求复用、通知、取消与关闭。
 * @note 传输层只负责收发消息；协议语义全部在这里。
 */
export class McpClient {

    private readonly _transport: McpTransport;
    private readonly _clientInfo: McpImplementation;
    private readonly _preferredVersion: string;
    private readonly _timeoutMs: number;
    private readonly _onNotification?: (method: string, params: unknown) => void;

    private readonly _pending = new Map<JsonRpcId, PendingRequest>();
    private readonly _toolsChanged = new Set<() => void>();
    private readonly _progressListeners = new Map<string | number, (progress: McpProgressNotification) => void>();
    private readonly _unsubscribers: Array<() => void> = [];

    private readonly _heartbeatIntervalMs: number;
    private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private _heartbeatBusy = false;
    private _healthFailures = 0;
    private _lastPongAt: number | null = null;

    private _nextId = 1;
    private _connectPromise: Promise<McpInitializeResult> | null = null;
    private _init: McpInitializeResult | null = null;
    private _closed = false;

    constructor(transport: McpTransport, options: McpClientOptions = {}) {
        this._transport = transport;
        this._clientInfo = options.clientInfo ?? { name: "wireclaw", version: "1.0.0" };
        this._preferredVersion = options.protocolVersion ?? MCP_PROTOCOL_VERSION;
        this._timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this._onNotification = options.onNotification;
        this._heartbeatIntervalMs = options.heartbeatIntervalMs ?? 0;
    }

    /** 服务端信息；未握手时为 null */
    get serverInfo(): McpImplementation | null {
        return this._init?.serverInfo ?? null;
    }

    /** 服务端能力；未握手时为 null */
    get capabilities(): McpServerCapabilities | null {
        return this._init?.capabilities ?? null;
    }

    /** 协商后的协议版本 */
    get protocolVersion(): string | null {
        return this._init?.protocolVersion ?? null;
    }

    /** 是否已握手且未关闭 */
    get isConnected(): boolean {
        return this._init !== null && !this._closed;
    }

    /** 心跳是否健康（连续失败 2 次视为不健康） */
    get isHealthy(): boolean {
        return this._init !== null && !this._closed && this._healthFailures < 2;
    }

    /** 最近一次心跳成功时间 */
    get lastPongAt(): number | null {
        return this._lastPongAt;
    }

    /** 建立连接（幂等；并发调用共享同一个 Promise） */
    async connect(): Promise<McpInitializeResult> {
        if (this._init !== null) return this._init;
        if (this._connectPromise !== null) return this._connectPromise;

        this._connectPromise = this._connect();
        try {
            return await this._connectPromise;
        } finally {
            this._connectPromise = null;
        }
    }

    /** 重新连接：清理旧状态后重新握手
     * @note 传输失败后调用；成功后可以继续使用同一个 client
     */
    async reconnect(): Promise<McpInitializeResult> {
        if (!this._closed) {
            await this.close();
        }

        // close() 在 _closed 为 true 时会提前返回，这里兜底清理残留订阅
        for (const unsubscribe of this._unsubscribers.splice(0)) {
            try {
                unsubscribe();
            } catch {
                // 忽略取消订阅异常
            }
        }

        this._closed = false;
        this._init = null;
        this._connectPromise = null;
        this._healthFailures = 0;
        this._lastPongAt = null;
        return this.connect();
    }

    /** 列出全部工具（自动翻页、去重） */
    async listTools(options: McpRequestOptions = {}): Promise<McpTool[]> {
        await this.connect();

        const tools: McpTool[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;

        for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
            const result = await this._request<McpListToolsResult>(
                "tools/list",
                cursor === undefined ? undefined : { cursor },
                options,
            );

            if (!isRecord(result) || !Array.isArray(result.tools)) {
                throw new McpProtocolError("Invalid tools/list result");
            }

            for (const item of result.tools) {
                const tool = asMcpTool(item);
                if (tool === null || seen.has(tool.name)) continue;
                seen.add(tool.name);
                tools.push(tool);
            }

            const nextCursor = typeof result.nextCursor === "string" && result.nextCursor.length > 0
                ? result.nextCursor
                : undefined;
            if (nextCursor === undefined) return tools;

            cursor = nextCursor;
        }

        throw new McpProtocolError(`tools/list pagination exceeded ${MAX_TOOL_PAGES} pages`);
    }

    /** 调用工具 */
    async callTool(
        name: string,
        args: Record<string, unknown>,
        options: McpRequestOptions = {},
    ): Promise<McpCallToolResult> {
        await this.connect();

        const params: Record<string, unknown> = { name, arguments: args };
        if (options.progressToken !== undefined) {
            params._meta = { progressToken: options.progressToken };
        }

        const token = options.progressToken;
        if (token !== undefined && options.onProgress !== undefined) {
            this._progressListeners.set(token, options.onProgress);
        }

        try {
            const result = await this._request<unknown>("tools/call", params, options);

            if (!isRecord(result)) {
                throw new McpProtocolError("Invalid tools/call result");
            }

            const content = Array.isArray(result.content)
                ? result.content as McpContent[]
                : [];

            return {
                content,
                structuredContent: isRecord(result.structuredContent) ? result.structuredContent : undefined,
                isError: result.isError === true ? true : undefined,
            };
        } finally {
            if (token !== undefined) {
                this._progressListeners.delete(token);
            }
        }
    }

    /** 健康检查 */
    async ping(): Promise<void> {
        await this.connect();
        await this._request("ping", undefined, { timeoutMs: 5_000 });
    }

    /** 订阅 tools/list_changed 通知 */
    onToolsChanged(listener: () => void): () => void {
        this._toolsChanged.add(listener);
        return () => {
            this._toolsChanged.delete(listener);
        };
    }

    /** 关闭客户端：拒绝所有等待中的请求并关闭传输 */
    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;

        this._stopHeartbeat();
        this._progressListeners.clear();

        const failure = new McpTransportError("MCP client closed");
        for (const id of [...this._pending.keys()]) {
            this._settle(id, failure);
        }

        for (const unsubscribe of this._unsubscribers.splice(0)) {
            try {
                unsubscribe();
            } catch {
                // 忽略取消订阅异常
            }
        }

        await this._transport.close();
        this._init = null;
    }

    private async _connect(): Promise<McpInitializeResult> {
        if (this._closed) throw new McpTransportError("MCP client is closed");

        await this._transport.start();

        const unsubscribeMessage = this._transport.onMessage((message) => {
            this._handleMessage(message);
        });
        const unsubscribeClose = this._transport.onClose((error) => {
            this._handleClose(error);
        });

        try {
            const result = await this._request<McpInitializeResult>("initialize", {
                protocolVersion: this._preferredVersion,
                capabilities: {},
                clientInfo: this._clientInfo,
            });

            if (!isRecord(result) || typeof result.protocolVersion !== "string") {
                throw new McpProtocolError("Invalid initialize result");
            }
            if (!MCP_SUPPORTED_VERSIONS.includes(result.protocolVersion)) {
                throw new McpProtocolError(
                    `Unsupported MCP protocol version "${result.protocolVersion}"`,
                );
            }

            this._init = {
                protocolVersion: result.protocolVersion,
                capabilities: isRecord(result.capabilities) ? result.capabilities : {},
                serverInfo: asImplementation(result.serverInfo),
                instructions: typeof result.instructions === "string" ? result.instructions : undefined,
            };

            this._transport.setProtocolVersion?.(result.protocolVersion);
            await this._notify("notifications/initialized", undefined);

            this._unsubscribers.push(unsubscribeMessage, unsubscribeClose);
            this._transport.startEventStream?.();
            this._startHeartbeat();
            return this._init;
        } catch (error) {
            unsubscribeMessage();
            unsubscribeClose();
            this._init = null;
            throw error;
        }
    }

    private _handleMessage(message: JsonRpcMessage): void {
        if ("method" in message) {
            if ("id" in message) {
                // 服务端发来的请求：当前客户端未声明任何能力，统一回复 MethodNotFound
                void this._sendRaw({
                    jsonrpc: "2.0",
                    id: message.id,
                    error: {
                        code: McpErrorCode.MethodNotFound,
                        message: `Client does not support "${message.method}"`,
                    },
                }).catch(() => {
                    // 忽略回复失败
                });
                return;
            }

            if (message.method === "notifications/tools/list_changed") {
                for (const listener of [...this._toolsChanged]) {
                    try {
                        listener();
                    } catch {
                        // 忽略订阅者异常
                    }
                }
            }

            if (message.method === "notifications/progress") {
                this._handleProgressNotification(message.params);
            }

            this._onNotification?.(message.method, message.params);
            return;
        }

        // JSON-RPC 响应
        if (message.id === null) return;

        if (message.error !== undefined) {
            this._settle(message.id, undefined, undefined, message.error);
            return;
        }
        if ("result" in message) {
            this._settle(message.id, undefined, message.result);
            return;
        }

        this._settle(message.id, new McpProtocolError("JSON-RPC response without result or error"));
    }

    private _request<T>(
        method: string,
        params: unknown,
        options: McpRequestOptions = {},
    ): Promise<T> {
        if (this._closed) {
            return Promise.reject(new McpTransportError("MCP client is closed"));
        }

        const id = `mcp-${this._nextId}`;
        this._nextId += 1;

        const timeoutMs = options.timeoutMs ?? this._timeoutMs;
        const signal = options.signal;

        return new Promise<T>((resolve, reject) => {
            if (signal?.aborted === true) {
                reject(new McpAbortError(`MCP request "${method}" was aborted`));
                return;
            }

            let timer: ReturnType<typeof setTimeout> | undefined;

            const finish = (): void => {
                if (timer !== undefined) clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
            };

            const onAbort = (): void => {
                void this._notify("notifications/cancelled", {
                    requestId: id,
                    reason: "aborted",
                }).catch(() => {
                    // 取消失败不影响本地拒绝
                });
                this._settle(id, new McpAbortError(`MCP request "${method}" was aborted`));
            };

            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    void this._notify("notifications/cancelled", {
                        requestId: id,
                        reason: "timeout",
                    }).catch(() => {
                        // 取消失败不影响本地拒绝
                    });
                    this._settle(id, new McpTimeoutError(
                        `MCP request "${method}" timed out after ${timeoutMs} ms`,
                    ));
                }, timeoutMs);
            }

            signal?.addEventListener("abort", onAbort, { once: true });

            this._pending.set(id, {
                method,
                resolve: (value) => resolve(value as T),
                reject,
                finish,
            });

            const request: JsonRpcRequest = params === undefined
                ? { jsonrpc: "2.0", id, method }
                : { jsonrpc: "2.0", id, method, params };

            this._transport.send(request, { signal }).catch((error: unknown) => {
                this._settle(id, normalizeError(error));
            });
        });
    }

    private _settle(
        id: JsonRpcId,
        error?: Error,
        value?: unknown,
        responseError?: JsonRpcErrorObject,
    ): void {
        const pending = this._pending.get(id);
        if (pending === undefined) return;

        this._pending.delete(id);
        pending.finish();

        if (responseError !== undefined) {
            pending.reject(new McpResponseError(responseError));
        } else if (error !== undefined) {
            pending.reject(error);
        } else {
            pending.resolve(value);
        }
    }

    private _notify(method: string, params: unknown): Promise<void> {
        const notification: JsonRpcNotification = params === undefined
            ? { jsonrpc: "2.0", method }
            : { jsonrpc: "2.0", method, params };

        return this._transport.send(notification);
    }

    private _sendRaw(message: JsonRpcMessage): Promise<void> {
        return this._transport.send(message);
    }

    private _handleProgressNotification(params: unknown): void {
        if (!isRecord(params)) return;

        const token = params.progressToken;
        if (typeof token !== "string" && typeof token !== "number") return;

        const listener = this._progressListeners.get(token);
        if (listener === undefined || typeof params.progress !== "number") return;

        listener({
            progressToken: token,
            progress: params.progress,
            total: typeof params.total === "number" ? params.total : undefined,
            message: typeof params.message === "string" ? params.message : undefined,
        });
    }

    private _startHeartbeat(): void {
        this._stopHeartbeat();
        if (this._heartbeatIntervalMs <= 0) return;

        this._heartbeatTimer = setInterval(() => {
            void this._heartbeatTick();
        }, this._heartbeatIntervalMs);
        // Node 的定时器支持 unref；浏览器没有该能力
        (this._heartbeatTimer as unknown as { unref?: () => void }).unref?.();
    }

    private _stopHeartbeat(): void {
        if (this._heartbeatTimer === null) return;
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
    }

    private async _heartbeatTick(): Promise<void> {
        if (this._closed || this._init === null || this._heartbeatBusy) return;

        this._heartbeatBusy = true;
        try {
            await this._request("ping", undefined, {
                timeoutMs: Math.min(10_000, this._heartbeatIntervalMs),
            });
            this._lastPongAt = Date.now();
            this._healthFailures = 0;
        } catch (error) {
            if (error instanceof McpResponseError && error.rpcCode === McpErrorCode.MethodNotFound) {
                // 服务端不支持 ping，停止心跳而不是误判为不健康
                this._stopHeartbeat();
                return;
            }
            this._healthFailures += 1;
        } finally {
            this._heartbeatBusy = false;
        }
    }

    private _handleClose(error?: Error): void {
        if (this._closed) return;
        this._closed = true;
        this._stopHeartbeat();

        const failure = new McpTransportError(
            error?.message ?? "MCP transport closed",
            { cause: error },
        );
        for (const id of [...this._pending.keys()]) {
            this._settle(id, failure);
        }

        this._init = null;
    }
}

/** 把任意异常归一化为 Error */
function normalizeError(error: unknown): Error {
    if (error instanceof Error) return error;
    return new McpTransportError(String(error));
}

function asImplementation(value: unknown): McpImplementation {
    if (!isRecord(value)) return { name: "unknown", version: "" };

    return {
        name: typeof value.name === "string" ? value.name : "unknown",
        version: typeof value.version === "string" ? value.version : "",
    };
}

function asMcpTool(value: unknown): McpTool | null {
    if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) {
        return null;
    }

    return {
        name: value.name,
        title: typeof value.title === "string" ? value.title : undefined,
        description: typeof value.description === "string" ? value.description : undefined,
        inputSchema: isRecord(value.inputSchema)
            ? value.inputSchema
            : { type: "object", properties: {} },
        outputSchema: isRecord(value.outputSchema) ? value.outputSchema : undefined,
        adviceTimeout: typeof value.adviceTimeout === "number" && Number.isFinite(value.adviceTimeout)
            ? value.adviceTimeout
            : undefined,
        annotations: asAnnotations(value.annotations),
    };
}

function asAnnotations(value: unknown): McpToolAnnotations | undefined {
    if (!isRecord(value)) return undefined;

    return {
        title: typeof value.title === "string" ? value.title : undefined,
        readOnlyHint: typeof value.readOnlyHint === "boolean" ? value.readOnlyHint : undefined,
        destructiveHint: typeof value.destructiveHint === "boolean" ? value.destructiveHint : undefined,
        idempotentHint: typeof value.idempotentHint === "boolean" ? value.idempotentHint : undefined,
        openWorldHint: typeof value.openWorldHint === "boolean" ? value.openWorldHint : undefined,
    };
}
