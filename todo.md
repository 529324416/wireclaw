# Rotom TODO

## 先回答：MCP 的能力边界

Rotom 目前实现的是 **MCP Client / Host**，不是 MCP Server；只覆盖 `tools` 子集。

MCP 并不只是「跨进程提供工具」：

- `tools`：模型可调用的函数（已实现）
- `resources`：服务端暴露的可读资源（文件、数据库记录、UI 资源等）
- `prompts`：服务端提供的提示模板，客户端可以选用
- `sampling` / `roots` / `elicitation`：服务端反向请求客户端能力（当前客户端未声明能力，统一拒绝）
- `tasks`（新协议修订）：长任务

当前 `examples/mcp_server.py` 只是验证用的最小 Server。

## 已完成

- [x] JSON-RPC 2.0 请求 / 响应 / 通知
- [x] `initialize` 握手、版本协商、`notifications/initialized`
- [x] `tools/list`（分页、去重）、`tools/call`、`ping`
- [x] stdio 传输（实现完成，待实机测试）
- [x] Streamable HTTP（JSON / SSE 响应、session id、协议版本头）
- [x] 工具名消毒 / 反向映射、注解与审批推导、结果与错误映射
- [x] Registry 缓存失效、`closeAll`、Provider 错误隔离
- [x] CLI 接入、`/tools`、Flask 示例、README

## 待办

### 稳定性

- [x] 传输关闭后的自动重连（Client `reconnect` + Provider 单次重试）
- [x] 工具列表缓存 TTL（HTTP 下及时感知工具变化）
- [x] HTTP 会话：`DELETE` 关闭
- [x] HTTP 断线恢复（后台 GET SSE + `Last-Event-ID` 续传）
- [x] stdio 实机测试（Python 子进程 + NDJSON）
- [x] 服务端心跳 / 健康检查（默认 30s `ping`，连续失败标记不健康）

### 契约与上下文

- [x] 工具结果体量上限（Registry 统一，默认 32k 字符，可配置）
- [x] `outputSchema` 校验（结构错误作为工具失败结果回传模型）
- [x] `adviceTimeout`（默认 30s，上限 3600s）
- [x] 进度探针 API（按 `callId` 查询 + 延迟 5s 的 `TOOL_PROGRESS` 事件）
- [x] `host__ask_user` 人工选择题（Session 自动注入，可用 `enableUserInput` 关闭）
- [ ] 工具结果信任标记（不可信外部内容的提示/隔离）

### 协议广度

- [ ] `resources`
- [ ] `prompts`
- [ ] `notifications/progress` 转发
- [ ] MCP `elicitation`（服务端发起的人工输入，复用 ask_user 表单机制）
- [ ] 更完整的 JSON Schema 校验（`pattern` / `oneOf` / `$ref` 等）
- [ ] 多模态内容（依赖附件系统）
- [ ] `tasks` / 长任务
- [ ] 协议版本更新（新修订发布后评估）

### 工程化

- [ ] 多 Server 配置加载
- [ ] 工具 allowlist / 按 Server 的审批、并发、超时覆盖
- [ ] 鉴权（OAuth / 动态注册）—— 暂缓
- [ ] 指标、审计、限流 —— 暂缓
- [ ] Rotom 作为 MCP Server 的多客户端并发支持（远期）

## 你的反馈记录

- 结果体量上限应放在工具契约层统一处理，而不是每个 MCP Server 单独配置。
- `outputSchema` 校验做起来简单，结构错误应作为工具失败结果正常回传模型。
- `adviceTimeout` 值得加入：默认 30s，允许工具自定义，最大 3600s。
- 进度反馈可以做成类似探针的 API（按 `callId` 查询），但不是重点。
- 鉴权、指标/审计暂时不加。
- 若 Rotom 未来作为 MCP Server，需要处理多客户端并发。
- 多模态内容等附件系统完成后再补。
