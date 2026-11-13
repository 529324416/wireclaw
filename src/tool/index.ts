/* 工具实现层入口
 * @note 协议契约（ToolDefinition / ToolProvider / ToolRegistry）由 session 模块定义，
 *       MCP 的协议与 HTTP 传输在这里；本地工具和 stdio 传输由宿主提供（见 /client）。
 */

export * from "./mcp";
