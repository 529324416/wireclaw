# Wireclaw

[English](./README.md) | 简体中文

Wireclaw 是一个可嵌入的 AI Harness 模块。

它把「对话循环、工具调用、审批与权限、附件管理、会话序列化、多 Provider 适配」这些流程收敛成可组装的 `Session`；LLM、工具、附件存储等具体实现由宿主提供。

> 详细架构、Provider/MCP/附件实现、构建与测试说明见 [architecture.md](./architecture.md)。

## 状态

- 当前版本：`0.1.1`（早期版本，API 仍可能调整）
- 包格式：ESM
- Node：`>=20.3.0`
- 核心入口浏览器安全；Node-only 能力放在子路径
- License：MIT，见 [LICENSE](./LICENSE)

## 安装

```bash
npm install wireclaw
```

## 包入口

| 入口 | 内容 |
|---|---|
| `wireclaw` | 浏览器安全核心：Session、附件管理器、Provider、MCP 核心 |
| `wireclaw/browser` | 显式浏览器安全入口，与根入口一致 |
| `wireclaw/node` | 追加 `LocalFileHost` / `readLocalSourcePath` |
| `wireclaw/client` | Node-only 参考客户端：本地工具、MCP stdio、`createMcpProvider` |

## 快速开始：Node + Ollama

```ts
import { createNewSession, OllamaProvider } from "wireclaw";

const session = createNewSession(new OllamaProvider());

const run = await session.run("你好，介绍一下你自己");
console.log(run.status);
```

`createNewSession` 会创建一条空历史的新会话。没有显式传模型时，首次运行会向 Provider 询问默认模型（Ollama 优先 `qwen3.5:9b`）。

DeepSeek：

```ts
import { DeepSeekProvider, createNewSession } from "wireclaw";

const llm = new DeepSeekProvider({
  apiKey: process.env.DEEPSEEK_API_KEY!,
});

const session = createNewSession(llm);
await session.run("你好");
```

MiniMax（国内站）：

```ts
import { MiniMaxChatProvider, createNewSession } from "wireclaw";

const provider = new MiniMaxChatProvider({
  apiKey: process.env.MINIMAX_API_KEY!,
  baseUrl: "https://api.minimax.cn",
  model: "MiniMax-M3.1-Flash",
});

const session = createNewSession(provider);
await session.run("你好");
```

Qwen（DashScope，OpenAI 兼容）：

```ts
import { QwenChatProvider, createNewSession } from "wireclaw";

const provider = new QwenChatProvider({
  apiKey: process.env.DASHSCOPE_API_KEY!,
  model: "qwen-plus",
});

const session = createNewSession(provider);
await session.run("你好");
```

Qwen 的 `/models` 不返回输入模态。参考客户端会调用 `wireclaw/client` 的 `applyQwenReferenceModelOverrides`；库使用者应通过 `provider.overwriteMany(...)` 注入自己的探测结果。Omni 模型可以接收文本、图片、音频和视频（音频/视频以 Data URI 发送）。`qwen-image-*` 是独立的 `GenerationCapability`，不是对话模型；需要直接生图时使用 `QwenImageProvider`。

`Session` 会在上传前执行当前模型的媒体输入限制（MIME、原始/编码后大小、数量、时长）。Qwen 内联音频/视频经 base64 编码后上限为 10 MB。

## 附件：Node 本地文件

```ts
import { readFile } from "node:fs/promises";

import { AttachmentFileManager, OllamaProvider, createNewSession } from "wireclaw";
import { LocalFileHost, readLocalSourcePath } from "wireclaw/node";

const path = "/absolute/path/photo.png";
const bytes = new Uint8Array(await readFile(path));

const host = new LocalFileHost("./.wireclaw-files");
const attachmentManager = new AttachmentFileManager(host, {
  readSourcePath: readLocalSourcePath,
});

const session = createNewSession(new OllamaProvider(), attachmentManager);
const file = await attachmentManager.put("photo.png", bytes, "image/png", [path]);

await session.run([
  { type: "text", text: "描述这张图片" },
  { type: "attachment", attachment: { contentHash: file.contentHash } },
]);
```

`sourcePaths` 会随附件元数据保存；宿主字节被删除时，管理器会尝试从原始路径恢复。历史消息中的附件缺失会以 `[attachment unavailable: <contentHash>]` 文本降级，不再阻塞会话；当前轮新附件缺失仍会使运行失败。

## 浏览器 / Electron 渲染进程

```ts
import {
  AttachmentFileManager,
  createNewSession,
  OllamaProvider,
  OpfsFileHost,
} from "wireclaw/browser";

const host = new OpfsFileHost();
const attachmentManager = new AttachmentFileManager(host);
const session = createNewSession(new OllamaProvider(), attachmentManager);

await session.run("你好");
```

- 浏览器里不要 import `wireclaw/node` 或 `wireclaw/client`，它们包含 `node:fs` / `node:child_process`；
- 渲染进程直接请求 Ollama / DeepSeek 可能遇到 CORS，通常需要通过宿主代理或主进程转发；
- Electron 主进程使用 `wireclaw/node`，渲染进程使用 `wireclaw/browser`。

## 工具与 MCP

核心包提供 MCP 客户端与 HTTP 传输：

```ts
import { McpHttpTransport, McpToolProvider, ToolRegistry } from "wireclaw";

const registry = new ToolRegistry();
registry.registerProvider(new McpToolProvider(
  { id: "mcp" },
  new McpHttpTransport({ url: "http://127.0.0.1:5000/mcp" }),
));

await session.run("查一下当前 Python 环境", { tools: registry });
```

Node 宿主还可以使用参考实现：

```ts
import { ToolRegistry } from "wireclaw";
import { LocalToolProvider, createMcpProvider } from "wireclaw/client";

const registry = new ToolRegistry();
registry.registerProvider(new LocalToolProvider(process.cwd()));
registry.registerProvider(createMcpProvider({
  id: "mcp",
  transport: { type: "http", url: "http://127.0.0.1:5000/mcp" },
}));
```

工具结果带有信任标记（`ToolCallResult.trust` / `ToolMessage.trust`）：Tool / Provider 声明默认值，宿主可以通过 `new ToolRegistry({ trustHandle })` 按次覆盖。信任标记不改变权限，`full` 仍然是 `full`；宿主可以用它做提示边界、UI 徽章或审计。

工具结果可以通过 `ToolCallResult.attachments` 携带媒体。`Session` 会把它们写入附件管理器，并在当前模型接受该媒体输入时，转换成下一轮的 synthetic user 消息。MCP 的 `image` / `audio` / `resource` 结果复用同一条链路。参考 MiniMax H3-Image 与 ComfyUI Qwen-Image 工具还支持可选的 `references`（会话 contentHash 或图片 URL）、`seed` 与 `negative_prompt`。

参考 Node 客户端会注册两个本地 ComfyUI Qwen-Image 工具：`comfyui-image__generateImage` 与 `comfyui-edit__editImage`（后者必须提供至少 1 张参考图）。可通过 `COMFYUI_BASE_URL`、`WIRECLAW_COMFYUI_WORKFLOW` 与 `WIRECLAW_COMFYUI_EDIT_WORKFLOW` 指向其他实例/工作流。这些测试工具位于 `tools/`，不属于发布的 `wireclaw/client` 入口。

参考客户端还支持从本地 `modelOverwrite.json`（可用 `WIRECLAW_MODEL_OVERWRITE_FILE` 改路径）合并模型静态能力；条目使用 `ModelInfo` 字段，在模型目录初始化后覆盖默认值，未提供的字段保留默认配置。请把 `modelOverwrite.example.json` 复制为 `modelOverwrite.json` 后再修改；默认文件已被 git 忽略。

三档权限：

```ts
await session.run("只读查询", {
  tools: registry,
  permission: "readonly",
});
```

`readonly` / `approval` / `full` 的完整语义见 [architecture.md](./architecture.md)。

## 开发

```bash
npm install
npm run typecheck   # 源码、浏览器安全面、tools 与测试脚本
npm test            # 离线套件；默认跳过实机/本地服务脚本
npm run test:live   # 实机脚本；需要本地服务或 API key
npm run build
```

构建产物在 `dist/`：

```
dist/
  browser/index.js
  node/node.js
  node/client.js
  types/
```

## 文档

- [architecture.md](./architecture.md)：架构、Provider、MCP、附件系统、构建与测试
- [LICENSE](./LICENSE)：MIT

## License

MIT © 2026 biscuit

<!-- 维护提示：README 保持为简介 + 基础用法；实现细节请写入 architecture.md。 -->
