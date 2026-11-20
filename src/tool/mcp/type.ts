/* MCP 线上类型：JSON-RPC 2.0 + MCP 协议消息 */

/** JSON-RPC 请求 ID */
export type JsonRpcId = string | number;

export type JsonRpcRequest = {
    jsonrpc: "2.0";
    id: JsonRpcId;
    method: string;
    params?: unknown;
};

export type JsonRpcNotification = {
    jsonrpc: "2.0";
    method: string;
    params?: unknown;
};

export type JsonRpcErrorObject = {
    code: number;
    message: string;
    data?: unknown;
};

export type JsonRpcResponse = {
    jsonrpc: "2.0";
    id: JsonRpcId | null;
    result?: unknown;
    error?: JsonRpcErrorObject;
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** 默认协商的 MCP 协议版本
 * @note 只支持官方规范修订；不实现已废弃的旧传输（HTTP+SSE）
 */
export const MCP_PROTOCOL_VERSION = "2025-11-25";

/** 客户端支持的官方协议版本（按优先级）
 * @note 支持窗口为当前修订 + 上一修订。
 *       2025-11-25 是增量修订，保留 initialize 握手与 Streamable HTTP；
 *       2024-11-05 / 旧版 HTTP+SSE 已移除；
 *       2026-07-28 为无状态大版本（移除 initialize / session），需要独立客户端实现。
 */
export const MCP_SUPPORTED_VERSIONS: readonly string[] = [
    "2025-11-25",
    "2025-06-18",
];

/** 协议错误码 */
export const McpErrorCode = {
    ParseError: -32700,
    InvalidRequest: -32600,
    MethodNotFound: -32601,
    InvalidParams: -32602,
    InternalError: -32603,
    ResourceNotFound: -32002,
} as const;
export type McpErrorCode = (typeof McpErrorCode)[keyof typeof McpErrorCode];

/** 客户端/服务端实现信息 */
export type McpImplementation = {
    name: string;
    version: string;
};

/** 客户端能力（当前不声明 roots / sampling / elicitation） */
export type McpClientCapabilities = Record<string, unknown>;

/** 服务端能力 */
export type McpServerCapabilities = {
    tools?: {
        listChanged?: boolean;
    };
    [key: string]: unknown;
};

export type McpInitializeParams = {
    protocolVersion: string;
    capabilities: McpClientCapabilities;
    clientInfo: McpImplementation;
};

export type McpInitializeResult = {
    protocolVersion: string;
    capabilities: McpServerCapabilities;
    serverInfo: McpImplementation;
    instructions?: string;
};

/** MCP 工具注解（与我们的 annotations 基本一一对应） */
export type McpToolAnnotations = {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
};

/** MCP 工具定义 */
export type McpTool = {
    name: string;
    title?: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;

    /** Wireclaw 扩展：工具建议超时（毫秒）；服务端可返回，客户端会映射到 ToolDefinition */
    adviceTimeout?: number;

    annotations?: McpToolAnnotations;
};

export type McpListToolsResult = {
    tools: McpTool[];
    nextCursor?: string;
};

/* ---- tools/call 结果内容 ---- */

export type McpTextContent = {
    type: "text";
    text: string;
    annotations?: Record<string, unknown>;
};

export type McpImageContent = {
    type: "image";
    data: string;
    mimeType: string;
    annotations?: Record<string, unknown>;
};

export type McpAudioContent = {
    type: "audio";
    data: string;
    mimeType: string;
    annotations?: Record<string, unknown>;
};

export type McpResourceLinkContent = {
    type: "resource_link";
    uri: string;
    name?: string;
    mimeType?: string;
    annotations?: Record<string, unknown>;
};

export type McpEmbeddedResourceContent = {
    type: "resource";
    resource: {
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
    };
    annotations?: Record<string, unknown>;
};

export type McpContent =
    | McpTextContent
    | McpImageContent
    | McpAudioContent
    | McpResourceLinkContent
    | McpEmbeddedResourceContent;

export type McpCallToolResult = {
    content: McpContent[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
};

/** MCP 进度通知（notifications/progress） */
export type McpProgressNotification = {
    progressToken: string | number;
    progress: number;
    total?: number;
    message?: string;
};

/** 判断是否为 JSON-RPC 响应（没有 method 字段） */
export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
    return !("method" in message);
}

/** 判断是否为普通对象 */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
