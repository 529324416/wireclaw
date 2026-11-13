/* 浏览器安全入口
 * @note 只聚合 base / session / file(浏览器宿主) / platform / tool(MCP 核心)，
 *       不包含 node:fs、node:child_process 等 Node-only 模块。
 */

export * from "./index";
