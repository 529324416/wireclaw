import { HarnessBuiltinNodeType } from "../definition";
import { NodeTypeRegistry } from "../graph/registry";
import { AgentRunNode } from "./agent-run";
import { BranchNode } from "./branch";
import { ChoiceNode } from "./choice";
import { ConstantNode } from "./constant";
import { EventTriggerNode } from "./event-trigger";
import { InputNode } from "./input";
import { LogSinkNode } from "./log-sink";
import { MergeNode } from "./merge";
import { ModelNode } from "./model";
import { ModelCallNode } from "./model-call";
import { OutputNode } from "./output";
import { SubgraphNode } from "./subgraph";
import { ToolSetNode } from "./tool-set";

export * from "./input";
export * from "./output";
export * from "./constant";
export * from "./model";
export * from "./model-call";
export * from "./agent-run";
export * from "./tool-set";
export * from "./choice";
export * from "./branch";
export * from "./merge";
export * from "./subgraph";
export * from "./event-trigger";
export * from "./log-sink";
export * from "./helpers";

/** 注册 Step 2 的内建节点 */
export function registerBuiltinNodes(registry: NodeTypeRegistry): void{
    registry.register({
        type: HarnessBuiltinNodeType.Input,
        version: 1,
        title: "Input",
        description: "读取本次 GraphRun 的 text / attachments",
        builtIn: true,
        create: (id, config, inputs, ui) => new InputNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.Output,
        version: 1,
        title: "Output",
        description: "Graph 的最终输出汇点",
        builtIn: true,
        create: (id, config, inputs, ui) => new OutputNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.Constant,
        version: 1,
        title: "Constant",
        description: "输出一个固定的 HarnessValue",
        builtIn: true,
        create: (id, config, inputs, ui) => new ConstantNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.Model,
        version: 1,
        title: "Model",
        description: "声明 providerId + modelId 的模型绑定",
        builtIn: true,
        create: (id, config, inputs, ui) => new ModelNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.ModelCall,
        version: 1,
        title: "Model Call",
        description: "A 类单次模型调用（chat / generate）",
        builtIn: true,
        create: (id, config, inputs, ui) => new ModelCallNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.AgentRun,
        version: 1,
        title: "Agent Run",
        description: "B 类 Session/AgentLoop 调用",
        builtIn: true,
        create: (id, config, inputs, ui) => new AgentRunNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.ToolSet,
        version: 1,
        title: "ToolSet",
        description: "声明当前节点可访问的工具范围",
        builtIn: true,
        create: (id, config, inputs, ui) => new ToolSetNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.Choice,
        version: 1,
        title: "Choice",
        description: "按 boolean 条件选择 whenTrue / whenFalse 的值",
        builtIn: true,
        create: (id, config, inputs, ui) => new ChoiceNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.Branch,
        version: 1,
        title: "Branch",
        description: "按 boolean 条件只激活一条分支，未命中分支 skipped",
        builtIn: true,
        create: (id, config, inputs, ui) => new BranchNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.Merge,
        version: 1,
        title: "Merge",
        description: "汇合 BranchNode 的可选分支输出",
        builtIn: true,
        create: (id, config, inputs, ui) => new MergeNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.Subgraph,
        version: 1,
        title: "Subgraph",
        description: "把一张内嵌 Graph 作为节点执行",
        builtIn: true,
        create: (id, config, inputs, ui) => new SubgraphNode(registry, id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.EventTrigger,
        version: 1,
        title: "Event Trigger",
        description: "把 stream 输入发布为 Graph custom 事件",
        builtIn: true,
        create: (id, config, inputs, ui) => new EventTriggerNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.LogSink,
        version: 1,
        title: "Log Sink",
        description: "把 text stream 写入宿主日志",
        builtIn: true,
        create: (id, config, inputs, ui) => new LogSinkNode(id, config, inputs, ui),
    });
}

/** 创建一个已装载全部内建节点的注册表 */
export function createBuiltinNodeRegistry(): NodeTypeRegistry{
    const registry = new NodeTypeRegistry();
    registerBuiltinNodes(registry);
    return registry;
}
