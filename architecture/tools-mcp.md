# Tools and MCP

## 工具系统（session 契约）

- 工具名格式：`<provider_id>__<tool_id>`，例如 `local__readFile`、`mcp__echo`。
- `ToolDefinition` 包含 `name`、`description`、`inputSchema`、`annotations`、`source`。
- `annotations` 里与本项目相关的字段：
  - `readOnlyHint`：只读工具
  - `destructiveHint`：破坏性操作
  - `requiresApproval`：是否需要在 approval 模式下审批
  - `concurrencySafe`：是否允许同批并发
- 工具契约层的三个统一策略：
  - `adviceTimeout`：工具建议的单次调用超时（默认 30s，上限 1h，超过会被截断）
  - 结果体量：`ToolRegistry` 默认把单次结果截断到 32 KiB 字符，可用 `maxResultChars` 调整
  - `outputSchema`：如果工具声明了输出 schema，Registry 会校验 `structuredContent`，不匹配时作为工具失败结果回传给模型
- 进度探针：
  - 工具通过 `onProgress` 主动上报进度；
  - Session 只有在调用超过 `toolProgressDelayMs`（默认 5s）后才发出 `TOOL_PROGRESS` 事件；
  - 前端可以监听事件决定是否展示，也可以随时通过 `session.getToolProgress(callId)` / `run.getToolProgress(callId)` 查询最新值。
- host 内置工具 `host__ask_user`（人工选择题）：
  - **不需要注册到 ToolRegistry**，Session 会自动注入定义；
  - 模型调用后 run 进入暂停，发出 `TOOL_INPUT_REQUIRED` 事件；
  - 前端通过 `session.respondUserInput(...)` 提交答案，答案以 ToolMessage 返回模型；
  - 默认开启，可用 `run(..., { enableUserInput: false })` 关闭；不支持工具调用的 Provider 不会被注入。
  - `allowOther: true` 时，`UserInputAnswer.other` 是唯一的自由输入出口；`other` 必须是非空字符串（`validateUserInputResult` 会拒绝空字符串、纯空白和非字符串）。
  - 参考 CLI 在 `allowOther: true` 时追加“其他（自由输入）”槽位，支持 `4, 内容`（中英文逗号均可）与直接输入文字；选项标签含“其他/备注/说明”或选中该槽位时，会强制要求补充非空文字，避免把空备注提交给模型。
- host 内置工具 `host__view_media`（assistant 历史媒体回看）：
  - 只在“模型可接收媒体 + 可产出同一媒体模态 + 支持工具调用”时注入，覆盖 image / audio / video；
  - 参数 `contentHash` 来自 assistant 消息中的 `[media:<contentHash>]` 标记；
  - 工具结果携带 attachment，由 Session 重新 `ensureFile` 后发送给模型；
  - 只允许当前会话 assistant 消息中出现过的媒体，不读取任意附件。
- host 内置工具注册可在 Session 构造时配置：
  - 第 5 个参数 `hostOptions.hostTools` 支持 `false` 整体关闭，或 `{ askUser?, viewMedia? }` 单独关闭；
  - 省略时保持旧行为；`enableUserInput` 仍是 run 级开关，与会话级配置取交集；
  - `createNewSession` 的第 4 个参数 `hostOptions` 行为一致。
- host 工具按完整工具名去重：Provider 已经提供同名工具时不会重复广告。
- 三档权限：
  - `readonly`：只允许 `readOnlyHint === true` 的工具，其余直接拒绝
  - `approval`：`requiresApproval` 的工具暂停等待人工审批
  - `full`：全部放行，破坏性工具会发出 `TOOL_PERMISSION_WARNING`

### 工具结果信任标记

- **两个维度正交**：`permission` 决定“是否允许执行 / 是否需要审批”；`trust` 决定“内容如何提示、展示与审计”。`trust` 不改变 `permission` 的语义。
- **信任来源只有两个**：
  1. Tool 自身的默认声明（例如 `searchWeb` 默认 `untrusted`）；
  2. 宿主程序的判定（按路径、域名、MCP Server、文件来源、是否由当前会话创建等覆盖）。
  模型只接收最终结果，不参与、也不能提升自己的信任级别。
- **信任级别**：`trusted` / `unknown` / `untrusted`。`unknown` 在提示与审计上按不可信处理（fail-closed），但它同样不触发审批。
- **`full` 不降级**：`full` 下即使结果是 `unknown` / `untrusted`，也不得追加审批、不得自动降为 `readonly`；仍按 `full` 执行，只允许：
  - 在模型上下文中加不可信边界/提示；
  - 在 UI/事件中标记 `[untrusted]`；
  - 发出警告或审计事件。
- **第三方声明不是授权**：MCP Server 或远端工具自称 `trusted` 只能作为线索；最终信任级别由宿主按 Server 身份与策略决定。
- **隔离与审批分开**：提示边界、上下文摘要、路径/域名白名单、沙箱属于隔离或能力边界；其中只有显式配置的审批才属于 `permission`，不能由 `trust` 隐式触发。
- **可配置的严格模式**：如果宿主需要额外防护，必须显式配置（例如 `trustEnforcement: "strict"`）；默认行为仍是“标记 + 提示 + 审计，不改变 full”。

实现结构：

- `ToolDefinition.defaultTrust?: ToolTrust`：Tool 作者默认值；
- `ToolProvider.defaultTrust?: ToolTrust`：Provider 级默认值，Tool 级优先；
- `ToolRegistryOptions.trustHandle?: ToolTrustHandle`：宿主判定钩子，在工具结果 finalize 后调用；
- `ToolTrustHandle(call, result, definition)`：只接收 Wireclaw 已持有的三个参数，不定义 `TrustContext`；外部程序用闭包携带 workspace / 白名单 / 文档库等状态；
- `ToolCallResult.trust` / `trustReason`：Registry 写入的最终判定；
- `ToolMessage.trust` / `trustReason`：随会话历史持久化，UI / 回放 / 审计可读；
- `TOOL_CALL_END` 事件携带的 `result` 直接包含 trust。

默认值与策略：

- MCP 外部 Provider 默认 `untrusted`；host 可通过 `trustHandle` 对特定 Server/工具提升；
- host 内置工具默认 `trusted`；
- 参考本地工具：`readFile` 默认 `unknown`（宿主可按工作区/文档库白名单提升），`writeFile` 默认 `trusted`（结果是 host 生成的写入状态）；
- `trustHandle` 返回 `undefined` 时保留 Tool/Provider 默认值；抛异常或返回非法值时按 `untrusted` fail-closed，并记录 `trustReason`；
- trust 标记本身不自动改写模型上下文、不触发审批；宿主可读取 `ToolMessage.trust` 后自行把不可信内容包装成提示边界或隔离区；
- 参考 CLI 在 `[tool] ... -> ok` 后显示 `[trusted]` / `[unknown]` / `[untrusted]` 徽章。

## MCP 实现（tool/mcp 核心 + src/client 传输）

### 一句话理解

Wireclaw 是 MCP **Host / Client**；Python/C#/Node 程序是 MCP **Server**。`McpToolProvider` 把远端 MCP 工具翻译成 Wireclaw 的 `ToolDefinition`，把模型发起的调用翻译回 `tools/call`。

### 协议版本策略

- 支持窗口：当前修订 + 上一修订，即 `2025-11-25` / `2025-06-18`；
- 已移除 `2024-11-05`，不实现旧版 HTTP+SSE 传输；
- `2026-07-28` 是无状态大版本（移除 initialize / session），需要独立的客户端实现，暂不支持；
- 版本号代表官方公共规范修订，新增版本前先评估握手、`tools/list`、`tools/call` 的兼容性。

官方发布信息：

- 规范总览与版本导航：<https://modelcontextprotocol.io/specification/>
- 版本变更记录：<https://modelcontextprotocol.io/specification/2025-11-25/changelog>
- 规范仓库 Releases：<https://github.com/modelcontextprotocol/modelcontextprotocol/releases>
- 官方博客：<https://blog.modelcontextprotocol.io/>

### 文件职责

| 文件 | 职责 |
|---|---|
| `src/tool/mcp/type.ts` | JSON-RPC 2.0 与 MCP 线上类型、协议版本、错误码 |
| `src/tool/mcp/error.ts` | transport / protocol / response / timeout / abort 错误分类 |
| `src/tool/mcp/transport.ts` | 传输层接口（只收发消息） |
| `src/tool/mcp/http.ts` | Streamable HTTP：POST JSON-RPC，兼容 JSON / SSE 响应 |
| `src/tool/mcp/client.ts` | 握手、请求复用、分页、超时、取消、通知、关闭 |
| `src/tool/mcp/naming.ts` | MCP 原始工具名 → 模型安全 toolId |
| `src/tool/mcp/config.ts` | 核心配置类型：`McpServerConfig` / `McpApprovalMode` |
| `src/tool/mcp/provider.ts` | `McpToolProvider`：工具映射、审批推导、结果转换 |
| `src/client/config.ts` | 客户端传输配置：stdio / HTTP / `ClientMcpServerConfig` |
| `src/client/local-tools.ts` | `LocalToolProvider`（Node 文件工具） |
| `src/client/mcp-stdio.ts` | stdio 传输：spawn 子进程，逐行 NDJSON（宿主提供） |
| `src/client/mcp.ts` | `createTransport` / `createMcpProvider` 工厂（宿主提供） |

### 连接与调用流程

```
McpToolProvider.fetchTools()
  └─ McpClient.connect()
       ├─ transport.start()
       ├─ initialize  ── 版本/能力协商
       └─ notifications/initialized
  └─ tools/list（自动翻页、去重）
  └─ 生成 ToolDefinition[] + safeName 映射

Session 发起 invoke
  └─ McpToolProvider.call()
       ├─ safeId -> MCP 原始工具名
       ├─ tools/call { name, arguments }
       └─ content -> 文本 / structuredContent / raw
```

### 传输层

- **Streamable HTTP**（核心）：每个消息 POST 到同一个端点；响应可以是 `application/json`，也可以是 `text/event-stream`；自动记录并回传 `Mcp-Session-Id`，握手后附加 `MCP-Protocol-Version`。
- **stdio**（`src/client`）：Node 启动子进程，stdin/stdout 每行一个 JSON-RPC 消息；stderr 作为日志。宿主也可以替换为自己的 `McpTransport`。

### 工具名映射

MCP 工具名没有字符集限制，而模型侧只接受 `[A-Za-z0-9_-]`，且不允许 `__`：

- `fs.read` → `fs_read`
- `fs__write` → `fs_write`（连续下划线折叠）
- 冲突：`dup_a`、`dup_a_2`
- 超长：截断 + 8 位哈希
- `title` 保留 MCP 原始名，便于 UI 展示

### 工具超时

- Wireclaw 扩展 MCP 工具定义字段 `adviceTimeout`（毫秒），映射到 `ToolDefinition.adviceTimeout`；
- `McpServerConfig.adviceTimeoutMs` 可为所有工具提供默认建议超时，单个工具的 `adviceTimeout` 优先；
- 解析后会限制在 1h 以内；生成类工具（如 MiniMax H3-Image）应显式设置 600s 级超时，避免 Session 默认 30s 截断。

### 审批策略

默认 `approval: "auto"`：

- `readOnlyHint === true` → 自动放行
- 其余外部工具 → 需要审批（`requiresApproval = true`）

可配置：

```ts
{ approval: "always" } // 全部审批
{ approval: "never" }  // 全部放行
```

并发默认 `concurrencySafe: false`（外部进程工具保守串行）。

### 结果与错误映射

| MCP | Wireclaw |
|---|---|
| `content[].type === "text"` | 拼接为文本 |
| `image` / `audio` | base64 → `PendingAttachment(bytes)`，由 Session 落盘 |
| `resource.blob` | base64 → `PendingAttachment(bytes)`（所有资源都落盘，模型按媒体输入过滤） |
| `resource.text` | 文本 |
| `resource_link`（http/https） | URL 附件，由 `AttachmentIngestor` 下载/校验/落盘 |
| `resource_link`（其他协议） | 文本占位 |
| `isError: true` 的媒体内容 | 不落盘，只保留错误文本 |
| `structuredContent` | `ToolCallResult.structuredContent` |
| `isError: true` | `isSuccess = false` + `ToolError(ProviderError)` |
| JSON-RPC error | `ToolError(ProviderError)` |
| 超时 | `ToolError(Timeout)`（可重试） |
| 连接失败 | `ToolError(NetworkError)`（可重试） |

### 生命周期与缓存

- Provider 惰性连接：第一次 `fetchTools` / `call` 才握手。
- 传输错误时自动重连；工具列表拉取会重试一次，工具调用不自动重试（避免重复副作用）。
- HTTP 传输会建立后台 GET SSE 通知流；断线后用 `Last-Event-ID` 续传。
- HTTP 关闭时若存在 `Mcp-Session-Id`，会尽力发送 `DELETE` 终止会话。
- 心跳：默认 30s 发送一次 `ping`，连续失败 2 次视为不健康（`provider.isHealthy` 可查询）。
- `ToolRegistry` 注册 Provider 时会订阅 `onToolsChanged`；MCP 服务端发 `notifications/tools/list_changed` 时自动失效缓存。
- 工具列表支持 TTL 缓存（`ToolRegistry({ toolCacheTtlMs })`），用于 HTTP 下及时感知工具变化。
- `registry.closeAll()` 会关闭所有 Provider（client.ts 退出时调用）。

### 接入代码

```ts
import { ToolRegistry } from "wireclaw";
import { createMcpProvider, LocalToolProvider } from "wireclaw/client";

const registry = new ToolRegistry({
  onProviderError: (id, error) => console.error(`[${id}]`, error),
  maxResultChars: 32 * 1024, // 工具结果上限（默认值）
  toolCacheTtlMs: 60_000,    // HTTP 下定期刷新工具列表（默认 0 = 不自动过期）
});

registry.registerProvider(new LocalToolProvider(process.cwd(), { id: "local" }));
registry.registerProvider(createMcpProvider({
  id: "mcp",
  transport: { type: "http", url: "http://127.0.0.1:5000/mcp" },
}));

// 退出时
await registry.closeAll();
```

> `wireclaw/client` 是 Node-only 参考宿主实现；核心包不导出本地工具和 stdio 传输。

### 已知限制

- HTTP 通知流依赖服务端支持 GET SSE；不支持时会自动降级，业务侧仍可用 `toolCacheTtlMs` 定期刷新工具列表。
- 工具媒体默认只回传当前轮；历史 tool 媒体会被剥离，暂不支持后续回看。
- MCP `resources/list` / `resources/read` 协议尚未实现；本轮只处理 `tools/call` 结果中的 embedded resource。
- `resource_link` 仅支持 http/https；`file://` 等协议保留文本占位。
- 仅支持静态请求头鉴权，未实现 OAuth。
- stdio 传输由 `src/client` 提供，已通过实机联调（Python 子进程）。
- 更多待办见根目录 `todo.md`。


