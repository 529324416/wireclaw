/** Graph 文档 schema 版本 */
export const HARNESS_GRAPH_VERSION = 1 as const;

/** 内建节点类型 ID 预留表
 * @note Step 2 才会注册具体实现；这里先固定命名，避免序列化/编辑器命名漂移。
 */
export const HarnessBuiltinNodeType = {
    Input: "core.input",
    Output: "core.output",
    Constant: "core.constant",
    Model: "core.model",
    ModelCall: "core.model.call",
    AgentRun: "core.agent.run",
    EventTrigger: "core.eventTrigger",
    LogSink: "core.log",
} as const;
export type HarnessBuiltinNodeType =
    (typeof HarnessBuiltinNodeType)[keyof typeof HarnessBuiltinNodeType];
