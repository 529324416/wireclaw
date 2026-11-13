/* 参考客户端（宿主）实现，对应包入口 wireclaw/client
 * @note 这些实现依赖 Node 的 fs / child_process，不属于 Wireclaw 核心；
 *       宿主程序可以替换为自己的工具、传输和存储实现。
 */

export * from "./config";
export * from "./local-tools";
export * from "./mcp";
export * from "./mcp-stdio";
