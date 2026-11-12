# Rotom

一个可嵌入的 AI Harness 模块：Session 负责「怎么运行」，LLM、工具、附件等具体实现都由外部提供。

当前能力：

- 对话 + 工具调用循环（AgentLoop）
- 工具注册表、工具名空间、参数校验、并发上限
- 三档权限：`readonly` / `approval` / `full`
- 工具审批暂停与恢复（`resume`）
- 本地工具（读/写文件，带工作区沙箱）
- MCP 工具客户端（stdio / Streamable HTTP）
- 会话序列化、保存/恢复

## 目录与架构

```
src/
  base/          纯原语（错误、JSON 工具、ID）
  session/       契约与运行时
                 ToolDefinition / ToolProvider / ToolRegistry、消息、事件、
                 AgentLoop、审批状态机、序列化
  platform/      LLM 平台实现（Ollama：ProtocolAdapter / LLMProvider / ModelProvider）
  tool/          工具实现
    local/       LocalToolProvider（进程内文件工具）
    mcp/         MCP 客户端与 McpToolProvider
```

依赖方向是单向的：

```
base  <-  tool  <-  session  <-  platform
             ^          |
             |          |
        （实现依赖契约，session 不依赖实现）
```

一句话：**session 只决定「如何与它交流、如何运行」；任何实现（本地工具、MCP、Ollama、未来的附件）都在外部。**

## 快速开始

```bash
npm install
npx tsx client.ts
```

前提：本机 Ollama 已启动（默认 `http://127.0.0.1:11434`），并有一个支持 tools 的模型（默认优先 `qwen3.5:9b`）。

环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama 地址 |
| `OLLAMA_MODEL` | 自动（优先 qwen3.5:9b） | 模型名 |
| `ROTOM_MCP_URL` | `http://127.0.0.1:5000/mcp` | MCP Server 地址 |
| `ROTOM_MCP_ID` | `mcp` | MCP 工具的 Provider 前缀 |
| `ROTOM_MCP_DISABLE` | 未设置 | 设为 `1` 时不注册 MCP |

CLI 命令：

| 命令 | 说明 |
|---|---|
| `/exit` | 退出 |
| `/model <name>` | 切换模型 |
| `/list_models` | 列出 Ollama 模型及能力 |
| `/tools` | 列出当前可用工具（含 MCP） |
| `/permission [readonly\|approval\|full]` | 查看/切换权限 |
| `/save_session [path]` | 保存会话（默认 `./rotom-session.json`） |
| `/restore_session [path]` | 恢复会话（会丢弃当前会话数据） |

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
- 三档权限：
  - `readonly`：只允许 `readOnlyHint === true` 的工具，其余直接拒绝
  - `approval`：`requiresApproval` 的工具暂停等待人工审批
  - `full`：全部放行，破坏性工具会发出 `TOOL_PERMISSION_WARNING`

## MCP 实现（tool/mcp）

### 一句话理解

Rotom 是 MCP **Host / Client**；Python/C#/Node 程序是 MCP **Server**。`McpToolProvider` 把远端 MCP 工具翻译成 Rotom 的 `ToolDefinition`，把模型发起的调用翻译回 `tools/call`。

### 文件职责

| 文件 | 职责 |
|---|---|
| `type.ts` | JSON-RPC 2.0 与 MCP 线上类型、协议版本、错误码 |
| `error.ts` | transport / protocol / response / timeout / abort 错误分类 |
| `transport.ts` | 传输层接口（只收发消息） |
| `stdio.ts` | stdio 传输：spawn 子进程，逐行 NDJSON |
| `http.ts` | Streamable HTTP：POST JSON-RPC，兼容 JSON / SSE 响应 |
| `client.ts` | 握手、请求复用、分页、超时、取消、通知、关闭 |
| `naming.ts` | MCP 原始工具名 → 模型安全 toolId |
| `config.ts` | `McpServerConfig` 与传输工厂 |
| `provider.ts` | `McpToolProvider`：工具映射、审批推导、结果转换 |

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

- **stdio**：Node 启动子进程，stdin/stdout 每行一个 JSON-RPC 消息；stderr 作为日志。
- **Streamable HTTP**：每个消息 POST 到同一个端点；响应可以是 `application/json`，也可以是 `text/event-stream`；自动记录并回传 `Mcp-Session-Id`，握手后附加 `MCP-Protocol-Version`。

### 工具名映射

MCP 工具名没有字符集限制，而模型侧只接受 `[A-Za-z0-9_-]`，且不允许 `__`：

- `fs.read` → `fs_read`
- `fs__write` → `fs_write`（连续下划线折叠）
- 冲突：`dup_a`、`dup_a_2`
- 超长：截断 + 8 位哈希
- `title` 保留 MCP 原始名，便于 UI 展示

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

| MCP | Rotom |
|---|---|
| `content[].type === "text"` | 拼接为文本 |
| `image` / `audio` / `resource` | 暂转文本占位（附件系统完成后升级） |
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
import { createMcpProvider, LocalToolProvider } from "./src/tool";
import { ToolRegistry } from "./src/session";

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

### 已知限制

- HTTP 通知流依赖服务端支持 GET SSE；不支持时会自动降级，业务侧仍可用 `toolCacheTtlMs` 定期刷新工具列表。
- 非文本内容暂转文本占位。
- 仅支持静态请求头鉴权，未实现 OAuth。
- stdio 传输已通过实机联调（Python 子进程）。
- 更多待办见根目录 `todo.md`。

## Python + Flask 测试服务器

`examples/mcp_server.py` 是一个最小 MCP Server，用于验证跨语言、跨进程调用。

```bash
pip install flask
python examples/mcp_server.py
# 自定义端口
MCP_PORT=5001 python examples/mcp_server.py
```

提供 5 个工具：

| 工具 | 类型 | 说明 |
|---|---|---|
| `echo` | 只读 | 回显文本 |
| `add` | 只读 | 数字相加 |
| `python_env` | 只读 | 返回 Python 版本 / 平台 / PID |
| `write_temp_file` | 破坏性 | 写入系统临时目录（触发审批） |
| `divide` | 只读 | 除零时返回 `isError` |

手动验证（PowerShell）：

```powershell
$body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:5000/mcp `
  -ContentType 'application/json' -Body $body
```

或启动 CLI 后：

```
> /tools
> 调用 mcp__python_env 并告诉我结果
```

## 测试

当前机械测试脚本放在 `test/`（暂未入库）：

```bash
npx tsx test/tool-registry.ts
npx tsx test/tool-contract.ts
npx tsx test/agent-loop.ts
npx tsx test/approval-concurrency.ts
npx tsx test/local-tools.ts
npx tsx test/permission.ts
npx tsx test/serialize-tool.ts
npx tsx test/mcp-client.ts
npx tsx test/mcp-provider.ts
npx tsx test/mcp-http.ts
npx tsx test/mcp-reconnect.ts
npx tsx test/mcp-http-resume.ts
npx tsx test/mcp-heartbeat.ts
npx tsx test/mcp-progress.ts
npx tsx test/mcp-stdio.ts
npx tsx test/mcp-flask.ts
```

实机测试：

1. 启动 Ollama；
2. 启动 Flask MCP Server；
3. `npx tsx client.ts`；
4. 用 `/tools` 确认 MCP 工具已注册；
5. 让模型调用 `mcp__python_env`（只读，自动）和 `mcp__write_temp_file`（审批）。
