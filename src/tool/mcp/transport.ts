import type { JsonRpcMessage } from "./type";

/** 发送选项 */
export type McpSendOptions = {

    /** 取消信号（HTTP 传输会传给 fetch） */
    signal?: AbortSignal;
};

/** MCP 传输层：只负责收发 JSON-RPC 消息，不关心协议语义 */
export interface McpTransport {

    /** 启动传输（stdio 会 spawn 子进程，HTTP 只校验 URL） */
    start(): Promise<void>;

    /** 发送一条 JSON-RPC 消息 */
    send(message: JsonRpcMessage, options?: McpSendOptions): Promise<void>;

    /** 订阅入站消息；返回取消订阅函数 */
    onMessage(listener: (message: JsonRpcMessage) => void): () => void;

    /** 订阅连接关闭；返回取消订阅函数 */
    onClose(listener: (error?: Error) => void): () => void;

    /** 关闭传输 */
    close(): Promise<void>;

    /** 握手成功后设置协议版本（HTTP 传输用来附加请求头） */
    setProtocolVersion?(version: string): void;

    /** 启动服务端通知流（HTTP 传输实现；stdio 不需要） */
    startEventStream?(): void;
}
