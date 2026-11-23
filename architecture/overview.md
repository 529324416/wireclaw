# Overview

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


