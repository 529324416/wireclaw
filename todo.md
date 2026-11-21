# Wireclaw TODO

## 工具系统

### 先回答：MCP 的能力边界

Wireclaw 目前实现的是 **MCP Client / Host**，不是 MCP Server；只覆盖 `tools` 子集。

MCP 并不只是「跨进程提供工具」：

- `tools`：模型可调用的函数（已实现）
- `resources`：服务端暴露的可读资源（文件、数据库记录、UI 资源等）
- `prompts`：服务端提供的提示模板，客户端可以选用
- `sampling` / `roots` / `elicitation`：服务端反向请求客户端能力（当前客户端未声明能力，统一拒绝）
- `tasks`（新协议修订）：长任务

当前 `examples/mcp_server.py` 只是验证用的最小 Server。

- [x] JSON-RPC 2.0 请求 / 响应 / 通知
- [x] `initialize` 握手、版本协商、`notifications/initialized`
- [x] `tools/list`（分页、去重）、`tools/call`、`ping`
- [x] stdio 传输
- [x] Streamable HTTP（JSON / SSE 响应、session id、协议版本头）
- [x] 工具名消毒 / 反向映射、注解与审批推导、结果与错误映射
- [x] Registry 缓存失效、`closeAll`、Provider 错误隔离
- [x] CLI 接入、`/tools`、Flask 示例、README
- [x] 传输关闭后的自动重连（Client `reconnect` + Provider 单次重试）
- [x] 工具列表缓存 TTL（HTTP 下及时感知工具变化）
- [x] HTTP 会话：`DELETE` 关闭
- [x] HTTP 断线恢复（后台 GET SSE + `Last-Event-ID` 续传）
- [x] stdio 实机测试（Python 子进程 + NDJSON）
- [x] 本地工具与 stdio 传输移出核心，改由参考客户端 `src/client` 提供
- [x] 服务端心跳 / 健康检查（默认 30s `ping`，连续失败标记不健康）

### 契约与上下文

- [x] 工具结果体量上限（Registry 统一，默认 32k 字符，可配置）
- [x] `outputSchema` 校验（结构错误作为工具失败结果回传模型）
- [x] `adviceTimeout`（默认 30s，上限 3600s）
- [x] 进度探针 API（按 `callId` 查询 + 延迟 5s 的 `TOOL_PROGRESS` 事件）
- [x] `host__ask_user` 人工选择题（Session 自动注入，可用 `enableUserInput` 关闭）
- [x] 工具结果信任标记（Tool/Provider 默认 + `trustHandle` 覆盖；提示/隔离由宿主消费）

### 协议广度

- [ ] `resources`
- [ ] `prompts`
- [x] `notifications/progress` 转发
- [ ] MCP `elicitation`（服务端发起的人工输入，复用 ask_user 表单机制）
- [ ] 更完整的 JSON Schema 校验（`pattern` / `oneOf` / `$ref` 等）
- [x] 用户图片附件（Ollama inline / DeepSeek Files API）
- [x] MCP 多模态结果接入附件系统，并作为输入回传模型（tool 生成的外部媒体；assistant 自身生成的媒体默认不回放）
- [ ] `tasks` / 长任务
- [x] 协议版本窗口：`2025-11-25` / `2025-06-18`，移除 `2024-11-05` 与旧版 HTTP+SSE
- [ ] `2026-07-28` 无状态客户端评估（移除 initialize / session）

### 工程化

- [x] `AIProvider` 能力契约：`chat` / `generate` / `decide`，`send` 重命名为 `chat`
- [x] Model 级 capabilities：通道 + I/O 类型（text/image/audio/video/structured/decision/embedding），并接入 Session 附件路由
- [x] ModelLimits：模型级输入限制，与协议编码/Provider 传输限制分层
- [x] `AIProvider.overwrite` / `overwriteMany` + `ModelProvider` 覆盖合并；核心只读模型 API，外部注入探测结果
- [x] 归一化模型能力：`capabilities` 唯一事实源，legacy bool 由 `normalizeModelInfo` 派生
- [x] Qwen Chat Completions 音视频输入规范确认（Data URI、编码后 <10MB、格式/时长）
- [x] `createNewSession` 组装入口：新历史、可选附件管理器、可选运行时选项、默认模型解析
- [x] `platform/shared` 共享层：HTTP / SSE / NDJSON 流式聚合 / OpenAI 兼容 adapter + provider 基类
- [x] DeepSeek、MiniMax Chat 迁移到共享基类；Ollama 复用共享流式聚合
- [ ] Anthropic 协议基类（`src/platform/shared/anthropic` 已预留空目录，待实现 Messages API）
- [x] 构建与分发：tsup 输出 browser/node bundle，tsc 输出声明，`exports` / `files` / `prepublishOnly`
- [x] 模型级工具/思考门禁：Session 与 OpenAI 兼容 / DeepSeek / Ollama 双层校验
- [x] 聚合测试入口 `tools/test-runner.mjs`、`typecheck:test`，并把 `tools/**` 纳入类型检查
- [x] 测试脚本与夹具重新入库（`test/`）
- [x] MiniMax H3-Image `GenerationCapability`（URL / b64_json + 模型级 capabilities）
- [x] MiniMax H3-Image 实机测试（国内站 `https://api.minimax.cn`，1K PNG）
- [x] MiniMax H3 视频异步任务 `GenerationTask`（创建 / 轮询 / 取消 / 恢复）
- [x] MiniMax H3 视频实机测试（4s / 768P / 16:9，H.264 + AAC）
- [x] MiniMax Chat Provider（M3/M2 文本对话、模型列表、流式与工具调用）
- [x] MiniMax Chat 实机测试（国内站，流式文本）
- [x] Qwen Chat Provider（OpenAI 兼容，图片/音频/视频输入，模型能力声明）
- [x] Qwen 音频/视频输入适配（`input_audio` / `video_url`，Data URI）
- [x] `/upload` 多媒体附件 + 模型输入能力外部校验
- [x] 模型级输入限制校验：MIME 白名单、原始/编码大小、数量；新增 `UnsupportedInput` / `InputLimitExceeded` / `UnsupportedMediaFormat`
- [x] Qwen 音频/视频输入实机测试（Session 链路 + 文本模型负向拒绝）
- [x] Qwen-Image 独立 `GenerationCapability`（DashScope multimodal-generation）
- [x] Qwen 实机测试（对话 / 图片理解；独立生图 Provider 实机验证）
- [x] MiniMax H3 本地 ToolProvider 多模态产出包装（Ollama 实机）
- [x] MiniMax H3-Image 参考图编辑（Tool 参数 + Provider + MCP Server）
- [x] MiniMax H3-Image `seed` / `negative_prompt` 参数透传
- [x] MiniMax H3 MCP Server 示例（Ollama / DeepSeek 实机）
- [x] ComfyUI Qwen-Image 2.1 本地生图工具（替换 CLI MiniMax H3 注册，实机通过）
- [x] ComfyUI 参考图槽位复用与 16 图上限（兼容单槽位/16 槽位工作流）
- [x] ComfyUI 修图工具（必须参考图，独立修图工作流）
- [x] MiniMax/ComfyUI 临时测试工具移出 `wireclaw/client`，放入根目录 `tools/`
- [x] `modelOverwrite.json` 本地模型静态能力覆盖（ModelInfo 深度合并）
- [x] Tool 多模态结果 Qwen 实机测试
- [x] assistant 媒体回放策略：历史保留、默认不回传、统一写 `[media:<contentHash>]` 标记
- [x] `host__view_media` 条件注入：按模型输入/输出媒体能力机械判断
- [x] tool 媒体出站：当前轮转 synthetic user 消息，历史 tool 媒体剥离
- [x] `host__view_media` 加入对音频和视频的回放支持
- [x] 新增媒体时长限制强制执行
- [x] 新增本地音频/视频超过 base64 10MB 时被拒绝
- [ ] Provider 原生 tool media 出站（Anthropic native 等，当前统一走 synthetic user）
- [ ] Qwen Omni 音频输出（暂缓）
- [ ] 显式模型且未初始化模型目录时的能力/限制兜底（可选自动 initModels 或要求宿主初始化）
- [ ] 多 Server 配置加载
- [ ] 工具 allowlist / 按 Server 的审批、并发、超时覆盖
- [ ] 鉴权（OAuth / 动态注册）—— 暂缓
- [ ] 指标、审计、限流 —— 暂缓
- [ ] Wireclaw 作为 MCP Server 的多客户端并发支持（远期）

## 附件系统

### 已完成

- [x] 内容寻址（SHA-256 contentHash）
- [x] `AttachmentFile` / `IFileHost` / `LocalFileHost`
- [x] 附件策略与存储分离：`AttachmentFileManager` + 原始 `IFileHost`
- [x] OPFS 宿主（浏览器 / Electron 渲染进程）与内存宿主
- [x] IndexedDB 宿主（浏览器存储不可用时的可选宿主）
- [x] `AttachmentFile` 原始路径组、路径合并与宿主字节丢失后的恢复
- [x] `AttachmentRef` 只保存 contentHash，严格序列化
- [x] `CloudFileManager` / `RemoteFileRef` / `AttachmentWireMap`
- [x] Session 发送前解析附件并注入 `ChatOptions`
- [x] Provider 切换时保留历史、按新 Provider 重新解析附件
- [x] Ollama 图片 inline base64
- [x] DeepSeek Files API 上传、3h TTL、校验、404/410 重传
- [x] 图片 magic-byte 校验、路径不可见字符清理
- [x] 上传 single-flight / 本地文件去重

### 待办

- [x] 浏览器/Electron 版 `IFileHost`（OPFS / IndexedDB / 原生文件系统；Electron 主进程使用 `LocalFileHost`）
- [ ] Electron 渲染进程的 IPC 桥接宿主（Session 不在主进程时）
- [x] 包入口拆分：`wireclaw` / `wireclaw/browser` 浏览器安全，`wireclaw/node` 追加 `LocalFileHost`，`wireclaw/client` 提供 Node-only 参考实现
- [x] `AttachmentFileError` 核心错误类型与错误码（Manager / Session 解析已接入）
- [x] 文件生命周期基础：`delete` / `stats` / `gc`（默认 dry-run）/ 恢复元数据登记
- [ ] Pin、压缩/归档、存储配额、引用计数持久化
- [ ] 共享 Provider 下的上传取消语义与等待者隔离
- [ ] 大文件流式读取/哈希/上传（当前主要在内存中处理）
- [ ] 图片预处理：尺寸/EXIF/压缩、token 估算、单请求图片数量限制
- [x] MCP `image` / `audio` / `resource` 接入 `IFileHost`，替换文本占位
- [x] Chat 输出媒体落盘入口（`ChatResult.attachments` / `ChatOptions.onAttachment` / `ASSISTANT_ATTACHMENT`；具体 Provider 待接）
- [ ] 远端文件清理/删除策略、缓存持久化与重启重建
- [x] 恢复会话时的附件存在性校验与缺失文件 UX（历史缺失降级、当前轮缺失失败）
- [x] 会话 schema 版本与工具 `structuredContent` 持久化
- [x] 会话附件元数据清单 sidecar（`<session>.attachments.json`）与 sourcePaths 恢复
- [ ] URL 附件的长度限制、下载超时与 SSRF 防护
- [ ] 安全：恶意文件、MIME 欺骗、多租户隔离、上传隐私/同意提示
- [ ] UI 缩略图/大文件流式渲染
- [ ] 更多 Provider 附件协议（OpenAI / Anthropic / Gemini 等）
- [ ] 补充实机测试：TTL 过期重传、跨 Provider 附件、并发上传、浏览器宿主


## 开发者反馈记录

- 结果体量上限应放在工具契约层统一处理，而不是每个 MCP Server 单独配置。
- `outputSchema` 校验做起来简单，结构错误应作为工具失败结果正常回传模型。
- `adviceTimeout` 值得加入：默认 30s，允许工具自定义，最大 3600s。
- 进度反馈可以做成类似探针的 API（按 `callId` 查询），但不是重点。
- 鉴权、指标/审计暂时不加。
- 若 Wireclaw 未来作为 MCP Server，需要处理多客户端并发。
- 多模态内容等附件系统完成后再补。
- 封闭开发阶段不保留向后兼容代码；序列化只接受当前 schema。
- 附件历史只保存 contentHash；Provider 切换后按新 Provider 重新解析。
- 允许自由切换 AIProvider， Provider 实例与 CloudFileManager 缓存应复用。
- DeepSeek 测试 key 仅本地使用，必须保持在 `.gitignore` 内。
- 附件系统仍需补齐生命周期、错误类型、浏览器宿主和更多 Provider 附件协议。
- assistant 自己生成的媒体默认不回放；MCP/tool 生成的外部媒体才需要作为输入回传给模型。
