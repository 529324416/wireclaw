# Rotom

一个可嵌入的 AI Harness 模块：Session 负责「怎么运行」，LLM、工具、附件等具体实现都由外部提供。

当前能力：

- 对话 + 工具调用循环（AgentLoop）
- 工具注册表、工具名空间、参数校验、并发上限
- 三档权限：`readonly` / `approval` / `full`
- 工具审批暂停与恢复（`resume`）
- 本地工具（读/写文件，带工作区沙箱）
- MCP 工具客户端（stdio / Streamable HTTP）
- 图片附件（内容指纹 + 本地文件宿主；Ollama 以 inline base64 发送）
- DeepSeek（Chat Completions + Files API，支持 `file_id` 上传复用）
- 多 Provider 切换（Ollama / DeepSeek）
- 会话序列化、保存/恢复

## 目录与架构

```
src/
  base/          纯原语（错误、JSON 工具、ID、编码）
  file/          附件契约与文件宿主
                 AttachmentFile / IFileHost / LocalFileHost / 图片类型识别
  session/       契约与运行时
                 ToolDefinition / ToolProvider / ToolRegistry、消息、事件、
                 AgentLoop、审批状态机、CloudFileManager、序列化
  platform/      LLM 平台实现
                 ollama.ts   ProtocolAdapter / ModelProvider / LLMProvider
                 deepseek.ts ProtocolAdapter / ModelProvider / CloudFileManager / LLMProvider
  tool/          工具实现
    local/       LocalToolProvider（进程内文件工具）
    mcp/         MCP 客户端与 McpToolProvider
```

依赖方向是单向的：

```
base  <-  file  <-  session  <-  platform
             ^          |
             |          |
        （实现依赖契约，session 不依赖具体实现）
```

一句话：**session 只决定「如何与它交流、如何运行」；任何实现（本地工具、MCP、Ollama、DeepSeek、附件宿主）都在外部。**

## 快速开始

```bash
npm install
npx tsx client.ts
```

前提：

- 使用 Ollama：本机 Ollama 已启动（默认 `http://127.0.0.1:11434`），并有一个支持 tools 的模型（默认优先 `qwen3.5:9b`）；图片输入需要 vision 模型。
- 使用 DeepSeek：准备 API key（`DEEPSEEK_API_KEY` 或 `./ds-apikey.txt`），无需启动 Ollama。

环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama 地址 |
| `OLLAMA_MODEL` | 自动（优先 qwen3.5:9b） | 模型名 |
| `ROTOM_PROVIDER` | `ollama` | 启动时使用的 LLM Provider：`ollama` / `deepseek` |
| `ROTOM_MCP_URL` | `http://127.0.0.1:5000/mcp` | MCP Server 地址 |
| `ROTOM_MCP_ID` | `mcp` | MCP 工具的 Provider 前缀 |
| `ROTOM_MCP_DISABLE` | 未设置 | 设为 `1` 时不注册 MCP |
| `ROTOM_FILES_DIR` | `./.rotom-files` | 本地附件仓库目录 |
| `DEEPSEEK_API_KEY` | 未设置 | 直接指定 DeepSeek API key（优先于文件） |
| `DEEPSEEK_API_KEY_FILE` | `./ds-apikey.txt` | DeepSeek API key 文件 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek API 地址 |
| `DEEPSEEK_MODEL` | `deepseek-flash` | DeepSeek 默认模型 |

CLI 命令：

| 命令 | 说明 |
|---|---|
| `/exit` | 退出 |
| `/provider [providerId]` | 查看/切换 LLM Provider：`ollama` / `deepseek` |
| `/model <name>` | 切换当前 Provider 的模型 |
| `/list_models` | 列出当前 Provider 的模型及能力 |
| `/tools` | 列出当前可用工具（含 MCP） |
| `/permission [readonly\|approval\|full]` | 查看/切换权限 |
| `/upload <image-path>` | 追加一个图片附件（jpg/jpeg/png/webp/gif），随下一条消息发送 |
| `/save_session [path]` | 保存会话（默认 `./rotom-session.json`） |
| `/restore_session [path]` | 恢复会话（会丢弃当前会话数据） |

Provider 切换：

- 默认使用 Ollama；启动时设置 `ROTOM_PROVIDER=deepseek` 可直接使用 DeepSeek。
- `/provider deepseek` 会读取 `DEEPSEEK_API_KEY` 或 `./ds-apikey.txt`，不会把 key 写入日志或会话。
- `/provider ollama` 可以切回本地模型。
- 会话历史中只保存附件的 `contentHash`；切换 Provider 后，同一张图片会由新 Provider 的 `CloudFileManager` 重新解析/上传。

## 附件系统（file + session 契约）

### 设计原则

- **历史只保存内容指纹**：消息里只出现 `contentHash`，不保存文件名、路径、MIME、字节、远端 fileId 或 URL。
- **文件实体由宿主保存**：`IFileHost` 负责本地不可变文件存储，`Session` 不关心存储介质。
- **远端表示由 Provider 负责**：`CloudFileManager` 负责上传、缓存、校验和过期处理。
- **ProtocolAdapter 只做编码**：Adapter 不访问 `IFileHost`，按平台把附件编码成 base64 / data URL / file_id / URL。

### 数据结构

- `AttachmentRef = { contentHash: string }`
- `AttachmentFile`
  - `contentHash`：SHA-256 小写十六进制
  - `name`
  - `mimeType?`
  - `content: Uint8Array`
  - `size`
  - 通过 `AttachmentFile.create()` 异步创建
- `RemoteFileRef`
  - `{ kind: "remote-id", fileId, ... }`
  - `{ kind: "inline", data: Uint8Array, ... }`
  - `{ kind: "url", url, ... }`
- `AttachmentWireMap = ReadonlyMap<string, RemoteFileRef>`

### IFileHost

```ts
put(name, content, mimeType?): Promise<AttachmentFile>
get(contentHash): Promise<AttachmentFile | undefined>
```

- 底层只要求 `put` / `get`；
- Node 端可以从路径读取后调用 `put`；
- 浏览器端可以从 `File`/`Blob` 读取后调用 `put`；
- `LocalFileHost` 是 Node 实现：
  - 文件按内容指纹命名；
  - 元数据存于 `<hash>.json`；
  - 同内容去重，首次写入的名称/MIME 为准；
  - 读取时校验指纹，损坏内容不会被当作有效附件。

### Session 解析流程

```text
发送前收集本轮所有消息中的唯一 contentHash
  → IFileHost.get
  → CloudFileManager.ensureFile
  → 构建 AttachmentWireMap
  → 写入 ChatOptions.attachmentRefs
  → ProtocolAdapter.toPayload
```

- `Session` 只在运行期持有 `AttachmentWireMap`，不持久化；
- 切换 Provider、切换文件宿主或切换会话时清空；
- 同一 `contentHash` 只解析一次；
- 附件缺失、Provider 不支持附件时在调用模型前失败；
- 失败运行不会污染历史。

### Provider 实现

- **Ollama**
  - 没有文件上传协议；
  - `OllamaCloudFileManager` 校验图片并返回 `inline`；
  - Adapter 编码为 `images: [base64]`；
  - 图片只允许出现在 user 消息。
- **DeepSeek**
  - 使用 Files API 上传，`purpose=user_data`；
  - 默认设置 3 小时有效期，可配置或设为永久；
  - 使用 `{ type: "file", file_id }` 引用；
  - 每次使用前通过 `GET /files/{id}` 校验；
  - 404/410 自动重新上传；
  - 距离过期不足 5 分钟时主动重传；
  - 同一 `contentHash` 并发 ensure 使用 single-flight。

### 序列化

- 严格 schema：附件只接受 `{ contentHash: string }`；
- 空指纹、缺失字段、类型错误全部拒绝；
- 不再兼容早期 `{ id }` 草稿；
- 会话 JSON 不包含远端 fileId、URL、字节或 Provider 信息；
- 会话 JSON 不是自包含的：恢复时必须由同一个 `IFileHost` 提供对应文件。

### 限制

- 当前支持 JPEG / PNG / GIF / WebP；
- DeepSeek 单文件上限 64 MiB；
- 上传/校验失败视为发送失败；
- MCP 的 image/audio/resource 仍暂时转为文本占位，尚未接入 `IFileHost`。

## DeepSeek 实现（platform/deepseek.ts）

- Base URL：`https://api.deepseek.com`
- Chat：`POST /chat/completions`，SSE 流式
- Files：`POST /files`、`GET /files/{id}`、`DELETE /files/{id}`
- 鉴权：`Authorization: Bearer <key>`

### 组成

- `DeepSeekProtocolAdapter`
  - 文本 / system / assistant / tool 消息转换；
  - `image_url` data URL、`file` file_id、tool calls；
  - `reasoning_content` 回传；
  - SSE chunk 解析。
- `DeepSeekModelProvider`
  - `GET /models`；
  - 读取 `input_modalities`、`effort.supported_levels`、上下文/输出上限；
  - `deepseek-flash` 支持图片，`deepseek-v4-pro` 为文本模型。
- `DeepSeekCloudFileManager`
  - 上传、缓存、校验、404 重传、TTL；
  - 支持注入 `fetch`，方便浏览器/Electron 走宿主代理。
- `DeepSeekLLMProvider`
  - Chat Completions + SSE；
  - `thinking` / `reasoning_effort` 映射；
  - tool calls、usage、错误处理；
  - 附件模型能力检查。

### 思考模式映射

- `think: false` → `thinking: { type: "disabled" }`
- `think: true` → `thinking: { type: "enabled" }`
- `thinkingLv` → `reasoning_effort: low | high | max`
- 兼容别名：`minimal`→`low`、`medium`/`xhigh`→`high`、`ultra`→`max`

### 配置

```ts
new DeepSeekLLMProvider({
  apiKey,
  baseUrl: "https://api.deepseek.com",
  headers: {},
  fetch: customFetch, // 可选
  files: {
    expiresAfterSeconds: 3 * 60 * 60, // 默认 3h；null 表示永久
    verify: true,
  },
});
```

## 多 Provider

- 启动时由 `ROTOM_PROVIDER=ollama|deepseek` 决定首选 Provider；
- 首选不可用时自动尝试另一个；
- `/provider` 查看 / 切换，Provider 实例与 CloudFileManager 缓存会被复用；
- 切换保留会话历史；
- 附件的远端表示会按新 Provider 重新解析；
- DeepSeek key 读取顺序：
  1. `DEEPSEEK_API_KEY`
  2. `DEEPSEEK_API_KEY_FILE`（默认 `./ds-apikey.txt`）
- key 不会写入日志、会话或源码；`ds-apikey.txt` 与 `.env*` 已在 `.gitignore` 中。

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
| `image` / `audio` / `resource` | 暂转文本占位（尚未接入 IFileHost，后续升级） |
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
npx tsx test/deepseek-protocol.ts
npx tsx test/attachment-protocol.ts
npx tsx test/local-file-host.ts
npx tsx test/approval-concurrency.ts
npx tsx test/local-tools.ts
npx tsx test/permission.ts
npx tsx test/serialize-tool.ts
npx tsx test/serialize-attachment.ts
npx tsx test/user-input.ts
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
