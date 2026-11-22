import type {
    HarnessValue,
    InputPortSpec,
    JsonObject,
    JsonValue,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "./type";

/**
 * 节点执行上下文。
 *
 * @note Step 1 只定义契约，不提供运行时实现；Step 2 会在这里补充
 *       provider / generation / attachment 等服务。
 */
export interface NodeContext{

    /** 本次 GraphRun 的 ID */
    readonly runId: string;

    /** 取消信号 */
    readonly signal: AbortSignal;

    /** 节点实例的静态配置 */
    readonly config: JsonValue | undefined;

    /** 运行时日志；设计器/宿主可以订阅 */
    log(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): void;

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
