import type {
    JsonRpcErrorObject,
    JsonRpcId,
    JsonRpcMessage,
    JsonRpcRequest,
} from "../src/tool/mcp/type";
import type { McpSendOptions, McpTransport } from "../src/tool/mcp/transport";

/** 内存传输：测试里手工收发 JSON-RPC 消息 */
export class FakeTransport implements McpTransport {

    readonly sent: JsonRpcMessage[] = [];
    handler: ((message: JsonRpcMessage) => void) | undefined;
    started = false;
    closed = false;

    private readonly _messageListeners = new Set<(message: JsonRpcMessage) => void>();
    private readonly _closeListeners = new Set<(error?: Error) => void>();

    async start(): Promise<void> {
        this.started = true;
    }

    async send(message: JsonRpcMessage, _options?: McpSendOptions): Promise<void> {
        this.sent.push(message);
        this.handler?.(message);
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
        if (this.closed) return;
        this.closed = true;
        for (const listener of [...this._closeListeners]) listener();
    }

    receive(message: JsonRpcMessage): void {
        for (const listener of [...this._messageListeners]) listener(message);
    }

    fail(error: Error): void {
        for (const listener of [...this._closeListeners]) listener(error);
    }
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
    return "method" in message && "id" in message;
}

export function respond(transport: FakeTransport, id: JsonRpcId, result: unknown): void {
    transport.receive({ jsonrpc: "2.0", id, result });
}

export function respondError(
    transport: FakeTransport,
    id: JsonRpcId,
    error: JsonRpcErrorObject,
): void {
    transport.receive({ jsonrpc: "2.0", id, error });
}

export function requestMethods(transport: FakeTransport): string[] {
    return transport.sent.filter(isRequest).map((message) => message.method);
}

/** 安装握手响应，返回安装好的 client 需要的东西 */
export function setupHandshake(transport: FakeTransport, version = "2025-06-18"): void {
    const baseHandler = transport.handler;
    transport.handler = (message) => {
        if (!isRequest(message)) return;

        if (message.method === "initialize") {
            respond(transport, message.id, {
                protocolVersion: version,
                capabilities: { tools: { listChanged: true } },
                serverInfo: { name: "fake-mcp", version: "1.2.3" },
            });
            return;
        }

        baseHandler?.(message);
    };
}
