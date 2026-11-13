/* Node 入口
 * @note 在浏览器安全核心之上，追加基于 node:fs 的附件宿主。
 *       需要本地工具或 MCP stdio 时，由宿主程序自行提供。
 */

export * from "./index";
export * from "./file/local";
