import type { AttachmentFileManager } from "../../session/attachment-manager";
import type { AIProvider } from "../../session/protocol";
import type { ToolRegistry } from "../../session/tool";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../session/session";
import type { UserInputRequest, UserInputResult } from "../../session/type";
import type { RunResultCollector, RunResultEntryDraft } from "../runtime/types";
import type { Graph } from "./graph";
import type {
    HarnessInput,
    HarnessValue,
    InputPortSpec,
    JsonObject,
    JsonValue,
    ModelBinding,
    NodeInputValues,
    NodeOutputValues,
    NodeRequirement,
    OutputPortSpec,
    ToolSetSpec,
} from "./type";

export type MaybePromise<T> = T | Promise<T>;

/** requirements 递归收集的最大深度，与内嵌图校验上限一致 */
const MAX_REQUIREMENT_DEPTH = 8;

/**
 * 节点内嵌的子图。
 *
 * `Subgraph / Loop / ForEach` 等容器节点覆盖 `GraphNode.embeddedGraphs`，
 * 让 `Graph.validate()` 能递归校验内层图，并把问题定位回容器节点。
 */
export type EmbeddedGraph = {
    /** 相对父节点的路径片段，例如 `subgraph.<nodeId>` / `loop.<nodeId>` */
    path: string;
    /** 原始 GraphDocument；解析失败时用于错误信息 */
    document: unknown;
    /** 解析成功的内层图 */
    graph?: Graph;
    /** 解析失败原因 */
    error?: unknown;
};

/** 运行时注入给节点的宿主服务；节点不直接持有 Provider 实例的构造信息 */
export interface NodeServices{

    /** 按 providerId 查找宿主已构造的 Provider */
    resolveProvider(providerId: string): AIProvider | undefined;

    /** 解析模型绑定；Provider 不存在时抛出 HarnessError */
    resolveModel(binding: ModelBinding): AIProvider;

    /** 附件仓库；A/B 节点用于解析 media */
    readonly attachments?: AttachmentFileManager;

    /** B 节点可访问的工具注册表 */
    readonly tools?: ToolRegistry;

    /** Graph 级默认 ToolSet；节点级 ToolSet 只能在此基础上收窄 */
    readonly defaultToolSet?: ToolSetSpec;

    /** 宿主运行参数；子图会原样传递 */
    readonly parameters?: Readonly<Record<string, unknown>>;

    /** B 节点审批回调；未提供时遇到审批会失败 */
    readonly onToolApproval?: (
        request: ToolApprovalRequest,
    ) => MaybePromise<ToolApprovalDecision>;

    /** B 节点人工输入回调；未提供时遇到 host__ask_user 会失败 */
    readonly onUserInput?: (
        request: UserInputRequest,
    ) => MaybePromise<UserInputResult>;
}

/**
 * 节点执行上下文。
 *
 * @note Step 2 提供 provider / attachment / tool / 审批桥接；
 *       stream 输出通过 emit 预留给后续流式运行时。
 */
export interface NodeContext{

    /** 本次 GraphRun 的 ID */
    readonly runId: string;

    /** 取消信号 */
    readonly signal: AbortSignal;

    /** 节点实例的静态配置 */
    readonly config: JsonValue | undefined;

    /** 本次 GraphRun 的输入 */
    readonly input: HarnessInput;

    /** 宿主注入的服务 */
    readonly services: NodeServices;

    /** 运行时日志；设计器/宿主可以订阅 */
    log(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): void;

    /** 订阅一个 stream 输入端口；无上游或可选输入时返回空序列 */
    stream(port: string): AsyncIterable<HarnessValue>;

    /** 向 stream 输出端口写入增量；value 模式下由运行时决定是否忽略 */
    emit(port: string, chunk: HarnessValue): void;

    /** EventTrigger 等节点向宿主发布自定义事件 */
    publish(event: string, payload: JsonValue): void;

    /**
     * @internal 提交一条运行结果条目（模型调用 / Agent 会话）。
     *
     * `id` / `nodeId` / `nodeType` / `graphPath` 由运行时补齐，节点只负责提供内容。
     */
    collect(entry: RunResultEntryDraft): void;

    /** @internal 当前内嵌图路径；顶层图为空数组 */
    readonly graphPath: readonly string[];

    /** @internal 嵌套运行共享的结果采集器；由 GraphRun 注入 */
    readonly resultCollector?: RunResultCollector;
}

/**
 * Graph 节点基类。
 *
 * - 节点是定义，不是运行状态；同一个 Graph 可以被多次运行；
 * - `execute` 返回 value 输出，stream 输出通过 `ctx.emit`；
 * - 自定义节点由宿主继承并注册到 NodeTypeRegistry，JSON 中只保存 type/config。
 */
export abstract class GraphNode{

    private _requirements: readonly NodeRequirement[] = [];

    constructor(
        readonly id: string,
        readonly config: JsonValue | undefined = undefined,
        readonly inputDefaults: NodeInputValues = {},
        readonly ui: JsonObject | undefined = undefined,
    ){}

    /** 节点声明的外部依赖；由 NodeTypeDefinition、预设或反序列化写入 */
    get requirements(): readonly NodeRequirement[]{
        return this._requirements;
    }

    /** 由 Registry / 预设实例化写入；业务代码通常不需要调用 */
    setRequirements(requirements: readonly NodeRequirement[]): void{
        this._requirements = [...requirements];
    }

    /**
     * 节点自身 + 内嵌子图声明的全部依赖。
     *
     * 容器节点（Subgraph / Loop / ForEach）据此把内层 requirements 传播到
     * 外层预检与编辑器目录；序列化仍只写 `requirements`（自身声明），
     * 不把内层依赖复制进文档。
     */
    collectRequirements(depth = 0): readonly NodeRequirement[]{
        const own = this.requirements;
        if (depth >= MAX_REQUIREMENT_DEPTH) return [...own];

        const nested: NodeRequirement[] = [];
        for (const embedded of this.embeddedGraphs){
            if (embedded.graph === undefined) continue;
            for (const node of embedded.graph.nodes){
                nested.push(...node.collectRequirements(depth + 1));
            }
        }

        return uniqueRequirements([...own, ...nested]);
    }

    /** 内嵌子图；`Subgraph / Loop / ForEach` 覆盖。默认没有内嵌图。 */
    get embeddedGraphs(): readonly EmbeddedGraph[]{
        return [];
    }

    /** 节点类型 ID，例如 core.model.call */
    abstract readonly type: string;

    /** 节点类型版本；与 NodeTypeDefinition.version 一致 */
    get typeVersion(): number{
        return 1;
    }

    abstract get inputs(): readonly InputPortSpec[];

    abstract get outputs(): readonly OutputPortSpec[];

    abstract execute(ctx: NodeContext, inputs: NodeInputValues): Promise<NodeOutputValues>;
}

function uniqueRequirements(
    requirements: readonly NodeRequirement[],
): readonly NodeRequirement[]{
    const seen = new Set<string>();
    const unique: NodeRequirement[] = [];

    for (const requirement of requirements){
        const key = requirementKey(requirement);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(requirement);
    }

    return unique;
}

function requirementKey(requirement: NodeRequirement): string{
    switch (requirement.kind){
        case "tool":
            return `tool:${requirement.name}`;
        case "provider":
            return `provider:${requirement.providerId}`;
        case "model":
            return `model:${requirement.providerId}/${requirement.modelId}`;
        case "parameter":
            return `parameter:${requirement.name}`;
    }
}
