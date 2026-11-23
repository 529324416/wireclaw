# Harness Examples

## 最小可运行示例

`examples/harness/minimal.ts` 用代码创建 `InputNode -> UppercaseNode -> OutputNode` 并连边；`UppercaseNode` 同时是自定义节点示例。运行：

```bash
npm run example:harness
```

`test/harness-minimal.ts` 用同一张图做离线回归。该案例是后续 Landing 的 canary，不依赖 Provider / 外部服务。

Landing A 预设依赖案例：

```bash
npm run example:preset
```

- `examples/harness/preset-dependency.ts` 使用 `NodePresetDocument` 实例化一个带 `tools__echo` 依赖的 B 节点；
- 有工具时，fake Provider 发起工具调用，最终输出 `tool result: echo:hello`；
- 移除工具后，`GraphRun` 在启动前以 `MissingToolDependency` 失败；
- 恢复工具后再次运行成功；
- 图 JSON 中保留 `agent` 节点的 `requires` 声明。

Landing B 分支案例：

```bash
npm run example:branch
```

- `examples/harness/branching.ts` 创建 Branch 图时**不包含 MergeNode**；
- 条件 true/false 分别只执行对应分支，另一侧 `skipped`；
- 两条分支输出直接连入同一个 input，由运行时隐式 `exclusive` join 汇合；
- 两个并发来源直接进入同一输入时，以 `AmbiguousJoin` 失败；
- 显式 MergeNode 仍作为对照路径可用。

Landing C 组合案例：

```bash
npm run example:composite
```

- `examples/harness/composite.ts` 包含四个阶段：
  - Subgraph：外层 input -> 内嵌上层转换图 -> 外层 text；
  - ForEach：JSON 数组逐项运行内嵌子图，收集 results；
  - Loop：maxIterations 内递增状态，内层 `done` 提前结束；
  - Checkpoint：两个延迟节点之间 pause，打印 checkpoint 记录，resume 后完成。
- 该案例离线运行，不依赖 Provider / 外部服务。

真实流水线门面：

```bash
npm run harness
npm run harness -- "自定义主题"
```

- 根目录 `harness.ts` 是 harness 设计器的可运行门面，串联：
  - Qwen A 节点生成英文生图提示词；
  - B 节点通过 `comfyui-image__generateImage` 调用本地 ComfyUI；
  - Qwen-VL A 节点读取生成图，输出中文说明；
  - Output 节点同时输出说明文本与图片附件。
- B 节点现在会从本次 run 的全部消息中收集附件，包括工具媒体结果；因此 ComfyUI 生成的图片可以直接从 `image.attachments` 传给下游/输出。
- 生成物写入 `harness-output/`（已加入 `.gitignore`）：`<timestamp>-image.png` 与 `<timestamp>-caption.txt`。
- 依赖：ComfyUI `http://127.0.0.1:8188`、`apikey-qwen.txt` 或 `DASHSCOPE_API_KEY`。
- 已实机验证：一次完整运行约 40s，输出 1024x1024 图片与中文说明。

四格漫画流水线：

```bash
npm run comic
npm run comic -- "自定义故事"
```

- Qwen 规划恰好 4 个 panel brief，`comic.plan` 解析为 JSON 数组；
- ForEach 逐格执行；每格内部用 LoopNode（最多 3 次）串联“生图 → Qwen-VL 审查 → 反馈回写状态 → 重做”；
- LoopNode 输出最后一轮图片附件，ForEach 聚合 4 张附件；
- 审查通过才结束该格；用尽重试仍失败时，仍输出合图，但门面以非零退出并报告失败格；
- `retryOnError: true` 同时覆盖临时 Provider/工具失败；
- ffmpeg 将 4 张图拼成 2×2 contact sheet，写入 `comic-output/`；
- `COMIC_FORCE_RETRY_PANEL=<index>` 可用于演练重试路径。




