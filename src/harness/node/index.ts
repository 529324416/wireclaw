import { HarnessBuiltinNodeType } from "../definition";
import { NodeTypeRegistry } from "../graph/registry";
import type { JsonObject } from "../graph/type";
import { AgentRunNode } from "./agent-run";
import { BranchNode } from "./branch";
import { ChoiceNode } from "./choice";
import { CombineNode } from "./combine";
import { ConstantNode } from "./constant";
import { EventTriggerNode } from "./event-trigger";
import { FilterNode } from "./filter";
import { ForEachNode } from "./foreach";
import { InputNode } from "./input";
import { LogSinkNode } from "./log-sink";
import { LoopNode } from "./loop";
import { MergeNode } from "./merge";
import { ModelNode } from "./model";
import { ModelCallNode } from "./model-call";
import { OutputNode } from "./output";
import { ProviderNode } from "./provider";
import { SubgraphNode } from "./subgraph";
import { ToolSetNode } from "./tool-set";
import { ValueNode } from "./value";

export * from "./input";
export * from "./output";
export * from "./constant";
export * from "./model";
export * from "./model-call";
export * from "./provider";
export * from "./agent-run";
export * from "./tool-set";
export * from "./choice";
export * from "./branch";
export * from "./filter";
export * from "./combine";
export * from "./merge";
export * from "./subgraph";
export * from "./value";
export * from "./foreach";
export * from "./loop";
export * from "./event-trigger";
export * from "./log-sink";
export * from "./helpers";

/**
 * 内嵌子图的最小可运行模板（Input → Output）。
 *
 * 每个 Subgraph / ForEach / Loop 拿到独立副本，避免共享引用被编辑器就地修改。
 */
function embeddedGraphTemplate(): JsonObject{
    return {
        version: 1,
        id: "embedded",
        title: "内嵌子图",
        nodes: [
            {
                id: "input",
                type: HarnessBuiltinNodeType.Input,
                typeVersion: 1,
                ui: { x: 0, y: 0 },
            },
            {
                id: "output",
                type: HarnessBuiltinNodeType.Output,
                typeVersion: 1,
                ui: { x: 320, y: 0 },
            },
        ],
        edges: [
            {
                from: { nodeId: "input", port: "text" },
                to: { nodeId: "output", port: "text" },
            },
        ],
    };
}

const GRAPH_SCHEMA: JsonObject = {
    title: "内嵌子图",
    description: "GraphDocument JSON；编辑内嵌图暂用原始 JSON",
    type: "object",
    format: "graph",
};

/** 注册 Step 2 的内建节点 */
export function registerBuiltinNodes(registry: NodeTypeRegistry): void{
    registry.register({
        type: HarnessBuiltinNodeType.Input,
        version: 1,
        title: "Input",
        description: "读取本次 GraphRun 的 text / attachments",
        builtIn: true,
        category: "io",
        keywords: ["input", "入口", "输入", "run input"],
        create: (id, config, inputs, ui) => new InputNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.Output,
        version: 1,
        title: "Output",
        description: "Graph 的最终输出汇点",
        builtIn: true,
        category: "io",
        keywords: ["output", "出口", "输出", "result"],
        create: (id, config, inputs, ui) => new OutputNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.Constant,
        version: 1,
        title: "Constant",
        description: "输出一个固定的 HarnessValue",
        builtIn: true,
        category: "data",
        keywords: ["constant", "value", "常量", "固定值"],
        configSchema: {
            type: "object",
            properties: {
                value: {
                    title: "值",
                    description: "HarnessValue，例如 { type: \"text\", text: \"hello\" }",
                    type: "object",
                    format: "json",
                },
            },
            required: ["value"],
        },
        defaultConfig: { value: { type: "text", text: "" } },
        create: (id, config, inputs, ui) => new ConstantNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.Provider,
        version: 1,
        title: "Provider",
        description: "声明 Provider Profile；输出可连到 Model 的 provider 输入",
        builtIn: true,
        category: "model",
        keywords: ["provider", "模型服务", "密钥", "连接"],
        configSchema: {
            type: "object",
            properties: {
                providerId: {
                    title: "Provider ID",
                    type: "string",
                    description: "Provider Profile id；由宿主的 Provider 库提供",
                },
            },
            required: ["providerId"],
        },
        defaultConfig: { providerId: "" },
        create: (id, config, inputs, ui) => new ProviderNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.Model,
        version: 1,
        title: "Model",
        description: "声明 providerId + modelId 的模型绑定",
        builtIn: true,
        category: "model",
        keywords: ["model", "模型", "绑定", "provider"],
        configSchema: {
            type: "object",
            properties: {
                providerId: {
                    title: "Provider ID",
                    type: "string",
                    description: "未连接 Provider 节点时使用；连接后以连接为准",
                },
                modelId: {
                    title: "Model ID",
                    type: "string",
                    description: "如 deepseek-chat",
                },
            },
            required: ["modelId"],
        },
        defaultConfig: { providerId: "", modelId: "" },
        create: (id, config, inputs, ui) => new ModelNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.ModelCall,
        version: 1,
        title: "Model Call",
        description: "A 类单次模型调用（chat / generate）",
        builtIn: true,
        category: "model",
        keywords: ["model call", "chat", "generate", "模型调用", "对话", "生成"],
        configSchema: {
            type: "object",
            properties: {
                providerId: {
                    title: "Provider ID",
                    type: "string",
                    description: "未连接 Model 节点时使用；连接后以连接为准",
                },
                modelId: {
                    title: "Model ID",
                    type: "string",
                    description: "未连接 Model 节点时使用；连接后以连接为准",
                },
                prompt: {
                    title: "Prompt",
                    type: "string",
                    description: "未连接 prompt 输入时使用",
                },
                mode: {
                    title: "模式",
                    type: "string",
                    enum: ["chat", "generate"],
                    enumLabels: ["对话", "生成"],
                    default: "chat",
                },
                system: { title: "System Prompt", type: "string" },
                temperature: {
                    title: "Temperature",
                    type: "number",
                    minimum: 0,
                    maximum: 2,
                },
                think: { title: "启用思考", type: "boolean" },
                thinkingLv: {
                    title: "思考强度",
                    type: ["string", "number"],
                    description: "字符串或数字，由 Provider 解释",
                },
                modality: {
                    title: "生成模态",
                    type: "string",
                    enum: ["image", "audio", "video"],
                    enumLabels: ["图像", "音频", "视频"],
                    default: "image",
                },
                parameters: {
                    title: "生成参数",
                    type: "object",
                    format: "json",
                    description: "透传给 Provider.generate 的任意对象",
                },
                attachments: {
                    title: "附件引用",
                    type: "array",
                    items: { type: "object" },
                    description: "未连接 attachments 输入时使用；数组项为 { contentHash }",
                },
            },
        },
        defaultConfig: { mode: "chat" },
        create: (id, config, inputs, ui) => new ModelCallNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.AgentRun,
        version: 1,
        title: "Agent Run",
        description: "B 类 Session/AgentLoop 调用",
        builtIn: true,
        category: "model",
        keywords: ["agent", "agent run", "代理", "工具循环", "session"],
        configSchema: {
            type: "object",
            properties: {
                providerId: {
                    title: "Provider ID",
                    type: "string",
                    description: "未连接 Model 节点时使用；连接后以连接为准",
                },
                modelId: {
                    title: "Model ID",
                    type: "string",
                    description: "未连接 Model 节点时使用；连接后以连接为准",
                },
                input: {
                    title: "输入",
                    type: "string",
                    description: "未连接 input 输入时使用",
                },
                permission: {
                    title: "权限",
                    type: "string",
                    enum: ["readonly", "approval", "full"],
                    enumLabels: ["只读", "需审批", "完全"],
                    default: "readonly",
                },
                maxSteps: {
                    title: "最大步数",
                    type: "integer",
                    minimum: 1,
                    default: 8,
                },
                system: { title: "System Prompt", type: "string" },
                temperature: {
                    title: "Temperature",
                    type: "number",
                    minimum: 0,
                    maximum: 2,
                },
                think: { title: "启用思考", type: "boolean" },
                thinkingLv: { title: "思考强度", type: ["string", "number"] },
                toolset: {
                    title: "工具范围",
                    type: "object",
                    format: "json",
                    description: "未连接 toolset 输入时使用；{ include, exclude, hostTools }",
                },
                hostTools: {
                    title: "宿主工具",
                    format: "json",
                    description: "boolean，或 { askUser, viewMedia }",
                },
                attachments: {
                    title: "附件引用",
                    type: "array",
                    items: { type: "object" },
                    description: "未连接 attachments 输入时使用；数组项为 { contentHash }",
                },
            },
        },
        defaultConfig: { permission: "readonly", maxSteps: 8 },
        create: (id, config, inputs, ui) => new AgentRunNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.ToolSet,
        version: 1,
        title: "ToolSet",
        description: "声明当前节点可访问的工具范围",
        builtIn: true,
        category: "tool",
        keywords: ["toolset", "tools", "工具", "工具集", "allowlist"],
        configSchema: {
            type: "object",
            properties: {
                include: {
                    title: "包含工具",
                    type: "array",
                    items: { type: "string" },
                    description: "留空表示不限制",
                },
                exclude: {
                    title: "排除工具",
                    type: "array",
                    items: { type: "string" },
                },
                hostTools: {
                    title: "宿主工具",
                    format: "json",
                    description: "{ askUser, viewMedia }",
                },
            },
        },
        defaultConfig: { include: [] },
        create: (id, config, inputs, ui) => new ToolSetNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.Choice,
        version: 1,
        title: "Choice",
        description: "按 boolean 条件选择 whenTrue / whenFalse 的值",
        builtIn: true,
        category: "control",
        keywords: ["choice", "条件", "三目", "选择"],
        create: (id, config, inputs, ui) => new ChoiceNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.Branch,
        version: 1,
        title: "Branch",
        description: "按 boolean 条件只激活一条分支，未命中分支 skipped",
        builtIn: true,
        category: "control",
        keywords: ["branch", "分支", "条件"],
        create: (id, config, inputs, ui) => new BranchNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.Filter,
        version: 1,
        title: "Filter",
        description: "从两路可选分支中过滤出一路值（有 a 取 a，否则 b）",
        builtIn: true,
        category: "control",
        keywords: ["filter", "过滤", "汇合", "分支", "merge"],
        create: (id, config, inputs, ui) => new FilterNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.Combine,
        version: 1,
        title: "Combine",
        description: "把两个文本输入按顺序合并为一个文本",
        builtIn: true,
        category: "data",
        keywords: ["combine", "merge", "合并", "拼接", "文本", "join"],
        configSchema: {
            type: "object",
            properties: {
                separator: {
                    title: "分隔符",
                    type: "string",
                    description: "两段文本之间的分隔符；默认空串",
                },
            },
        },
        defaultConfig: { separator: "" },
        create: (id, config, inputs, ui) => new CombineNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.Merge,
        version: 1,
        title: "Filter（旧 Merge）",
        description: "旧 Merge 节点，行为等同 Filter，仅用于旧图 / 旧 run 兼容",
        builtIn: true,
        category: "control",
        keywords: ["merge", "legacy", "旧"],
        create: (id, config, inputs, ui) => new MergeNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.Subgraph,
        version: 1,
        title: "Subgraph",
        description: "把一张内嵌 Graph 作为节点执行",
        builtIn: true,
        category: "composite",
        keywords: ["subgraph", "子图", "内嵌图", "复用"],
        configSchema: {
            type: "object",
            properties: { graph: GRAPH_SCHEMA },
            required: ["graph"],
        },
        defaultConfig: { graph: embeddedGraphTemplate() },
        create: (id, config, inputs, ui) => new SubgraphNode(registry, id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.Value,
        version: 1,
        title: "Value",
        description: "从 GraphRunInput.values 读取命名值",
        builtIn: true,
        category: "data",
        keywords: ["value", "参数", "命名值", "input value"],
        configSchema: {
            type: "object",
            properties: {
                name: { title: "参数名", type: "string", minLength: 1 },
                required: {
                    title: "必填",
                    type: "boolean",
                    default: true,
                },
            },
            required: ["name"],
        },
        defaultConfig: { name: "value", required: true },
        create: (id, config, inputs, ui) => new ValueNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.ForEach,
        version: 1,
        title: "ForEach",
        description: "对 JSON 数组逐项运行内嵌子图",
        builtIn: true,
        category: "composite",
        keywords: ["foreach", "遍历", "批量", "数组"],
        configSchema: {
            type: "object",
            properties: {
                graph: GRAPH_SCHEMA,
                resultPort: {
                    title: "结果端口",
                    type: "string",
                    default: "text",
                    description: "内嵌图输出到 results 的端口名",
                },
            },
            required: ["graph"],
        },
        defaultConfig: { graph: embeddedGraphTemplate(), resultPort: "text" },
        create: (id, config, inputs, ui) => new ForEachNode(registry, id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.Loop,
        version: 1,
        title: "Loop",
        description: "按 maxIterations 有界运行内嵌子图",
        builtIn: true,
        category: "composite",
        keywords: ["loop", "循环", "迭代", "重试"],
        configSchema: {
            type: "object",
            properties: {
                graph: GRAPH_SCHEMA,
                maxIterations: {
                    title: "最大迭代",
                    type: "integer",
                    minimum: 1,
                    default: 3,
                },
                retryOnError: {
                    title: "失败重试",
                    type: "boolean",
                    default: false,
                },
            },
            required: ["graph", "maxIterations"],
        },
        defaultConfig: {
            graph: embeddedGraphTemplate(),
            maxIterations: 3,
            retryOnError: false,
        },
        create: (id, config, inputs, ui) => new LoopNode(registry, id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.EventTrigger,
        version: 1,
        title: "Event Trigger",
        description: "把 stream 输入发布为 Graph custom 事件",
        builtIn: true,
        category: "event",
        keywords: ["event", "trigger", "事件", "触发", "stream"],
        configSchema: {
            type: "object",
            properties: {
                event: { title: "事件名", type: "string", minLength: 1 },
            },
            required: ["event"],
        },
        defaultConfig: { event: "progress" },
        create: (id, config, inputs, ui) => new EventTriggerNode(id, config, inputs, ui),
    });
    registry.register({
        type: HarnessBuiltinNodeType.LogSink,
        version: 1,
        title: "Log Sink",
        description: "把 text stream 写入宿主日志",
        builtIn: true,
        category: "event",
        keywords: ["log", "日志", "输出", "stream"],
        configSchema: {
            type: "object",
            properties: {
                level: {
                    title: "级别",
                    type: "string",
                    enum: ["debug", "info", "warn", "error"],
                    enumLabels: ["debug", "info", "warn", "error"],
                    default: "info",
                },
            },
        },
        defaultConfig: { level: "info" },
        create: (id, config, inputs, ui) => new LogSinkNode(id, config, inputs, ui),
    });
}

/** 创建一个已装载全部内建节点的注册表 */
export function createBuiltinNodeRegistry(): NodeTypeRegistry{
    const registry = new NodeTypeRegistry();
    registerBuiltinNodes(registry);
    return registry;
}
