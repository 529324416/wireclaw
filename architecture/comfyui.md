# ComfyUI Qwen-Image Tool

## 工具与工作流

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


