# Getting Started

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


