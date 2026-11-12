import { McpHttpTransport } from "./http";
import { McpStdioTransport } from "./stdio";
import type { McpTransport } from "./transport";

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

/** MCP 工具审批策略
 * - auto：只读工具自动放行，其余需要审批
 * - always：全部需要审批
 * - never：全部自动放行（谨慎使用）
 */
export type McpApprovalMode = "auto" | "always" | "never";

/** 单个 MCP 服务端配置 */
export type McpServerConfig = {

    /** Provider ID（模型侧工具名前缀） */
    id: string;

    /** 展示名称 */
    name?: string;

    /** 描述 */
    description?: string;

    /** 传输配置 */
    transport: McpTransportConfig;

    /** 审批策略，默认 auto */
    approval?: McpApprovalMode;

    /** 是否允许并发（默认 false，外部工具保守串行） */
    concurrencySafe?: boolean;

    /** 期望的协议版本 */
    protocolVersion?: string;

    /** 单次请求超时（毫秒） */
    requestTimeoutMs?: number;

    /** 心跳间隔（毫秒），默认 30s；0 关闭 */
    heartbeatIntervalMs?: number;
};

/** 根据配置创建传输层 */
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
