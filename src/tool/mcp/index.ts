/**
 * MCP 工具实现层（占位）
 *
 * 职责边界：
 * - session 模块定义 ToolProvider / ToolRegistry / ToolDefinition 等协议契约
 * - 这里只放 MCP 的具体实现，后续不得反向依赖实现层之外的 session 内部细节
 *
 * 计划中的模块（尚未实现）：
 * - type.ts        JSON-RPC 2.0 / MCP 线上类型
 * - config.ts      McpServerConfig
 * - transport.ts   McpTransport 接口
 * - stdio.ts       stdio 传输
 * - http.ts        Streamable HTTP 传输
 * - client.ts      McpClient（握手 / 请求复用 / 通知 / 关闭）
 * - naming.ts      MCP 工具名 -> 模型安全 toolId
 * - provider.ts    McpToolProvider
 */
export {};
