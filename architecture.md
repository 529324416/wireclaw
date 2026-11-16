# Wireclaw Architecture

> 本文档描述 Wireclaw 的架构、实现细节、Provider/MCP/附件系统、构建与测试。
> 项目简介和基础用法请见 [README.md](./README.md)。

一个可嵌入的 AI Harness 模块：Session 负责「怎么运行」，LLM、工具、附件等具体实现都由外部提供。

当前能力：

- 对话 + 工具调用循环（AgentLoop）
- 工具注册表、工具名空间、参数校验、并发上限
- 三档权限：`readonly` / `approval` / `full`
- 工具审批暂停与恢复（`resume`）
- 本地工具与 MCP stdio（由参考客户端 `src/client` / `wireclaw/client` 提供；核心包只保留契约与 HTTP 传输）
- MCP 工具客户端（HTTP 核心，stdio 可注入）
- 图片附件（内容指纹 + 本地/OPFS/IndexedDB 文件宿主；原始路径恢复；Ollama 以 inline base64 发送）
- DeepSeek（Chat Completions + Files API，支持 `file_id` 上传复用）
- 多 Provider 切换（Ollama / DeepSeek）
- 会话序列化、保存/恢复

## 目录与架构

```
src/
  base/          纯原语（错误、JSON 工具、ID、编码）
  file/          附件宿主实现与文件工具
                 LocalFileHost / OpfsFileHost / IndexedDbFileHost / MemoryFileHost / 图片类型识别
  session/       契约与运行时
                 AttachmentFile / IFileHost / AttachmentFileManager、
                 ToolDefinition / ToolProvider / ToolRegistry、消息、事件、
                 AgentLoop、审批状态机、CloudFileManager、序列化
  platform/      AI 平台实现
                 ollama.ts   ProtocolAdapter / ModelProvider / AIProvider
                 deepseek.ts ProtocolAdapter / ModelProvider / CloudFileManager / AIProvider
                 minimax/    MiniMax H3-Image / H3 Video GenerationCapability
  tool/          MCP 协议客户端与 HTTP 传输（浏览器安全）
    mcp/         type / error / transport / http / client / naming / provider
  client/        Node-only 参考客户端实现（不进入核心/浏览器入口）
                 LocalToolProvider / MCP stdio / createMcpProvider
```

依赖方向是单向的：

```
base
  ↑
session（契约 + 运行时）
  ↑            ↑            ↑
platform      tool         file
```

一句话：**session 只决定「如何与它交流、如何运行」；任何实现（本地工具、MCP、Ollama、DeepSeek、附件宿主）都在外部。**

### AIProvider 与能力边界

`AIProvider` 是平台/模型的统一门面，但不强制实现所有能力：

- `ChatCapability`：对话，`Session` 只绑定这一能力；
- `GenerationCapability`：生图 / 生语音 / 生视频，由独立生成运行时消费；
- `DecisionCapability`：决策模型，由独立决策运行时消费。

能力通过接口实现和类型守卫判断（`isChatProvider` / `isGenerationProvider` / `isDecisionProvider`），而不是把不支持的方法做成空实现。`ProtocolAdapter`、鉴权、端点选择和任务查询都封装在具体 Provider 内部，Session 不感知。

`ModelInfo.capabilities` 用于声明**模型级**能力，而不是平台级能力：

```ts
capabilities: {
  chat?: { input?: ModelModality[]; output?: ModelModality[]; ... };
  generate?: { image?: boolean; audio?: boolean; video?: boolean; async?: boolean; ... };
  decide?: { structuredOutput?: boolean };
}
```

例如 MiniMax-H3-Image 只有 `generate.image = true`，没有 `chat`；Session 不会把它误绑成对话 Provider。

### 包入口

| 入口 | 内容 |
|---|---|
| `wireclaw` | 浏览器安全核心：base / session / file（浏览器宿主）/ platform / MCP 核心 |
| `wireclaw/browser` | 与 `wireclaw` 相同的浏览器安全入口，语义更明确 |
| `wireclaw/node` | 核心 + `LocalFileHost` / `readLocalSourcePath` |
| `wireclaw/client` | Node-only 参考客户端：`LocalToolProvider`、MCP stdio、`createMcpProvider` |

`wireclaw/client` 是可选参考实现，不进入核心契约，也不会被 `wireclaw` / `wireclaw/browser` 自动加载；宿主可以完全替换为自己的工具、传输和存储实现。

### 组装入口

`createNewSession` 创建一个空历史的新 Session，不恢复旧会话：

```ts
import { AttachmentFileManager, createNewSession } from "wireclaw";
import { LocalFileHost, readLocalSourcePath } from "wireclaw/node";

const host = new LocalFileHost("./.wireclaw-files");
const attachmentManager = new AttachmentFileManager(host, {
  readSourcePath: readLocalSourcePath, // Node 宿主提供
});

const session = createNewSession(
  provider,            // 由上级对象维护，必须实现 ChatCapability
  attachmentManager,   // 可省略，表示不使用附件
  // runtimeOptions 可省略
);

await session.run("hello");
```

- 不传 `runtimeOptions` 时，`Session` 在首次运行前向 Provider 询问默认模型；
- `think` / `thinkingLv` 未设置时保持 Provider 默认；
- 附件管理器、AIProvider、运行时选项由上级对象维护，工厂只负责组装；
- 恢复历史会话不走这个入口：使用 `SessionSerializer.deserialize` 后自行构造 `Session`。

### 构建与发布

```bash
npm run build
```

构建产物：

```
dist/
  browser/index.js    浏览器安全核心（无 node:* 依赖）
  node/node.js        Node 核心 + LocalFileHost
  node/client.js      Node 参考客户端（本地工具 / MCP stdio）
  types/              tsc 生成的 .d.ts
```

- `package.json` 的 `exports` 指向 `dist`，`files` 只发布 `dist`；
- `prepublishOnly` 会在发布前自动执行构建；
- `tsup` 负责 ESM bundle，`tsc` 负责声明文件；
- 浏览器构建使用 `platform: "browser"`，如果误引入 `node:fs` / `node:child_process` 会直接构建失败；
- Node 构建使用 `platform: "node"`，内置模块保持外部依赖。

发布前可用：

```bash
npm pack --dry-run
```

检查包内文件是否符合预期。

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
| `WIRECLAW_PROVIDER` | `ollama` | 启动时使用的 LLM Provider：`ollama` / `deepseek` |
| `WIRECLAW_MCP_URL` | `http://127.0.0.1:5000/mcp` | MCP Server 地址 |
| `WIRECLAW_MCP_ID` | `mcp` | MCP 工具的 Provider 前缀 |
| `WIRECLAW_MCP_DISABLE` | 未设置 | 设为 `1` 时不注册 MCP |
| `WIRECLAW_FILES_DIR` | `./.wireclaw-files` | 本地附件仓库目录 |
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
| `/save_session [path]` | 保存会话（默认 `./wireclaw-session.json`） |
| `/restore_session [path]` | 恢复会话（会丢弃当前会话数据） |

Provider 切换：

- 默认使用 Ollama；启动时设置 `WIRECLAW_PROVIDER=deepseek` 可直接使用 DeepSeek。
- `/provider deepseek` 会读取 `DEEPSEEK_API_KEY` 或 `./ds-apikey.txt`，不会把 key 写入日志或会话。
- `/provider ollama` 可以切回本地模型。
- 会话历史中只保存附件的 `contentHash`；切换 Provider 后，同一张图片会由新 Provider 的 `CloudFileManager` 重新解析/上传。

## 附件系统（session 契约 + file 宿主）

### 设计原则

- **历史只保存内容指纹**：消息里只出现 `contentHash`，不保存文件名、路径、MIME、字节、远端 fileId 或 URL。
- **策略与存储分离**：`AttachmentFileManager` 负责索引、去重、校验、缓存与路径恢复；`IFileHost` 只负责字节和元数据的读写。
- **文件实体由宿主保存**：`IFileHost` 的具体实现决定介质（本地目录、OPFS、内存），`Session` 不关心存储细节。
- **原始路径是恢复线索**：`AttachmentFile` 保存 `sourcePaths`；同一内容从不同路径上传时合并路径组；宿主元数据会持久化路径组。
- **远端表示由 Provider 负责**：`CloudFileManager` 负责上传、缓存、校验和过期处理。
- **ProtocolAdapter 只做编码**：Adapter 不访问宿主，按平台把附件编码成 base64 / data URL / file_id / URL。

### 数据结构

- `AttachmentRef = { contentHash: string }`
- `AttachmentFile`
  - `contentHash`：SHA-256 小写十六进制
  - `name`
  - `mimeType?`
  - `content: Uint8Array`
  - `size`
  - `sourcePaths`：原始文件路径组，用于宿主字节丢失后的恢复
  - 通过 `AttachmentFile.create()` 异步创建
- `StoredAttachmentMeta`：宿主中的元数据（含 `sourcePaths`）
- `StoredAttachment`：元数据 + 字节
- `RemoteFileRef`
  - `{ kind: "remote-id", fileId, ... }`
  - `{ kind: "inline", data: Uint8Array, ... }`
  - `{ kind: "url", url, ... }`
- `AttachmentWireMap = ReadonlyMap<string, RemoteFileRef>`

### IFileHost

```ts
read(contentHash): Promise<StoredAttachment | undefined>
readMeta(contentHash): Promise<StoredAttachmentMeta | undefined>
write(file: StoredAttachment): Promise<StoredAttachmentMeta>
list(): Promise<readonly StoredAttachmentMeta[]>
delete?(contentHash): Promise<boolean>
flush?(): Promise<void>
close?(): Promise<void>
```

- 只做字节与元数据读写，不计算指纹、不做缓存与去重策略；
- `write`：内容不存在时写入；已存在时不覆盖；名称/MIME 以首次写入为准；`sourcePaths` 取并集；
- `readMeta` / `list` 可以返回字节已丢失、但元数据仍在的记录，供路径恢复；
- `LocalFileHost` 是 Node / Electron 主进程实现：
  - 文件按内容指纹命名，元数据存于 `<hash>.json`；
  - 同内容去重，首次写入的名称/MIME 为准；
  - 路径组持久化在元数据中；
- `OpfsFileHost` 是浏览器 / Electron 渲染进程实现，布局与 `LocalFileHost` 一致；
- `IndexedDbFileHost` 是浏览器 / Electron 渲染进程的可选实现，元数据与内容分两个 store 存放；
- `MemoryFileHost` 用于测试。

### AttachmentFileManager

```ts
put(name, content, mimeType?, sourcePaths?): Promise<AttachmentFile>
get(contentHash): Promise<AttachmentFile | undefined>
has(contentHash): Promise<boolean>
rebuild(): Promise<void>
close(): Promise<void>
```

- `put`：计算指纹后立即调用 `host.write`，更新索引与有界 LRU 缓存；
- `get`：缓存 → `host.read` → 校验指纹；字节缺失时用 `host.readMeta` 的 `sourcePaths` 尝试读取原始路径，成功后写回宿主；
- `readSourcePath` 由应用注入；Node / Electron 主进程通常使用 `readLocalSourcePath`，浏览器通常不提供；
- 索引可随时通过 `host.list()` 重建；manager 自身不持久化整个附件库；
- 缓存只保存少量 `AttachmentFile`，不会常驻所有字节。

### Session 解析流程

```text
发送前收集本轮所有消息中的唯一 contentHash
  → AttachmentFileManager.get
      → host.read
      → [字节缺失] readMeta + sourcePaths → readSourcePath → host.write
      → 校验指纹
  → CloudFileManager.ensureFile
  → 构建 AttachmentWireMap
  → 写入 ChatOptions.attachmentRefs
  → ProtocolAdapter.toPayload
```

- `Session` 只在运行期持有 `AttachmentWireMap`，不持久化；
- 切换 Provider、切换附件管理器或切换会话时清空；
- 同一 `contentHash` 只解析一次；
- 附件缺失或恢复失败时视为数据损坏，在调用模型前失败；
- 失败运行不会污染历史。

### Chat 输出媒体落盘

Chat Provider 可以通过三种方式返回媒体：

- 非流式：`ChatResult.attachments`；
- 流式：`ChatOptions.onAttachment` / `StreamChunk.attachment`；
- 最终 `AssistantMessage` 中只保存 `AttachmentRef`。

Session 收到 `PendingAttachment` 后调用 `AttachmentIngestor`：

```text
PendingAttachment (bytes / url / remote-id)
  → AttachmentIngestor
  → AttachmentFileManager.put
  → AttachmentRef
  → AssistantMessage.content
  → ASSISTANT_ATTACHMENT 事件
```

- `AttachmentIngestor` 不负责生成任务轮询，只负责媒体规范化、下载和落盘；
- URL 下载只允许 http/https，默认拒绝 localhost / 私有地址，并校验大小和 MIME；
- `remote-id` 需要宿主注入 `resolveRemote`；
- 没有 `AttachmentFileManager` 时，Provider 返回媒体会让本次运行失败，不会静默丢弃；
- 流式与最终结果使用 `sourceId` 去重，最终结果覆盖同 sourceId 的流式片段。

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
- **MiniMax H3-Image**
  - 只实现 `GenerationCapability`，不实现 `ChatCapability`；
  - `POST /v1/images/generations`，模型 `MiniMax-H3-Image`；
  - 支持 `response_format: "url"` 与 `"b64_json"`；
  - 默认 `area: "1K"`、`n: 1`、`output_format: "png"`，服务端超时默认 600s；
  - `ModelInfo.capabilities.generate.image = true`，`chat` 为空；
  - 结果返回 `GeneratedMedia[]`，由生成运行时或宿主交给 `AttachmentIngestor`；
  - 实机测试发现平台可能省略/错报 `output_format`，落盘时以文件头识别结果为准，并同步修正扩展名。
- **MiniMax H3 Video**
  - 只实现 `GenerationCapability`，返回异步 `GenerationTask`；
  - `POST /v2/video_generation` 创建任务，`GET /v2/query/video_generation/{task_id}` 轮询；
  - 查询响应可能是 `{ task: {...} }`，Provider 会兼容包装与顶层两种结构；
  - 默认 `duration: 4`、`resolution: "768P"`、`ratio: "16:9"`，降低测试成本；
  - `GenerationTask.cancel()` 调用 `DELETE /v2/video_generation/{task_id}`；
  - 实机测试输出：4.46s，1344×768，H.264 + AAC，约 990KB。
- **MiniMax Chat**
  - OpenAI 兼容 `POST /v1/chat/completions`，`GET /v1/models`；
  - 模型目录包含 `MiniMax-M3.1-Flash` / `MiniMax-M3` / M2 系列；
  - 支持流式文本、reasoning_content、工具调用、usage；
  - `ModelInfo.capabilities.chat` 声明 streaming / tools / context；
  - 暂不支持 Chat 附件输入，`cloudFileManager` 为空；
  - CLI 可通过 `WIRECLAW_PROVIDER=minimax` 或 `/provider minimax` 切换。

### 序列化

- 严格 schema：附件只接受 `{ contentHash: string }`；
- 空指纹、缺失字段、类型错误全部拒绝；
- 不再兼容早期 `{ id }` 草稿；
- 会话 JSON 不包含远端 fileId、URL、字节或 Provider 信息；
- `sourcePaths` 保存在宿主元数据中，不进入会话 JSON；
- 会话 JSON 不是自包含的：恢复时必须由同一个宿主提供对应文件与元数据。

### 限制

- 当前支持 JPEG / PNG / GIF / WebP；
- DeepSeek 单文件上限 64 MiB；
- 上传/校验失败视为发送失败；
- 路径恢复只在宿主元数据仍存在、且至少一个原始路径可读时有效；
- 浏览器存储（OPFS）可能被静默清理；Electron 主进程建议使用 `LocalFileHost`；
- MCP 的 image/audio/resource 仍暂时转为文本占位，尚未接入附件系统。

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
- `DeepSeekProvider`
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
new DeepSeekProvider({
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

- 启动时由 `WIRECLAW_PROVIDER=ollama|deepseek` 决定首选 Provider；
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
- 非文本内容暂转文本占位。
- 仅支持静态请求头鉴权，未实现 OAuth。
- stdio 传输由 `src/client` 提供，已通过实机联调（Python 子进程）。
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
npx tsx test/opfs-file-host.ts
npx tsx test/indexeddb-file-host.ts
npx tsx test/approval-concurrency.ts
npx tsx test/local-tools.ts
npx tsx test/permission.ts
npx tsx test/serialize-tool.ts
npx tsx test/serialize-attachment.ts
npx tsx test/user-input.ts
npx tsx test/mcp-client.ts
npx tsx test/mcp-version.ts
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
