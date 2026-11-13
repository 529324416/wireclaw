import { McpHttpTransport } from "../tool/mcp/http";
import { McpToolProvider } from "../tool/mcp/provider";
import { McpStdioTransport } from "./mcp-stdio";
import type { ClientMcpServerConfig, McpTransportConfig } from "./config";
import type { McpTransport } from "../tool/mcp/transport";

/** 根据客户端配置创建 MCP 传输层
 * @note stdio 需要 node:child_process；HTTP 传输由核心提供
 */
export function createTransport(config: McpTransportConfig): McpTransport {
    switch (config.type) {
        case "stdio":
            return new McpStdioTransport({
                command: config.command,
                args: config.args,
                env: config.env,
                cwd: config.cwd,
                onStderr: config.onStderr,
            });

        case "http":
            return new McpHttpTransport({
                url: config.url,
                headers: config.headers,
            });

        default: {
            const exhaustive: never = config;
            throw new Error(`Unsupported MCP transport: ${String(exhaustive)}`);
        }
    }
}

/** 从客户端配置创建 MCP Provider */
export function createMcpProvider(config: ClientMcpServerConfig): McpToolProvider {
    return new McpToolProvider(config, createTransport(config.transport));
}
