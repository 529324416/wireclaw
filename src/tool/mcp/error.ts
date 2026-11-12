import type { JsonRpcErrorObject } from "./type";

export type McpErrorOptions = {
    cause?: unknown;
    code?: number;
    data?: unknown;
};

/** MCP 错误基类 */
export class McpError extends Error {

    /** JSON-RPC 错误码（仅 response 错误有） */
    readonly code?: number;

    /** JSON-RPC 附加数据 */
    readonly data?: unknown;

    constructor(message: string, options: McpErrorOptions = {}) {
        super(message);
        this.name = "McpError";
        this.code = options.code;
        this.data = options.data;
        if (options.cause !== undefined) {
            this.cause = options.cause;
        }
    }
}

/** 传输层错误（进程退出、HTTP 失败、连接关闭等） */
export class McpTransportError extends McpError {
    constructor(message: string, options: McpErrorOptions = {}) {
        super(message, options);
        this.name = "McpTransportError";
    }
}

/** 协议层错误（握手失败、非法消息、版本不支持等） */
export class McpProtocolError extends McpError {
    constructor(message: string, options: McpErrorOptions = {}) {
        super(message, options);
        this.name = "McpProtocolError";
    }
}

/** 服务端返回的 JSON-RPC 错误 */
export class McpResponseError extends McpError {

    /** JSON-RPC 错误码 */
    readonly rpcCode: number;

    constructor(error: JsonRpcErrorObject) {
        super(error.message, { code: error.code, data: error.data });
        this.name = "McpResponseError";
        this.rpcCode = error.code;
    }
}

/** 请求超时 */
export class McpTimeoutError extends McpError {
    constructor(message: string, options: McpErrorOptions = {}) {
        super(message, options);
        this.name = "McpTimeoutError";
    }
}

/** 请求被取消 */
export class McpAbortError extends McpError {
    constructor(message: string, options: McpErrorOptions = {}) {
        super(message, options);
        this.name = "McpAbortError";
    }
}
