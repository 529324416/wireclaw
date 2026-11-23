# Wireclaw Architecture

Wireclaw 的架构文档按模块拆分为多个文件。项目简介与基础用法见
[README.md](../README.md)。

## 模块索引

### 基础

- [Overview](./overview.md)：定位、能力边界、目录结构、包入口、组装入口
- [Getting Started](./getting-started.md)：快速开始与基础用法
- [Build and Publish](./build.md)：构建、发布与包产物

### Session / Provider

- [Providers](./providers.md)：AIProvider 能力契约、平台共享层、DeepSeek、多 Provider
- [Attachments](./attachments.md)：附件系统、宿主、模型能力路由、媒体限制、序列化

### 工具

- [Tools and MCP](./tools-mcp.md)：工具契约、权限、信任标记、MCP 客户端/传输/缓存
- [Python + Flask MCP Test Server](./mcp-example.md)：最小 MCP Server 示例

### Harness

- [Harness Overview](./harness/README.md)：目标、非目标、用例、已完成能力、不足、路线图
- [Harness Runtime](./harness/runtime.md)：Graph 对象模型、节点、分支/汇合、子图、ForEach、Loop、pause/checkpoint
- [Harness Presets](./harness/presets.md)：节点预设、依赖校验、序列化、GraphEditor 目录
- [Harness Examples](./harness/examples.md)：最小图、Branch、Landing C、真实流水线、四格漫画

### 本地服务

- [ComfyUI Qwen-Image Tool](./comfyui.md)：本地生图/修图工具与工作流
- [Testing](./testing.md)：离线测试、实机测试与入口检查

## 维护约定

- 模块文档只描述该模块的目标、契约、实现与限制；
- 任务清单放在根目录 [todo.md](../todo.md)；
- 跨模块的路线图放在 [Harness Overview](./harness/README.md) 与根目录 todo；
- 根目录 [architecture.md](../architecture.md) 仅保留跳转入口。
