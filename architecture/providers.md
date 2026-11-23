# Providers

## AIProvider 与能力边界

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

## 平台共享层（platform/shared）

- `shared/http.ts`：base URL 归一化、Bearer 鉴权头、fetch 解析、超时/取消信号与 HTTP 错误映射。
- `shared/stream.ts`：SSE / NDJSON 逐行读取与流式聚合（文本、思考、工具调用、usage、结束原因、附件回调）；Provider 的请求信号会贯穿正文读取，因此外部取消与超时在流式阶段仍然生效。
- OpenAI 兼容 Provider 的请求信号覆盖到完整响应正文：`postChat` 返回响应后由消费方在流读取结束时释放超时定时器与取消监听，避免“只保护响应头”。
- `shared/openai/`：`OpenAIProtocolAdapter` 与 `OpenAICompatibleProvider` 基类，负责 OpenAI 兼容的消息/工具/流式转换与请求骨架；平台通过覆写 `attachmentPart`、`parseUsage`、`parseStopReason`、`parseToolCalls`、`decoratePayload`、`checkChatOptions` 表达差异。
- 当前复用者：DeepSeek（Files API 附件）、MiniMax Chat、Qwen Chat；Ollama 仅复用 NDJSON 聚合。
- `shared/anthropic/` 为占位目录；Anthropic Messages API 的 adapter/provider 尚未实现，详见 `todo.md`。


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


