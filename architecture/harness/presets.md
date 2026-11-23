# Harness Presets

## 节点预设与依赖校验

- `NodePresetDocument` 是节点库条目，不是图内节点实例：没有图内唯一 id，带 `presetId` / 名称 / 标签 / 参数声明 / 依赖声明。
- `parameters[].path` 是 config 的点路径；实例化时按路径覆盖，未声明参数名会报错，缺失 required 参数报 `MissingParameterDependency`。
- `instantiateNodePreset()` 通过 `NodeTypeRegistry` 创建节点，并保留预设与节点类型自身的 `requirements`。
- `NodeRequirement` 支持 `tool` / `provider` / `model` / `parameter`；`RequirementCatalog` 由宿主或编辑器提供。
- 校验时机：
  1. `instantiateNodePreset(..., { available })`；
  2. `Graph.validate({ requirements })`；
  3. `GraphRun` 启动前：工具对照宿主 `ToolRegistry`，Provider 对照 `resolveProvider`，参数对照 `GraphHost.parameters`；缺失直接 fail-fast。
- `NodeDocument` 会保存 `requires`，因此预设实例化后的图 JSON 仍保留依赖声明。
- 当前 run 启动检查使用宿主全局 ToolRegistry；节点级 ToolSet 进一步排除了某个工具时，尚不会在启动前报“该节点 ToolSet 不包含依赖工具”，这一步留到后续。

## 预设序列化与 GraphEditor 目录

- `serializeNodePreset` / `deserializeNodePreset`：单个 preset 的导出与解析。
- `deserializeNodePreset` 支持 `migrations: NodePresetMigration[]`，按 `fromVersion -> toVersion` 链式迁移；无迁移、迁移结果版本错误或版本高于当前 schema 都会报错。
- `serializeNodePresetLibrary` / `deserializeNodePresetLibrary`：节点库整体导入导出，库版本为 1；重复 presetId 会拒绝。
- `createEditorCatalog(registry, { presets?, configs? })` 返回：
  - `version`
  - `nodeTypes`：类型、版本、标题、configSchema、输入/输出端口、依赖、可选的创建错误
  - `presets`：节点库条目
- `describeNodeType()` 会用 `catalog:<type>` 空实例来获取端口，因此支持“端口由 config 决定”的节点；`describeNodeTypes()` 会隔离单个坏类型，不让整个目录失败。
- 节点目录只暴露类型与契约，不执行节点；预设列表只暴露节点库条目，不持有 GraphNode 实例。


