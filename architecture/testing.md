# Testing

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

