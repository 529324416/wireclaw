import type { McpServerConfig } from "../tool/mcp/config";

/** stdio 传输配置 */
export type McpStdioTransportConfig = {
    type: "stdio";
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    onStderr?: (chunk: string) => void;
};

/** Streamable HTTP 传输配置 */
export type McpHttpTransportConfig = {
    type: "http";
    url: string;
    headers?: Record<string, string>;
};

export type McpTransportConfig = McpStdioTransportConfig | McpHttpTransportConfig;

/** 客户端侧 MCP Server 配置：核心配置 + 传输配置 */
export type ClientMcpServerConfig = McpServerConfig & {
    transport: McpTransportConfig;
};
