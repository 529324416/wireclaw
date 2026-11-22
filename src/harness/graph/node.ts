import type { AttachmentFileManager } from "../../session/attachment-manager";
import type { AIProvider } from "../../session/protocol";
import type { ToolRegistry } from "../../session/tool";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../session/session";
import type { UserInputRequest, UserInputResult } from "../../session/type";
import type {
    HarnessInput,
    HarnessValue,
    InputPortSpec,
    JsonObject,
    JsonValue,
    ModelBinding,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
    ToolSetSpec,
} from "./type";

export type MaybePromise<T> = T | Promise<T>;

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
}

/**
 * Graph 节点基类。
 *
 * - 节点是定义，不是运行状态；同一个 Graph 可以被多次运行；
 * - `execute` 返回 value 输出，stream 输出通过 `ctx.emit`；
 * - 自定义节点由宿主继承并注册到 NodeTypeRegistry，JSON 中只保存 type/config。
 */
export abstract class GraphNode{

    constructor(
        readonly id: string,
        readonly config: JsonValue | undefined = undefined,
        readonly inputDefaults: NodeInputValues = {},
        readonly ui: JsonObject | undefined = undefined,
    ){}

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
