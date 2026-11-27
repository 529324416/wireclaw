/** Graph 文档 schema 版本 */
export const HARNESS_GRAPH_VERSION = 1 as const;

/** 内建节点类型 ID 预留表
 * @note Step 2 才会注册具体实现；这里先固定命名，避免序列化/编辑器命名漂移。
 */
export const HarnessBuiltinNodeType = {
    Input: "core.input",
    Output: "core.output",
    Constant: "core.constant",
    Value: "core.value",
    Model: "core.model",
    Provider: "core.provider",
    ModelCall: "core.model.call",
    AgentRun: "core.agent.run",
    ToolSet: "core.toolset",
    Choice: "core.choice",
    ForEach: "core.forEach",
    Loop: "core.loop",
    Branch: "core.branch",
    /** 过滤 / 汇合两路可选分支，输出其中一路。 */
    Filter: "core.filter",
    /** 把两个文本输入按顺序合并为一个文本。 */
    Combine: "core.combine",
    /** 按 keyword 把 raw_text 中的文本替换为 replacement。 */
    Replace: "core.replace",
    /**
     * @deprecated 旧 Merge 节点；行为等同 Filter，仅为旧图 / 旧 run 保留。
     * 新图请使用 Filter（core.filter）。
     */
    Merge: "core.merge",
    Subgraph: "core.subgraph",
    EventTrigger: "core.eventTrigger",
    LogSink: "core.log",
} as const;
export type HarnessBuiltinNodeType =
    (typeof HarnessBuiltinNodeType)[keyof typeof HarnessBuiltinNodeType];
