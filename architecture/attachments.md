# Attachments

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


