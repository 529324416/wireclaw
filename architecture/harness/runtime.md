# Harness Runtime

## 对象模型与调度

当前状态：Graph 对象模型、校验（含内嵌图递归校验）、JSON 序列化、运行时、ToolSet、流式端口、EventTrigger、节点预设、依赖校验、预设导入导出/迁移、GraphEditor 节点目录、调度级分支、隐式 exclusive join、fan-in、SubgraphNode、ForEach / Loop、暂停/恢复与 checkpoint、`RunResult` 运行结果聚合，以及内建 input / output / constant / value / model / model.call / agent.run / toolset / choice / branch / merge / subgraph / foreach / loop / eventTrigger / log 节点已实现。

```text
src/harness/
  index.ts            公共入口
  definition.ts       Graph 文档版本与内建节点类型 ID 预留表
  base/               HarnessError / HarnessIssue、内部 JSON 工具
  graph/
    type.ts           JsonValue / HarnessValue / 端口 / ModelBinding / ToolSetSpec
    node.ts           GraphNode、NodeContext 契约
    edge.ts           Edge / PortAddress
    registry.ts       NodeTypeRegistry（宿主注册自定义节点）
    event.ts          GraphEvent / GraphEventListener（运行时事件契约）
    graph.ts          Graph：validate / assertValid / toJSON / fromJSON
  runtime/
    types.ts          GraphHost / GraphRunOptions / GraphRunResult / NodeRunRecord / RunResult
    run-result.ts     RunResultCollector / createRunResult / RunResultSerializer
    runner.ts         GraphRun、调度器、取消、生命周期事件
    channel.ts        OutputChannel（无界缓冲 + async iterator）
    tool-set.ts       ToolSet（ToolSource 过滤/收窄/host 工具策略）
  serialize/
    document.ts       GraphDocument / NodeDocument
    serializer.ts     serializeGraph / deserializeGraph
    plugin.ts         序列化插件接口（占位，供版本迁移/私有字段使用）
  preset/
    type.ts           NodePresetDocument / NodePresetParameter
    validate.ts       preset 解析、参数路径覆盖
    instantiate.ts    instantiateNodePreset
    library.ts        NodePresetLibrary
    serialize.ts      预设/节点库导入导出与版本迁移
  editor/
    catalog.ts        GraphEditor 节点目录契约
  node/               内建节点：input / output / constant / value / model / model.call / agent.run / toolset / choice / branch / merge / subgraph / foreach / loop / eventTrigger / log
```

核心设计：

- **TS 优先**：Node、Edge、Graph 是运行时对象；JSON 只用于持久化、导出和编辑器交换。
- **端口与值**：端口声明 `PortValueType`（text/json/model/toolset/attachment/attachments/any）；值统一为 `HarnessValue`；媒体只保存 `AttachmentRef.contentHash`。
- **Value / Stream**：输出端口用 `supportedModes` / `defaultMode` 声明，输入端口用 `mode: "stream"` 声明；节点 `execute` 的 stream 输出通过 `ctx.emit` 推送、value 输出通过返回值。当前 A/B 仍返回最终值，同时推送 token 流；后续可把默认展示切换为纯流式而不改 Graph/Edge 结构。
- **自定义节点**：宿主用 `NodeTypeRegistry.register({ type, version, create, configSchema? })` 注册；JSON 只保存 `type + typeVersion + config + inputs + ui`，不携带可执行代码；未知类型或版本不匹配会拒绝反序列化。
- **校验**：节点 ID/端口唯一、边两端节点与端口存在、端口类型兼容、必填输入（边或默认值）、单输入端口默认 exclusive join（允许多边；`join: "error"` 显式拒绝多边；`multiple: true` 聚合）、重复边、环、图级参数/事件声明；`Subgraph` / `Loop` / `ForEach` 的 `config.graph` 递归校验（深度上限 8），内层问题回填容器 `nodeId` 与 `graphPath` / `nestedNodeId`，requirements catalog 一并下传到内层。
- **requirements 传播**：`GraphNode.collectRequirements()` 汇总节点自身与内嵌子图的依赖；容器节点的内层 provider / model / tool / parameter 会在 run 预检与编辑器目录中显现，序列化仍只写节点自身 `requires`，不把内层依赖复制进文档。
- **GraphDocument**：`version: 1`；显式 `nodes` 与 `edges`；节点 config/inputs/ui 必须是 JSON-safe；`ui` 仅服务设计器，运行时忽略。
- **反序列化**：`Graph.fromJSON(doc, { registry })` 默认执行完整校验；编辑器可用 `{ validate: false }` 载入未完成草稿。
- **序列化插件**：`HarnessSerializationPlugin` 预留节点迁移、私有字段编解码和第三方节点包接入点；当前内置逻辑只依赖 NodeTypeRegistry。
- **运行入口**：`graph.run({ host, input, listener, signal, maxConcurrency })` 返回 `GraphRun`；`run.done` 解析 `GraphRunResult`，并支持 `cancel()` / `onEvent()`。
- **RunResult**：`GraphRunResult` 携带 `graphId` / `entries`；`createRunResult(result, input?)` 生成版本化、JSON-safe 的 `RunResult` v1。`NodeContext.collect` 供 ModelCall / AgentRun 提交条目（模型调用与 Agent `SessionData`），运行时补齐 `id / nodeId / nodeType / graphPath`；`Subgraph / Loop / ForEach` 共享 collector 并让路径冒泡。`RunResultSerializer` 负责序列化与 JSON 校验，保留 partial 结果不写 checkpoint。
- **调度器**：value-first DAG；依赖满足的节点并行执行（默认并发 4）；节点失败 fail-fast 并中止活跃节点；取消通过 AbortSignal 传播；每个节点写入 `NodeRunRecord`。
- **GraphHost**：宿主注入 `resolveProvider`、`tools`、`attachments`、`onToolApproval`、`onUserInput`、`log`；Graph JSON 只保存 providerId / modelId，不保存 Provider 实例或密钥。
- **内建节点**：`core.input` / `core.output` / `core.constant` / `core.value` / `core.model` / `core.model.call`（A，chat/generate）/ `core.agent.run`（B）/ `core.toolset` / `core.choice` / `core.branch` / `core.merge` / `core.subgraph` / `core.foreach` / `core.loop` / `core.eventTrigger` / `core.log`。
- **A 节点**：复用一次性 Session 调用现有附件解析与模型门禁（`maxSteps: 1`、host 工具关闭）；chat 模式把 `ASSISTANT_TOKEN` 转发为 `text` / `thinking` 流；generate 模式走 `GenerationCapability` 并落盘附件。
- **B 节点**：复用 Session/AgentLoop，注入权限、`maxSteps` 与 `ToolSet`；审批与 `host__ask_user` 通过 `GraphHost` 回调桥接；默认不注册 host 内置工具。
- **A/B 数据端口与本地回退（2026-11-27）**：`core.model.call` 新增 `system` / `parameters` 输入，`core.agent.run` 新增 `system` / `hostTools` 输入；`model` / `prompt` / `input` 的 `required` 移除。端口连接时覆盖同名 config 字段（`system` / `parameters` / `hostTools`），未连接时回退 config（`providerId` / `modelId` / `prompt` / `input` / `attachments` / `toolset`）；缺值在节点执行期报 `InvalidNode`，不再在解析期抛 `MissingInput`。
- **ToolSet**：`Graph.toolSet` 是默认上限，`core.toolset` 节点产生节点级 spec，B 节点的 `toolset` 输入在 Graph 级之上进一步收窄；`ToolSet` 实现 `ToolSource`，不修改 Session。host 工具策略按 AND 合并。
- **流式**：输入端口可声明 `mode: "stream"`；A/B 的 `text` / `thinking` 输出支持 value + stream；运行时用 `OutputChannel` 缓冲并按端口推送。`core.eventTrigger` 把流逐块发布为 `custom` 事件，`core.log` 写入宿主日志。流消费者与上游并发执行，图完成时等待流关闭。
- **ChoiceNode**：`core.choice` 是值选择，`whenTrue` / `whenFalse` 两条上游都会执行。
- **Branch / 隐式 Join**：`core.branch` 接收 `value` + `condition`，只在 `true` / `false` 其中一个端口产出；另一个端口及下游被标记为 `skipped`。两个输出共享 `exclusiveGroup` 标签。单值输入收到多个 value 上游时默认执行 `exclusive` join：恰好一个值则通过，多个值报 `AmbiguousJoin`，全部 skipped 则节点 skipped。普通分支汇合不再必须手动 MergeNode。
- **显式 MergeNode（保留 / 实验）**：`core.merge` 仍可作为可见汇合点或自定义选择策略使用；它是否应作为默认推荐，等 GraphEditor 阶段用 `tools/merge-future-check.mjs` 预留脚本验证。
- **Join 策略**：输入端口支持 `join: "exclusive" | "all" | "error"`。`all` 需要 `multiple: true`（value 聚合为 JSON 数组，stream 汇合所有通道）；`error` 在设计期拒绝多边；默认单值输入为 `exclusive`，并以运行时歧义错误兜底。当前只实现了 `exclusive` / `all` 的运行语义。
- **B3 序列化与校验**：Branch / Merge 作为普通节点类型随 Graph JSON 往返；单输入多来源在默认 exclusive 下是合法图；`join` / `multiple` 的矛盾组合在 `Graph.validate()` 阶段报错；并发来源在运行时以 `AmbiguousJoin` 失败，不静默丢值。
- **SubgraphNode（C1）**：`core.subgraph` 的 config 内嵌一个 `GraphDocument`；外层 `input` / `attachments` 映射到内层 `core.input`，内层 `core.output` 的 `text` / `attachments` / `json` 映射回外层。内层与外层共用同一个 `NodeTypeRegistry`、Provider/Tool/Attachment 服务和运行参数；内层 `custom` 事件以 `subgraph.<nodeId>.<event>` 转发，`node:skipped` 以 `subgraph.<nodeId>.node:skipped` 转发。内层图非法时会在 run 启动前的 `assertValid()` 中以 `InvalidGraph` 失败，issues 带 `graphPath`；若运行中被绕过校验，节点仍以 `InvalidNode` 包装失败。
- **core.value**：从 `GraphRunInput.values` 读取命名值，供子图、ForEach、Loop 和宿主参数复用；`required` 默认 true。
- **ForEachNode（C2）**：输入 `items` JSON 数组，逐项运行内嵌子图；内层通过 `core.value` 读取 `item` / `iteration`。按顺序收集 `resultPort`（默认 text）到 `results` JSON 数组，并输出 `count` 与聚合后的 `attachments`；每轮发出 `forEach.<nodeId>.iteration` 事件；当前串行执行，支持外层取消。
- **LoopNode（C2/C3）**：输入 `initial`，按 `config.maxIterations` 有界运行内嵌子图；内层通过 `core.value` 读取 `state` / `iteration`，`core.output.json` 约定为 `{ state, done? }`，`done === true` 提前结束。输出最终 `value`、`iterations`，以及最后一轮内层 `attachments`；每轮发出 `loop.<nodeId>.iteration` 事件。`retryOnError: true` 时，内层运行失败也会消耗一轮重试；当前状态只支持 JSON，串行执行。
- **暂停 / 恢复 / checkpoint（C3）**：`GraphRun.pause()` 停止调度新节点、等待当前活跃节点收尾，返回可 JSON 序列化的 `GraphCheckpoint`；`run.resume()` 在同一 run 继续，`Graph.resume(checkpoint, { host })` 从快照创建新 run。checkpoint v2 保存 graphHash、nodeVersions、已完成输出、运行记录、edge 状态、pending 与 ready 列表，因此恢复时不会重跑已完成节点。暂停/恢复发出 `run:paused` / `run:resumed` 事件；`graphId`、可执行图 hash 或节点类型版本不匹配，或结构非法时报 `InvalidCheckpoint`。
- **Fan-in**：`multiple` value 输入必须声明为 `json` / `any`，运行时把所有非 skipped 上游聚合为 JSON 数组；`multiple` stream 输入按 `join: "all"` 汇合多个通道。
- **Skipped 传播**：调度器按 value 边逐一记录 `value` / `skipped`；required 输入来自 skipped 分支或全部 connected 输入都 skipped 时，节点 skipped；`node:skipped` 事件与记录状态可被 UI 展示。
- **事件**：run/node 生命周期事件自动发出；`ctx.emit` 推流，`ctx.publish` 发 `custom` 事件；外部通过 `Graph.run({ listener })` 消费。


