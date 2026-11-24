# Wireclaw Harness

> 本文描述 Harness 模块的目标、用例、当前能力、已知不足与后续路线。
> 任务拆解见 [todo.md](../../todo.md)，整体架构见 [architecture/README.md](../README.md)。

相关模块文档：

- [Runtime](./runtime.md)
- [Presets](./presets.md)
- [Examples](./examples.md)

---

## 1. 定位与目标

Harness 是 wireclaw 的 **TS-first 可执行图运行时**，也是 Harness Designer 的执行内核。

核心目标：

1. **对象模型优先**
   - `Node` / `Edge` / `Event` / `Graph` / `Graph.run()` 是运行时对象；
   - JSON 只用于序列化、持久化、编辑器传输，不作为运行时事实源。

2. **可组合**
   - 单模型调用（A 类）、AgentLoop/Session 调用（B 类）、机械节点、子图、ForEach、Loop 可以组合；
   - Graph 可以嵌入另一个 Graph，形成可复用的子图。

3. **可校验**
   - 端口类型、必填输入、边、环、重复节点、模型/工具/参数依赖都要能在运行前定位；
   - 内层图也应能在设计期校验，而不是运行到一半才失败。

4. **可观测、可恢复**
   - 运行事件、节点记录、checkpoint、暂停/恢复；
   - 长任务（视频/批量生图）需要可持久化、可续跑的作业模型。

5. **宿主注入**
   - Provider、ToolRegistry、AttachmentFileManager、审批/提问回调、参数由宿主提供；
   - Harness 不保存密钥、不直接绑定某个模型厂商。

6. **浏览器安全**
   - `wireclaw` 根入口和 `wireclaw/browser` 不依赖 Node-only 模块；
   - 本地文件、ComfyUI、CLI 门面属于 Node 侧参考实现。

---

## 2. 非目标

- **不替用户决定创作方法**  
  例如“四格漫画必须先做角色定稿图”是设计层选择。Harness 的目标是让这种设计容易表达，而不是强制所有漫画都走同一流程。
- **不是聊天 UI / Agent 产品**  
  Harness 负责图执行；Session 负责单次 Agent 对话。两者通过 B 节点连接。
- **不做任意 DAG 回边**  
  回退通过显式 Loop/Subgraph 表达，不引入不可分析的任意后向边。
- **不把密钥、Provider 实例、工具实例序列化进图**  
  图只保存身份与配置，实例由宿主注入。

---

## 3. 典型用例

### 3.1 单图生成流水线

```text
主题
  → Qwen A 节点生成英文生图提示词
  → B 节点通过 ToolSet 调用本地 ComfyUI Qwen-Image
  → Qwen-VL A 节点读取生成图并写说明
  → Output 输出文本 + 图片附件
```

实现：根目录 [harness.ts](../../harness.ts)  
命令：`npm run harness`

### 3.2 四格漫画 + 审查重试

```text
主题
  → Qwen 规划四格 panel brief
  → ForEach 每格
      → LoopNode（最多 3 次）
          → ComfyUI 生图
          → Qwen-VL 审查
          → 失败：反馈写回状态，再生成
          → 通过：done
  → ForEach 聚合四张图
  → ffmpeg 合成 2×2
```

实现：根目录 [harness-comic.ts](../../harness-comic.ts)  
命令：`npm run comic`

这个用例暴露了一个重要边界：

- 单格 retry 是 Loop 能解决的；
- 角色跨格一致性是**跨迭代/全局约束**，不是单格 Loop 能保证的；
- 正确设计应在前面增加“角色定稿/参考图”阶段，并让每格引用同一组 `ReferenceSet`；
- Harness 应该提供资产、参考、候选、追踪能力，而不是替用户决定角色。

### 3.3 节点预设与依赖

- 节点预设保存 config、默认输入、依赖；
- 依赖检查覆盖 model / provider / tool / parameter；
- 预设导入导出与迁移已在 A 阶段完成。

### 3.4 未来用例

- 视频生成：多镜头、异步任务、进度、取消、断点续跑、合并。
- 批量修图：ForEach 并发、每项参考图、局部失败、结果集合。
- 多 Agent 审查/辩论：Subgraph + Loop + 结构化审查结果。
- 人工选稿：图级 HumanGate，暂停并展示候选，选择后继续。

---

## 4. 当前已完成

### 4.1 对象模型与序列化

- `Node` / `Edge` / `Event` / `Graph` / `Graph.run()`
- typed ports：text / json / model / toolset / attachment / attachments / any
- `HarnessValue` 运行时值；JSON 仅用于序列化
- `GraphDocument` 读写、版本、节点类型版本、草稿模式
- `Graph.validate()`（非抛出，返回 issues）与 `assertValid()`
- Graph 级/节点级 ToolSet、参数、UI 元数据
- 节点预设、预设库、导入导出、迁移、GraphEditor catalog

### 4.2 运行时

- value-first 调度：等待输入、聚合、输出、下游触发
- `skipped` 传播、隐式 exclusive join、`AmbiguousJoin`
- Branch / Choice、fan-in、multiple value / stream
- stream 输出、EventTrigger、custom event
- A 类 `ModelCall`：chat/generate、图片/音频/视频输入
- B 类 `AgentRun`：Session/AgentLoop、ToolSet、审批/提问、工具媒体
- 运行事件、节点记录、取消、并发上限

### 4.3 组合与长任务

- `SubgraphNode`：内嵌 GraphDocument，复用同一 registry / provider / tools / attachments / parameters
- `ForEach`：JSON 数组逐项运行子图，输出 results / count / attachments
- `Loop`：bounded loop，JSON state + `done`，输出 value / iterations / attachments，支持 `retryOnError`
- `pause()` / `resume()` / `Graph.resume(checkpoint, options)`
- `GraphCheckpoint`：outputs、records、edgeStates、pending、ready
- `run:paused` / `run:resumed` 事件

### 4.4 真实链路

- 根目录 `harness.ts`：Qwen + 本地 ComfyUI 生图 + Qwen-VL 说明
- 根目录 `harness-comic.ts`：四格规划 + 逐格审查 + 重试 + ffmpeg 合图
- B 节点会从 assistant/tool 消息收集媒体附件，工具生成图可直接进入下游
- 已实际运行：
  - 单图链路约 40s，输出 1024×1024 PNG；
  - 四格漫画链路可完成规划/生图/审查/重试/合图；严格审查下可能出现某格用尽重试，门面会保留合图并以非零退出报告失败格。

### 4.5 验证

- `npm run typecheck`：源码、浏览器安全面、测试三套通过
- `npm test`：64/64 通过（离线）
- `npm run harness` / `npm run comic`：真实链路
- 构建后入口/包类型测试通过

---

## 5. 当前不足

### 5.1 状态模型太窄

- Loop 状态是 JSON；附件靠单独输出带出；
- 没有统一的 `ValueBundle`，无法自然携带“文本 + JSON + 多张带角色标签的图片”；
- 跨轮/跨格共享上下文只能手工接线；
- 附件的 role/label/lineage 不存在，只有 contentHash。

**影响**：角色定稿图、候选图、审查图很难稳定传递；四格漫画需要大量自定义节点和手工接线。

### 5.2 跨迭代/全局一致性能力不足

- Loop 只能保证“当前格”的 retry；
- 无法表达“四格必须同一角色”的全局约束；
- 没有 candidate set / best-of-N / selection；
- 不能按 panelId 回退并只重做部分格；
- 全局审查后无法方便地更新集合中的某一项。

**影响**：四格漫画的角色一致性只能靠用户在设计层解决；Harness 不能自然表达“角色定稿 + 全格引用”。

### 5.3 嵌套图契约与静态校验不足

- `Graph.validate()` 不递归校验 Subgraph/Loop/ForEach 内嵌图；
- 内层 requirements 不传播到外层；
- Subgraph 只有固定 text/attachments/json 映射，没有显式端口契约；
- 内嵌 GraphDocument 重复存储，没有 graph registry / version pinning；
- checkpoint 只校验 graphId，不校验图内容 hash / node type version；
- 子图递归没有深度保护。

**影响**：设计期合法、运行期才失败；恢复时图已变化可能语义不一致。

### 5.4 可观测性不足

- 事件是扁平流，Loop/ForEach/Subgraph 靠自定义前缀区分层级；
- `NodeRunRecord` 没有输入/输出/attempt/tool job id；
- 看不到每格每轮的参考图、prompt、ComfyUI prompt id、审查意见；
- 没有树形 run trace 和 attempt trace。

**影响**：四格漫画调参困难，无法快速定位“哪一格、哪一轮、用了哪张参考图、为什么失败”。

### 5.5 错误、补偿与预算

- 节点失败通常终止整个 GraphRun；
- `retryOnError` 只是 Loop 的局部能力，不是通用节点策略；
- 没有 fallback model/tool、error port、局部失败结果；
- 没有 deadline、cost/token/tool-call budget；
- 重试可能重复工具副作用（生图/扣费），没有幂等键；
- 没有部分结果/补偿清理语义。

### 5.6 长任务与持久化

- pause/checkpoint 只在节点边界，节点执行中不能 checkpoint；
- 工具调用是同步的，没有异步 job 抽象；
- 进程重启后不能恢复正在执行的 ComfyUI/MiniMax 视频任务；
- checkpoint 没有持久化存储、版本迁移、stream 通道重放；
- 流式输出在恢复后不能重放。

### 5.7 并发与批处理

- ForEach 串行；
- 没有并发上限、限流、fail-fast / collect-errors / partial-result 策略；
- 没有批量结果排序、筛选、去重、合并的一等语义。

### 5.8 人审与选择

- 人工审批/提问只在 B 节点 Session 内部；
- 没有图级 HumanGate；
- 没有“展示候选 → 人工选一个 → 继续/重做”的标准节点；
- 与 checkpoint 的结合还不完整。

### 5.9 设计器体验

- 节点 `configSchema`（JSON Schema 子集）、默认 config、分类与关键词已补齐，GraphEditor 可自动生成表单；
- catalog 仍缺必填能力、成本、延迟提示与端口级文档；
- 没有 graph dry-run / mock host，设计时无法低成本验证；
- 没有 graph registry / 模板库 / 图版本管理；
- 根目录门面仍是代码，不是可视化可编辑的 Graph 项目。

### 5.10 其他

- stream join 只有 all，没有 zip / combineLatest；
- 流背压/限流未实现；
- 节点级 ToolSet 与依赖的启动前联合校验不完整；
- 结构化 plan/review 依赖自定义 JSON 解析，没有 schema 节点；
- 没有成本/用量聚合视图。

---

## 6. 未来路线

### Cycle D：Assets & Contracts（优先）

**目标**：让“角色定稿 + 参考图 + 跨格一致性”从手工接线变成可设计的资产/契约。

- **D1 ValueBundle / ReferenceSet / ProjectContext**
  - Loop/ForEach/Subgraph 支持完整值包；
  - 图级命名资产：角色、风格、场景；
  - 附件 role/label/lineage；
  - 每轮/每格自动注入共享 context。
- **D2 RunTrace / Attempt / Artifact**
  - 树形 run trace；
  - 节点/迭代/attempt 的输入、输出、审查、tool job id；
  - 候选集、best-of-N、selection；
  - 图表/面板可直接消费 trace。
- **D3 Subgraph 契约与递归校验**
  - 显式端口映射；
  - 内层 requirements 传播；
  - 递归校验、递归深度保护；
  - checkpoint graph hash / node type version；
  - graph registry / 模板引用。

### Cycle E：可靠性与长任务

- **E1 重试/降级/局部失败**
  - 节点 retry/fallback/error port；
  - ForEach 并发、限流、失败策略；
  - deadline / budget / 幂等键。
- **E2 异步 ToolJob**
  - submit → jobId → poll → artifact；
  - checkpoint 保存 jobId；
  - 进度、取消、进程重启 resume；
  - 为视频生成/长渲染准备。
- **E3 HumanGate + 持久化**
  - 图级人工选择/审批；
  - checkpoint 持久化、版本迁移、stream 重放。

### Cycle F：设计器

- `configSchema` / 端口文档 / 能力与成本提示（configSchema、默认 config、分类/关键词已完成）；
- graph dry-run + mock host/tool；
- graph 存储、版本、模板库、导入导出；
- 四格/视频流水线的可视化 trace 与候选选择面板。

---

## 7. 关键设计决策

1. **DAG + 显式 Loop**
   - 不使用任意回边；
   - 回退/重试由 Loop/Subgraph 表达，保证图可分析。
2. **JSON 只做序列化**
   - 运行时是 TS 对象与 `HarnessValue`；
   - 不把 JSON 当运行时状态机。
3. **参考图是设计层，不是模型魔法**
   - Harness 提供 `ReferenceSet` / 资产 / 注入 / 追踪；
   - 是否要求角色定稿由用户/设计者决定。
4. **单格 retry ≠ 全局一致性**
   - 跨格约束应由共享 context、全局审查、候选选择表达；
   - 未来优先补集合/选择语义，而不是继续堆控制流节点。
5. **工具副作用需要幂等/预算**
   - 生图、视频、外部写入都可能重复扣费；
   - 长任务必须有 job id、缓存、预算与补偿策略。
6. **浏览器安全核心**
   - Node-only 能力放在 `wireclaw/node` / 根目录参考实现；
   - 核心 harness 不引入 `fs` / `child_process`。

---

## 8. 验收标准（下一阶段）

- 可以用一个 Graph 表达“角色定稿 → 四格引用同一参考图 → 全局审查 → 局部重做 → 合并”；
- 每格/每轮 attempt 的输入、输出、参考图、审查结果可在 trace 中查看；
- 内层图错误在 `Graph.assertValid()` 阶段暴露；
- checkpoint 能拒绝与当前图不一致的恢复；
- 四格漫画不再依赖大量根目录自定义节点才能表达主角一致性；
- 视频类长任务可以持久化 jobId，并在进程重启后继续轮询/恢复。
