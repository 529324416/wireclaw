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
- 工具多模态结果接入附件系统（`ToolCallResult.attachments` / `TOOL_ATTACHMENT`；MCP image/audio/resource）
- 本地 ComfyUI Qwen-Image 2.1 生图工具（API 工作流、参考图上传、seed / negative_prompt）
- 媒体附件（内容指纹 + 本地/OPFS/IndexedDB 文件宿主；原始路径恢复；Ollama 以 inline base64 发送）
- DeepSeek（Chat Completions + Files API，支持 `file_id` 上传复用）
- 多 Provider 切换（Ollama / DeepSeek / MiniMax / Qwen）
- 模型级能力路由：按模型声明输入/输出模态，会话层校验图片/音频/视频输入
- 媒体输入限制：MIME、原始/编码后大小、数量、时长；支持音频/视频容器时长解析
- Qwen 图片/音频/视频输入；生图作为独立 `GenerationCapability`（会话级编排暂缓）
- 会话序列化、保存/恢复

## 目录与架构

```
src/
  base/          纯原语（错误、JSON 工具、ID、编码、媒体时长解析）
  file/          附件宿主实现与文件工具
                 LocalFileHost / OpfsFileHost / IndexedDbFileHost / MemoryFileHost / 图片类型识别
  session/       契约与运行时
                 AttachmentFile / IFileHost / AttachmentFileManager、
                 ToolDefinition / ToolProvider / ToolRegistry、消息、事件、
                 AgentLoop、审批状态机、CloudFileManager、序列化
  platform/      AI 平台实现
                 shared/     平台共享层
                   openai/   OpenAI 兼容 ProtocolAdapter / Provider 基类
                   anthropic/ 预留目录（Messages API 尚未实现）
                 ollama.ts   ProtocolAdapter / ModelProvider / AIProvider
                 deepseek.ts ProtocolAdapter / ModelProvider / CloudFileManager / AIProvider
                 minimax/    MiniMax Chat / H3-Image / H3 Video
                 qwen/       Qwen Chat（OpenAI 兼容）/ 独立生图 GenerationCapability
  tool/          MCP 协议客户端与 HTTP 传输（浏览器安全）
    mcp/         type / error / transport / http / client / naming / provider
  client/        Node-only 参考客户端实现（不进入核心/浏览器入口）
                 LocalToolProvider / MCP stdio / createMcpProvider / Qwen 参考覆盖表
tools/           临时测试工具（MiniMax H3 / ComfyUI 生图与修图；不随 npm 包分发）
examples/        示例 MCP Server 与 ComfyUI API 工作流
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

`ModelInfo.capabilities` 用于声明**模型级**能力，而不是平台级能力。能力按“通道 + I/O 类型”表达：

```ts
type ModelInputType = "text" | "image" | "audio" | "video" | "structured";
type ModelOutputType =
  | "text" | "image" | "audio" | "video"
  | "structured" | "decision" | "embedding";

capabilities: {
  chat?: {
    input: ModelInputType[];
    output: ModelOutputType[];
    streaming?: boolean;
    tools?: boolean;
    thinking?: boolean;
  };
  generate?: {
    input: ModelInputType[];
    output: ModelOutputType[];
    async?: boolean;
    // image/audio/video 是 output 的派生快捷标记
  };
  decide?: {
    input: ModelInputType[];
    output: ModelOutputType[]; // decision / structured
    options?: boolean;
    structuredOutput?: boolean;
  };
  embed?: {
    input: ModelInputType[];
    output: ["embedding"];
  };
};

// 模型级限制；与协议编码能力分开
limits?: {
  maxContextTokens?: number;
  maxOutputTokens?: number;
  input?: Partial<Record<ModelInputType, MediaInputLimit>>;
  output?: Partial<Record<ModelOutputType, MediaInputLimit>>;
};
```

- `capabilities` 是唯一事实源；`supportCompletion`、`supportToolCall`、`supportThink`、`isVisionModel`、`isEmbeddingModel` 只作为快捷 bool，由 `normalizeModelInfo` 统一派生；
- `generate.image/audio/video` 也是 `output` 的派生值，不由 Provider 手写；
- 例如 MiniMax-H3-Image 只有 `generate`（`output: ["image"]`），没有 `chat`；Session 不会把它误绑成对话 Provider。

**模型能力来源策略**：

- Wireclaw 只从模型 API 读取能力；不做内置探测/问模型/静态推断；
- API 不返回模态的平台，默认按文本能力处理；
- 宿主可以用 `AIProvider.overwrite(modelId, info)` / `overwriteMany([...])` 注入自己探测到的能力；
- 宿主覆盖是唯一事实源：模型目录未加载时也能直接读取覆盖数据；覆盖错误由后续 Provider 请求正常报错；
- 模型目录未加载且当前模型没有覆盖时，`Session.run` 会自动调用 `ModelProvider.initModels()` 兜底；初始化失败按“模型不接受媒体输入”处理，不阻塞纯文本对话；
- `ModelProvider` 负责合并覆盖并归一化，覆盖可以在模型列表加载前或加载后调用；
- `src/client/qwen-models.ts` 是参考 harness 的 Qwen 覆盖表，不是核心探测逻辑，宿主可以整体替换。
- 参考 harness 的 `client.ts` 还支持本地 `modelOverwrite.json`（`WIRECLAW_MODEL_OVERWRITE_FILE`）：文件条目按 `Partial<ModelInfo>` 书写，在 Provider 模型目录初始化后与默认 `ModelInfo` 深度合并；文件未出现的字段保留初始化默认值。支持数组和 `{ modelId: info }` 两种格式，也兼容 `isVisionModel` 等派生 bool 字段。
- `modelOverwrite.json` 只覆盖当前 Provider 目录中已存在的模型；它是宿主侧静态配置，不进入核心包。请把 `modelOverwrite.example.json` 复制为 `modelOverwrite.json` 后使用；默认文件已被 git 忽略。

**模型级工具与思考门禁**：

- Session 在运行前读取当前模型的 `chat.tools` / `chat.thinking`；模型明确声明 `tools:false` 时不向 Provider 下发任何工具（包括 `host__ask_user` / `host__view_media`），声明 `thinking:false` 时不传递 `think` / `thinkingLv`。模型能力未知时保持 Provider 级旧行为。
- OpenAI 兼容 Provider 在组装请求体时再按模型 `chat.tools` 做一次门禁；DeepSeek / Ollama 在模型明确声明 `thinking:false` 时不发送思考参数。
- 当前请求侧的思考参数映射仍由各 Provider 自行实现（DeepSeek 的 `thinking` / `reasoning_effort`、Ollama 的 `think`）；MiniMax / Qwen 的请求参数映射属于后续能力扩展，不影响门禁本身。

### 平台共享层（platform/shared）

- `shared/http.ts`：base URL 归一化、Bearer 鉴权头、fetch 解析、超时/取消信号与 HTTP 错误映射。
- `shared/stream.ts`：SSE / NDJSON 逐行读取与流式聚合（文本、思考、工具调用、usage、结束原因、附件回调）；Provider 的请求信号会贯穿正文读取，因此外部取消与超时在流式阶段仍然生效。
- OpenAI 兼容 Provider 的请求信号覆盖到完整响应正文：`postChat` 返回响应后由消费方在流读取结束时释放超时定时器与取消监听，避免“只保护响应头”。
- `shared/openai/`：`OpenAIProtocolAdapter` 与 `OpenAICompatibleProvider` 基类，负责 OpenAI 兼容的消息/工具/流式转换与请求骨架；平台通过覆写 `attachmentPart`、`parseUsage`、`parseStopReason`、`parseToolCalls`、`decoratePayload`、`checkChatOptions` 表达差异。
- 当前复用者：DeepSeek（Files API 附件）、MiniMax Chat、Qwen Chat；Ollama 仅复用 NDJSON 聚合。
- `shared/anthropic/` 为占位目录；Anthropic Messages API 的 adapter/provider 尚未实现，详见 `todo.md`。

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
- 使用 DeepSeek：准备 API key（`DEEPSEEK_API_KEY` 或 `./apikey-ds.txt`），无需启动 Ollama。
- 使用 MiniMax：准备 API key（`MINIMAX_API_KEY` 或 `./apikey-minimax-h3.txt`）。
- 使用 Qwen：准备 DashScope API key（`DASHSCOPE_API_KEY` 或 `./apikey-qwen.txt`）。

环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama 地址 |
| `OLLAMA_MODEL` | 自动（优先 qwen3.5:9b） | 模型名 |
| `WIRECLAW_PROVIDER` | `ollama` | 启动时使用的 LLM Provider：`ollama` / `deepseek` / `minimax` / `qwen` |
| `WIRECLAW_MCP_URL` | `http://127.0.0.1:5000/mcp` | MCP Server 地址 |
| `WIRECLAW_MCP_ID` | `mcp` | MCP 工具的 Provider 前缀 |
| `WIRECLAW_MCP_DISABLE` | 未设置 | 设为 `1` 时不注册 MCP |
| `WIRECLAW_FILES_DIR` | `./.wireclaw-files` | 本地附件仓库目录 |
| `DEEPSEEK_API_KEY` | 未设置 | 直接指定 DeepSeek API key（优先于文件） |
| `DEEPSEEK_API_KEY_FILE` | `./apikey-ds.txt` | DeepSeek API key 文件 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek API 地址 |
| `DEEPSEEK_MODEL` | `deepseek-flash` | DeepSeek 默认模型 |
| `MINIMAX_API_KEY` | 未设置 | 直接指定 MiniMax API key（优先于文件） |
| `MINIMAX_API_KEY_FILE` | `./apikey-minimax-h3.txt` | MiniMax API key 文件 |
| `MINIMAX_BASE_URL` | `https://api.minimax.cn` | MiniMax API 地址 |
| `MINIMAX_MODEL` | `MiniMax-M3.1-Flash` | MiniMax Chat 默认模型 |
| `COMFYUI_BASE_URL` | `http://127.0.0.1:8188` | ComfyUI API 地址 |
| `WIRECLAW_COMFYUI_WORKFLOW` | `./examples/comfyui/qwen-image-2.1-t2i.json` | ComfyUI 生图 API 工作流 JSON |
| `WIRECLAW_COMFYUI_EDIT_WORKFLOW` | `./examples/comfyui/qwen-image-2.1-image-edit.json` | ComfyUI 修图 API 工作流 JSON |
| `WIRECLAW_COMFYUI_TIMEOUT_MS` | `600000` | 单次生成总超时 |
| `WIRECLAW_COMFYUI_IMAGE_TOOL` | 未设置 | 设为 `0` 时不注册 ComfyUI 生图工具 |
| `WIRECLAW_COMFYUI_EDIT_TOOL` | 未设置 | 设为 `0` 时不注册 ComfyUI 修图工具 |
| `WIRECLAW_MODEL_OVERWRITE_FILE` | `./modelOverwrite.json` | 本地模型静态能力覆盖文件 |
| `DASHSCOPE_API_KEY` | 未设置 | 直接指定 Qwen API key（优先于文件） |
| `QWEN_API_KEY_FILE` | `./apikey-qwen.txt` | Qwen API key 文件 |
| `QWEN_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Qwen OpenAI 兼容入口 |
| `QWEN_MODEL` | `qwen-plus` | Qwen 默认对话模型 |

CLI 命令：

| 命令 | 说明 |
|---|---|
| `/exit` | 退出 |
| `/provider [providerId]` | 查看/切换 LLM Provider：`ollama` / `deepseek` / `minimax` / `qwen` |
| `/model <name>` | 切换当前 Provider 的模型 |
| `/list_models` | 列出当前 Provider 的模型及能力 |
| `/tools` | 列出当前可用工具（含 MCP） |
| `/permission [readonly\|approval\|full]` | 查看/切换权限 |
| `/system <text>` | 在会话还没有任何 user/assistant/tool 消息时追加 system 消息；已有对话时拒绝 |
| `/upload <media-path>` | 追加图片/音频/视频附件；按当前模型的 `chat.input` 与 `limits` 做外部校验，随下一条消息发送 |
| `/attachments` | 列出会话附件，导出到 `<WIRECLAW_FILES_DIR>/exports` 并打印 `file://` 链接，可用本地默认软件打开 |
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
require(contentHash): Promise<AttachmentFile>
getMeta(contentHash): Promise<StoredAttachmentMeta | undefined>
has(contentHash): Promise<boolean>
inspect(contentHashes): Promise<AttachmentAvailability[]>
list(): Promise<readonly StoredAttachmentMeta[]>
stats(): Promise<{ count; totalBytes }>
delete(contentHash): Promise<boolean>
gc(referencedHashes, { dryRun? }): Promise<{ dryRun; deleted; kept }>
registerRecoveryMeta(meta): void
rebuild(): Promise<void>
close(): Promise<void>
```

- `put`：计算指纹后立即调用 `host.write`，更新索引与有界 LRU 缓存；
- `get`：缓存 → `host.read` → 校验指纹；字节缺失时用 `host.readMeta` 的 `sourcePaths` 尝试读取原始路径，成功后写回宿主；
- `require`：明确要求附件可用；缺失时抛 `AttachmentFileError(Missing)`，错误里携带 `contentHash` / `sourcePaths`；
- `inspect`：批量返回 `present` / `metadata-only` / `missing`，不因单个附件失败而中断；用于恢复会话前检查；
- `readSourcePath` 由应用注入；Node / Electron 主进程通常使用 `readLocalSourcePath`，浏览器通常不提供；
- `registerRecoveryMeta`：登记会话附件清单中的元数据；宿主元数据或字节丢失时，用清单里的 `sourcePaths` 尝试恢复；
- `delete` / `gc`：显式生命周期接口；`gc` 默认 `dryRun: true`，只报告将删除的条目。调用方必须把**消息附件与 toolCall 参数中的 contentHash** 都放进 `referencedHashes`，否则参考图可能被误删；
- `collectAttachmentHashes(messages, { includeToolParams })` 是统一的引用收集入口；默认只收集消息附件，清单/清理场景开启 toolCall 参数扫描；
- 索引可随时通过 `host.list()` 重建；manager 自身不持久化整个附件库；
- 缓存只保存少量 `AttachmentFile`，不会常驻所有字节；
- 附件系统统一使用 `AttachmentFileError`（`Missing` / `Corrupted` / `RecoveryFailed` / `Storage` / `UnsupportedType` / `LimitExceeded` / `Network`），`origin` 保留底层错误。

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
- **当前轮附件缺失**（用户刚上传 / 工具刚产出）视为失败，抛出 `AttachmentFileError(Missing)`；
- **历史附件缺失**不会阻塞会话：被替换为 `[attachment unavailable: <contentHash>]` 文本，并移除相邻的 `[media:<contentHash>]` 标记；
- 恢复会话时先用 `AttachmentFileManager.inspect` 统计 present / metadata-only / missing，并打印缺失清单；恢复本身不失败；
- 失败运行不会污染历史。

### 模型能力与附件路由

- `AIProvider.supportsAttachmentInput`：是否能把会话附件转换为 Provider 可用表示（上传 / 内联）；默认由 `cloudFileManager` 是否存在推导。
- `AIProvider.supportsMediaOutput`：chat 是否可能返回媒体；默认 `false`。当前没有 chat provider 声明 `true`；生图能力由独立的 `GenerationCapability` 提供。
- `AIProvider.resolveModelCapabilities(model)`：读取已加载的模型列表或宿主覆盖；不主动发网络请求。模型未加载或未命中时返回 `undefined`，Session 退化为 Provider 级判断。
- 宿主可以通过 `AIProvider.overwrite` / `overwriteMany` 注入自己探测到的模型能力；Wireclaw 核心不做额外探测。
- Session 发送前按附件 MIME 推导模态：`image/*`、`audio/*`、`video/*`；如果模型 `chat.input` 已声明且不包含该模态，直接失败，不触发上传。非媒体附件（如 `text/plain`）不参与模态校验，交由具体 Provider 判断。
- 模型能力约束的是“输入模态”和“输出声明”；输出媒体由 Provider 实际返回，再由 Session 落盘。
- **两个模态集合语义不同**：
  - `viewableModalities`：模型 `chat.input` 中的媒体模态，表示模型能接收哪些媒体输入；用于当前轮 tool 媒体出站。
  - `selfViewableModalities`：`chat.input ∩ chat.output`，表示模型自己的产出能否回看；只用于 `host__view_media`。
  - 典型“图片输入 + 文本输出”模型：`viewableModalities = ["image"]`，`selfViewableModalities = []`；tool 图片能回传，但 assistant 历史图片不注入 `host__view_media`。
- `AIProvider.defaultModelLimits`：Provider 级媒体输入默认限制。模型目录尚未加载、或模型 `limits` 未声明某个模态时，Session 用它兜底；模型级限制按模态覆盖同名字段。
- 所有附件引用只保存 `contentHash`；真实字节只存在于 `IFileHost`。同一文件可以被多个会话引用，也可以在同一个会话中被多次引用。

### 媒体输入限制与时长

- Session 在 `ensureFile` 之前统一执行模型级媒体输入校验：MIME 白名单、原始字节、base64 编码后大小、数量、时长。
- 有效限制 = `AIProvider.defaultModelLimits` 与当前模型 `ModelInfo.limits` 的按模态合并；模型字段优先。
- 时长由 `src/base/media-duration.ts` 的 `readMediaDuration(data, mimeType)` 直接从容器元数据读取；它是纯工具函数，不依赖 DOM / Node / session：
  - 音频：WAV、MP3（含 Xing/VBRI）、AAC/ADTS、AMR / AMR-WB；
  - 视频：MP4 / MOV / 3GP（ISO BMFF `mvhd` / `mdhd` / `mehd`）、WebM / MKV（EBML）、AVI（RIFF）、FLV（AMF0 `onMetaData`）、WMV（ASF）；
  - 无法识别或容器损坏时返回 `undefined`。
- 如果模型声明 `maxDurationSeconds` 但无法确定时长，按 `UnsupportedMediaFormat` 拒绝；确定但超限按 `InputLimitExceeded` 拒绝。
- Qwen 的 10MB base64 编码上限通过 `QwenChatProvider.defaultModelLimits` 前移到 Session，模型目录未初始化时也会生效；`QwenCloudFileManager` 仍保留同样上限作为双保险。

### tool 多模态结果落盘与回传

- `ToolCallResult.attachments`（`PendingAttachment[]`）是工具产出媒体的统一出口；工具 Provider 不接触 `IFileHost`。
- Session 在工具执行完成后、生成 `ToolMessage` 之前调用 `AttachmentIngestor` 落盘：
  - 成功后把 `AttachmentRef` 追加到工具结果内容，并发 `TOOL_ATTACHMENT` 事件；
  - 落盘失败（包括 Session 没有 `AttachmentFileManager`）视为该工具调用失败，保留错误文本并继续运行；
  - 无 `AttachmentFileManager` 的 Session 无法承载工具媒体，这是宿主显式省略附件存储的情况。
- 当前轮 tool 附件在发送给 Provider 前转换成 synthetic user 消息，并附带 `[media:<contentHash>]` 标记；历史 tool 附件不再发送字节，只保留 `[tool media reference: <contentHash>]` 文本，供参考图工具引用。
- 用户消息中的附件在发送给模型时保留图片内容，并附带 `[media:<contentHash>]` 文本标记，模型可把该 hash 传给参考图工具。
- 出站按 `viewableModalities`（模型媒体输入）逐附件过滤：
  - 模型不支持的模态不会发给 Provider，只留下省略说明；
  - 模型能力未知时一律按“不支持媒体输入”处理，避免无意义的媒体 token 消耗。
- MCP `tools/call` 结果中的 `image` / `audio` / `resource.blob` / http(s) `resource_link` 会映射为 `PendingAttachment`；`text` 与 resource text 保持文本；`isError` 结果不落盘媒体。
- 工具媒体默认只对当前轮模型可见；assistant 自身媒体的回放策略见下一节。

### assistant 媒体回放与回看

- 历史与 UI 始终保留 `AttachmentRef`，Provider 返回的媒体不会丢；
- 发送给 Provider 时，assistant 附件统一替换为 `[media:<contentHash>]` 文本标记，不直接发送附件；
- 由于 assistant 附件只可能来自会话级媒体产出，纯文本对话不会出现该标记；
- **`host__view_media` 条件注入**（机械判断）：
  - 模型 `chat.output` 包含媒体模态；
  - 模型 `chat.input` 包含同一媒体模态（否则模型看不了）；
  - `selfViewableModalities` 中存在任一“输入 ∩ 输出”的媒体模态（image / audio / video）就注入；
  - Provider 支持工具调用，且模型 `chat.tools` 不为 `false`；
  - 因此“多媒体 → 文本”“文本 → 多媒体”“纯文本”都不会注册该工具；
- `host__view_media` 的参数就是 `contentHash`；Session 校验它必须出现在当前会话的 assistant 消息中，不能读取任意附件；
- Session 还会解析附件的实际模态，只允许回放 `selfViewableModalities` 中的媒体；不支持时返回工具错误结果，不把媒体发给 Provider；
- assistant 媒体默认不自动回放；模型需要时通过 `host__view_media` 主动回看。

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
- `AttachmentIngestor` 属于会话层的可选补充，**不属于协议层**：没有它，Provider 仍然可以返回媒体，只是宿主只能拿到原始字节/URL，无法得到可回放的 `AttachmentRef`；
- URL 下载只允许 http/https，默认拒绝 localhost / 私有地址，并校验大小和 MIME；
- `remote-id` 需要宿主注入 `resolveRemote`；
- 没有 `AttachmentFileManager` 时，Provider 返回媒体会让本次运行失败，不会静默丢弃；
- 流式与最终结果使用 `sourceId` 去重，最终结果覆盖同 sourceId 的流式片段；
- 当前没有 chat provider 实际返回媒体；`ChatResult.attachments` 链路已就绪，留给未来的会话级媒体输出。

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
  - 文生图 `POST /v1/images/generations`，图片编辑 `POST /v1/images/edits`，模型 `MiniMax-H3-Image`；
  - 支持 `response_format: "url"` 与 `"b64_json"`；
  - 支持 `seed`（复现随机种子）与 `negative_prompt`（负向提示词）；已在 `api.minimax.cn` 实测接口返回 200，Provider 会原样透传；
  - 默认 `area: "1K"`、`n: 1`、`output_format: "png"`，服务端超时默认 600s；
  - `ModelInfo.capabilities.generate.image = true`，`chat` 为空；
  - 结果返回 `GeneratedMedia[]`，由生成运行时或宿主交给 `AttachmentIngestor`；
  - 实机测试发现平台可能省略/错报 `output_format`，落盘时以文件头识别结果为准，并同步修正扩展名；
  - `size` 参数使用 `WIDTHxHEIGHT`（例如 `1024x1024`），不是 `1024*1024`；
  - **参考图编辑**：
    - 支持 1~16 张参考图；通过 `images[].image_url` 传入公网 URL、`mm_file://{file_id}` 或 `data:image/...;base64,...` Data URI；
    - 请求体总大小 ≤64 MiB（base64 约为原文件 4/3）；Provider 会在发送前校验图片格式、数量和编码后大小；
    - `GenerationRequest.referenceFiles` 传已解析的 `AttachmentFile[]`，`referenceUrls` 传 URL/Data URI；有参考图时自动走 `/v1/images/edits`；
    - 参考图编辑的 `ModelInfo.capabilities.generate.input` 声明为 `["text", "image"]`；
  - **作为多模态产出 Tool**：
    - 本地参考包装 `tools/minimax-image-tool.ts`（`MiniMaxImageToolProvider` / `createMiniMaxImageToolProvider`，临时测试工具，不随 npm 包分发），默认 `adviceTimeout = 600_000ms`，优先使用 `response_format: "b64_json"`；
    - Tool 参数从 `prompt` 扩展为 `prompt + optional references/seed/negative_prompt`；`references` 支持会话附件 `contentHash`（来自 `[media:<contentHash>]` 或 `[tool media reference: <contentHash>]`）或 http(s)/data:image URL；
    - MCP Server 示例 `examples/mcp_minimax_image_server.py` 同步支持 `references`（URL/Data URI），返回 `text + image` 内容块，由客户端统一落盘并回传模型；
    - 两者都只产出 `ToolCallResult.attachments`，不直接接触宿主文件系统。
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
- **Qwen（DashScope）**
  - 对话走 OpenAI 兼容 `POST /chat/completions`、`GET /models`；默认入口 `https://dashscope.aliyuncs.com/compatible-mode/v1`；
  - 图片/音频/视频输入以对应内容块内联发送；`QwenCloudFileManager` 接受 image/audio/video，不上传远端；
  - Qwen `/models` **不返回模态**；核心默认只声明文本能力，不做 ID 推断；
  - 参考 harness `src/client/qwen-models.ts` 通过 `overwriteMany` 注入 `qwen3.8-omni-*` / `qwen3.5-omni-*` / `qwen3-omni-*` / `qwen3-vl-*` / `qwen-image-*` 的能力；宿主可以整体替换；
  - **Chat Completions 音频/视频输入规范（已实测）**：
    - 音频：`{ type: "input_audio", input_audio: { data: "data:audio/wav;base64,...", format: "wav" } }`；`data` 必须是完整 Data URI，裸 base64 会 400；
    - 视频：`{ type: "video_url", video_url: { url: "https://..." } }`；**本地文件的 `data:video/mp4;base64,...` 也可用**；
    - 文本输出需要 `modalities: ["text"]`（Qwen3.5 Omni 可防止意外音频输出）；
    - Base64 编码后必须 <10MB；音频格式 AMR/WAV/3GP/3GPP/AAC/MP3，视频格式 MP4/AVI/MKV/MOV/FLV/WMV；
    - `qwen3.8-omni-flash` 音频 3h / 视频 2h；`qwen3-omni-flash` 音频 20min / 视频 150s；
  - **生图模型是独立的 `GenerationCapability`**：`qwen-image*` 不在 chat 目录中，`supportCompletion = false`、`generate.output = ["image"]`；参考覆盖表也会标记它们，`QwenChatProvider.chat()` 仍会拒绝生图模型；
  - `QwenImageProvider` 走 DashScope 原生 `POST /api/v1/services/aigc/multimodal-generation/generation`，返回 `GeneratedMedia[]`；不经过 Session，也不伪装成对话模型；
  - **会话级“边聊边画”暂缓**：Qwen 官方网页看起来是 host/MCP 工具编排（对话模型 + qwen-image 3.0），不是单模型能力；如果后续实现，应由 host tool 调用 `QwenImageProvider`，而不是把生图模型塞进 chat 路由；
  - 默认对话模型：`qwen-plus`；生图模型默认：`qwen-image-2.0`；
  - **音频/视频输入已实现**：Adapter 生成 `input_audio` / `video_url` 内容块；`QwenCloudFileManager` 接受图片/音频/视频并校验格式与 base64 <10MB；Session 按模型 `limits` + Provider 默认限制校验 MIME、编码后大小、数量和时长；
  - `/upload` 支持图片/音频/视频扩展名，并在上传前按当前模型能力与限制拒绝不支持的模态、编码超限或时长超限；
  - Omni 音频输出暂未实现；
  - 实机验证：文本对话、`qwen3-vl-plus` 图片理解；独立 `QwenImageProvider` 实机验证通过（`qwen-image-2.0`，约 937KB PNG）。

### 序列化

- 严格 schema：附件只接受 `{ contentHash: string }`；
- 空指纹、缺失字段、类型错误全部拒绝；
- 不再兼容早期 `{ id }` 草稿；
- `SessionData.version` 当前为 2；旧文件缺少 `version` 时按 1 接受，未来版本会被拒绝；
- 工具消息的 `structuredContent` 会持久化并 round-trip；旧文件没有该字段时按 `undefined` 处理；
- 会话 JSON 不包含远端 fileId、URL、字节或 Provider 信息；
- `sourcePaths` 保存在宿主元数据中，不进入会话 JSON；
- 参考 CLI 在保存会话时额外写 `<session>.attachments.json` 元数据清单（`SessionAttachmentManifestSerializer`），恢复时用 `registerRecoveryMeta` 补充宿主元数据/`sourcePaths`；清单是旁路文件，不改变会话 JSON 的隐私边界；
- 会话 JSON 不是自包含的：恢复时必须由同一个宿主提供对应文件与元数据；缺少元数据时可以由附件清单补足恢复线索。

### 限制

- Chat 输入支持图片（所有视觉 Provider）以及音频/视频（Qwen Omni）；音频/视频只在 Qwen 实现了协议编码；
- 模型级媒体限制：MIME 白名单、原始字节、base64 编码后大小、数量、时长；时长从常见容器元数据解析，无法确定且模型要求时长上限时严格拒绝；
- 当前时长解析覆盖 WAV / MP3 / AAC(ADTS) / AMR / AMR-WB、MP4 / MOV / 3GP、WebM / MKV、AVI、FLV、WMV(ASF)；Ogg 等未覆盖容器在模型声明 `maxDurationSeconds` 时会按“无法确定时长”拒绝；
- Session 只读取已加载的模型目录；显式指定模型但宿主未调用 `initModels()` 时，模型能力校验会跳过，但 `defaultModelLimits` 中的媒体限制仍会执行（Provider 仍会拒绝不支持的请求）；宿主应先初始化模型目录或注入覆盖；
- DeepSeek 单文件上限 64 MiB；
- 上传/校验失败视为发送失败；
- 路径恢复只在宿主元数据仍存在（或恢复了附件清单）、且至少一个原始路径可读时有效；
- 历史附件缺失会降级为 `[attachment unavailable: <hash>]`；当前轮附件缺失仍会导致运行失败；
- `delete` / `gc` 已提供；Pin、压缩/归档、存储配额、跨 Provider 的远端文件清理尚未实现；
- 浏览器存储（OPFS）可能被静默清理；Electron 主进程建议使用 `LocalFileHost`；
- assistant 媒体默认不回放，只保留在历史/UI；
- MiniMax Chat 暂不支持输入附件；
- Qwen Omni 音频输出未实现；
- MCP 的 image/audio/resource 已接入附件系统；非媒体 resource 会落盘但不会作为模型媒体输入发送。

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

- 启动时由 `WIRECLAW_PROVIDER=ollama|deepseek|minimax|qwen` 决定首选 Provider；
- 首选不可用时自动尝试其它 Provider；
- `/provider` 查看 / 切换，Provider 实例与 CloudFileManager 缓存会被复用；
- 切换保留会话历史；
- 附件的远端表示会按新 Provider 重新解析；
- key 读取顺序：
  1. 环境变量（`DEEPSEEK_API_KEY` / `MINIMAX_API_KEY` / `DASHSCOPE_API_KEY`）
  2. key 文件（`apikey-ds.txt` / `apikey-minimax-h3.txt` / `apikey-qwen.txt`）
- key 不会写入日志、会话或源码；`apikey*.txt` 与 `.env*` 已在 `.gitignore` 中。

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

## Harness Graph（Step 1 对象模型 + Step 2 运行时核心）

当前状态：Graph 对象模型、校验、JSON 序列化、value-first 运行时，以及内建 input / output / constant / model / model.call / agent.run 节点已实现；流式消费、EventTrigger、外部暂停/恢复尚未实现。

```text
src/harness/
  index.ts            公共入口
  definition.ts       Graph 文档版本与内建节点类型 ID 预留表
  base/               HarnessError / HarnessIssue、内部 JSON 工具
  graph/
    type.ts           JsonValue / HarnessValue / 端口 / ModelBinding / ToolSetSpec
    node.ts           GraphNode、NodeContext 契约
    edge.ts           Edge / PortAddress
    registry.ts       NodeTypeRegistry（宿主注册自定义节点）
    event.ts          GraphEvent / GraphEventListener（运行时事件契约）
    graph.ts          Graph：validate / assertValid / toJSON / fromJSON
  runtime/
    types.ts          GraphHost / GraphRunOptions / GraphRunResult / NodeRunRecord
    runner.ts         GraphRun、调度器、取消、生命周期事件
  serialize/
    document.ts       GraphDocument / NodeDocument
    serializer.ts     serializeGraph / deserializeGraph
    plugin.ts         序列化插件接口（占位，供版本迁移/私有字段使用）
  node/               内建节点：input / output / constant / model / model.call / agent.run
```

核心设计：

- **TS 优先**：Node、Edge、Graph 是运行时对象；JSON 只用于持久化、导出和编辑器交换。
- **端口与值**：端口声明 `PortValueType`（text/json/model/toolset/attachment/attachments/any）；值统一为 `HarnessValue`；媒体只保存 `AttachmentRef.contentHash`。
- **Value / Stream 预留**：输出端口用 `supportedModes` / `defaultMode` 声明；Step 2 运行时仍是 value-first，节点 `execute` 的 stream 输出通过 `ctx.emit` 转发事件、value 输出通过返回值。后续切换默认流式不需要改 Graph/Edge 结构。
- **自定义节点**：宿主用 `NodeTypeRegistry.register({ type, version, create, configSchema? })` 注册；JSON 只保存 `type + typeVersion + config + inputs + ui`，不携带可执行代码；未知类型或版本不匹配会拒绝反序列化。
- **校验**：节点 ID/端口唯一、边两端节点与端口存在、端口类型兼容、必填输入（边或默认值）、单输入端口只能一条边（`multiple: true` 例外）、重复边、环、图级参数/事件声明。
- **GraphDocument**：`version: 1`；显式 `nodes` 与 `edges`；节点 config/inputs/ui 必须是 JSON-safe；`ui` 仅服务设计器，运行时忽略。
- **反序列化**：`Graph.fromJSON(doc, { registry })` 默认执行完整校验；编辑器可用 `{ validate: false }` 载入未完成草稿。
- **序列化插件**：`HarnessSerializationPlugin` 预留节点迁移、私有字段编解码和第三方节点包接入点；当前内置逻辑只依赖 NodeTypeRegistry。
- **运行入口**：`graph.run({ host, input, listener, signal, maxConcurrency })` 返回 `GraphRun`；`run.done` 解析 `GraphRunResult`，并支持 `cancel()` / `onEvent()`。
- **调度器**：value-first DAG；依赖满足的节点并行执行（默认并发 4）；节点失败 fail-fast 并中止活跃节点；取消通过 AbortSignal 传播；每个节点写入 `NodeRunRecord`。
- **GraphHost**：宿主注入 `resolveProvider`、`tools`、`attachments`、`onToolApproval`、`onUserInput`、`log`；Graph JSON 只保存 providerId / modelId，不保存 Provider 实例或密钥。
- **内建节点**：`core.input` / `core.output` / `core.constant` / `core.model` / `core.model.call`（A，chat/generate）/ `core.agent.run`（B）。
- **A 节点**：复用一次性 Session 调用现有附件解析与模型门禁（`maxSteps: 1`、host 工具关闭）；generate 模式走 `GenerationCapability` 并落盘附件。
- **B 节点**：复用 Session/AgentLoop，注入宿主 `ToolRegistry`、权限、`maxSteps`；审批与 `host__ask_user` 通过 `GraphHost` 回调桥接；默认不注册 host 内置工具。
- **事件**：run/node 生命周期事件自动发出；`ctx.emit` 目前只转发 `node:stream`（尚无流消费者），`ctx.publish` 已能发出 `custom` 事件。

尚未实现：流式端口消费、EventTrigger 节点、图级暂停/恢复/checkpoint、`multiple` 输入 fan-in（Step 2 运行时明确报 `NotImplemented`）、Harness ToolSet（B 节点当前使用宿主全局 ToolRegistry）、Branch/Condition 节点、节点库/预设封装。

## ComfyUI Qwen-Image Tool

- 临时测试工具位于根目录 `tools/`，不属于 `wireclaw/client` 包入口，也不会随 npm 包分发。
- 实现：`tools/comfyui-image-tool.ts` 的 `ComfyUIImageToolProvider`（生图）与 `tools/comfyui-image-edit-tool.ts` 的 `ComfyUIImageEditToolProvider`（修图，强制至少 1 张参考图）；CLI 默认同时注册两者。
- 输入是 ComfyUI 导出的 API 格式工作流；Provider 自动定位：
  - `TextEncodeQwenImage21`：写入 `prompt` / `negative_prompt`
  - `EmptyLatentImage`：写入 `width` / `height`
  - `KSampler`：写入 `seed`（未提供时随机）
- Tool 参数与 MiniMax 版本对齐：`prompt` / `size` / `references` / `seed` / `negative_prompt`。
- 参考图：
  - `contentHash` 通过 `resolveReference` 从会话附件读取，URL/Data URI 直接下载/解码；
  - 通过 `POST /upload/image` 上传到 ComfyUI，再接到 `images.image_1` ... `images.image_16`；
  - 无参考图时移除 `images.*` 输入，按纯文生图执行；
  - 优先复用工作流已有的 `images.image_N` 槽位（`ImageScaleToTotalPixels` + `LoadImage`）；单槽位与 16 槽位工作流都支持；
  - 工作流没有对应槽位时，动态创建 `LoadImage` + `ImageScaleToTotalPixels` 节点。
- 生成流程：`POST /prompt` -> 轮询 `GET /history/{prompt_id}` -> `GET /view` 下载输出 -> `PendingAttachment`。
- 默认工作流示例：`examples/comfyui/qwen-image-2.1-t2i.json`（生图）与 `examples/comfyui/qwen-image-2.1-image-edit.json`（修图，已清理为可参数化版本）。
- 修图工具必须提供至少 1 张参考图；在提供 `size` 时会把工作流的 `ComfySwitchNode` 切到 `EmptyLatentImage`，让尺寸生效；不提供时沿用参考图 latent 尺寸。
- 已实机验证：无参考图生图、1 张参考图编辑、修图工作流、`size/seed/negative_prompt` 透传。

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

测试脚本与夹具位于 `test/`（已纳入版本库），推荐使用聚合入口：

```bash
npm test                 # 离线套件，默认跳过实机/本地服务脚本
npm run test:list        # 列出默认会运行的脚本
npm test -- model-gating # 按文件名过滤
npm run test:live        # --all，包含实机脚本
npm run typecheck:test   # 测试脚本类型检查
```

- `tools/test-runner.mjs` 用 esbuild 原生二进制把每个脚本打包成 ESM，再交给当前 Node 运行；不通过管道捕获子进程输出，因此兼容受限沙箱。
- 默认跳过依赖 Ollama / ComfyUI / Flask / Python 子进程或真实 API key 的脚本；`entry-smoke` / `package-types` 需要先构建 `dist`，缺失时会跳过并提示，也不进入 `typecheck:test`。
- `npm run typecheck` 现在包含 `typecheck:node`、`typecheck:browser`、`typecheck:test`；`tools/**` 也进入 Node 类型检查。

以下为逐脚本调试示例（非完整清单）：

```bash
npx tsx test/tool-registry.ts
npx tsx test/tool-contract.ts
npx tsx test/agent-loop.ts
npx tsx test/deepseek-protocol.ts
npx tsx test/attachment-protocol.ts
npx tsx test/session-capabilities.ts
npx tsx test/model-capabilities.ts
npx tsx test/view-media.ts
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
npx tsx test/shared-openai.ts
npx tsx test/ollama-offline.ts
npx tsx test/qwen.ts
npx tsx test/media-input.ts
npx tsx test/view-media.ts
npx tsx test/tool-media.ts
npx tsx test/mcp-media.ts
npx tsx test/minimax-image-tool.ts
npx tsx test/comfyui-image-tool.ts
npx tsx test/comfyui-image-edit-tool.ts
npx tsx test/model-overwrite.ts
npx tsx test/model-gating.ts
npx tsx test/attachment-lifecycle.ts
npx tsx test/tool-trust.ts
npx tsx test/ask-user-choice.ts
```

实机用例：

```bash
python examples/mcp_minimax_image_server.py   # 端口默认 5001
npx tsx test/tool-media-ollama-live.ts        # 本地 MiniMax H3 Tool + Ollama
npx tsx test/minimax-image-reference-live.ts  # MiniMax H3-Image 参考图编辑
npx tsx test/mcp-tool-media-ollama-live.ts    # MCP MiniMax H3 + Ollama
npx tsx test/mcp-tool-media-deepseek-live.ts  # MCP MiniMax H3 + DeepSeek
npx tsx test/tool-media-qwen-live.ts          # 本地 MiniMax H3 Tool + Qwen
npx tsx test/comfyui-image-live.ts            # ComfyUI Qwen-Image 2.1 生图 + 参考图
npx tsx test/ollama-protocol.ts
npx tsx test/factory-live-deepseek.ts
npx tsx test/qwen-live.ts
npx tsx test/qwen-image-live.ts
npx tsx test/qwen-media-live.ts
npx tsx test/live-services.ts   # MiniMax Chat / H3-Image / H3-Video
```

实机测试：

1. 启动 Ollama；
2. 启动 Flask MCP Server；
3. `npx tsx client.ts`；
4. 用 `/tools` 确认 MCP 工具已注册；
5. 让模型调用 `mcp__python_env`（只读，自动）和 `mcp__write_temp_file`（审批）。
