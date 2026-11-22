import { HarnessBuiltinNodeType } from "../definition";
import { NodeTypeRegistry } from "../graph/registry";
import { AgentRunNode } from "./agent-run";
import { ConstantNode } from "./constant";
import { InputNode } from "./input";
import { ModelNode } from "./model";
import { ModelCallNode } from "./model-call";
import { OutputNode } from "./output";

export * from "./input";
export * from "./output";
export * from "./constant";
export * from "./model";
export * from "./model-call";
export * from "./agent-run";
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
}

/** 创建一个已装载全部内建节点的注册表 */
export function createBuiltinNodeRegistry(): NodeTypeRegistry{
    const registry = new NodeTypeRegistry();
    registerBuiltinNodes(registry);
    return registry;
}
