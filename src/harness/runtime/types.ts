import type { AttachmentFileManager } from "../../session/attachment-manager";
import type { AIProvider } from "../../session/protocol";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../session/session";
import type { ToolRegistry } from "../../session/tool";
import type {
    AttachmentRef,
    ChatUsage,
    SessionData,
    UserInputRequest,
    UserInputResult,
} from "../../session/type";
import type { GraphEventListener, GraphRunStatus } from "../graph/event";
import type { MaybePromise } from "../graph/node";
import type {
    HarnessInput,
    NodeOutputValues,
} from "../graph/type";
import type { RunResultCollector } from "./run-result";

export type { RunResultCollector } from "./run-result";

/** 宿主提供的 Provider 解析器；Graph 只保存 providerId，不保存密钥/实例 */
export type GraphProviderResolver = (providerId: string) => AIProvider | undefined;

/** Graph 运行所需的宿主能力 */
export type GraphHost = {

    /** 解析模型节点里的 providerId */
    resolveProvider: GraphProviderResolver;

    /** B 节点的工具注册表 */
    tools?: ToolRegistry;

    /** A/B 节点解析附件所需的附件仓库 */
    attachments?: AttachmentFileManager;

    /** B 节点遇到审批时的宿主回调；未提供会失败 */
    onToolApproval?: (
        request: ToolApprovalRequest,
        nodeId: string,
    ) => MaybePromise<ToolApprovalDecision>;

    /** B 节点遇到 host__ask_user 时的宿主回调；未提供会失败 */
    onUserInput?: (
        request: UserInputRequest,
        nodeId: string,
    ) => MaybePromise<UserInputResult>;

    /** 运行参数；用于校验 NodeRequirement(kind: "parameter") */
    parameters?: Readonly<Record<string, unknown>>;

    /** 节点日志出口 */
    log?: (
        level: "debug" | "info" | "warn" | "error",
        message: string,
        data?: unknown,
    ) => void;
};

export type GraphRunInput = HarnessInput;

export type GraphRunOptions = {
    host: GraphHost;
    input?: GraphRunInput;
    listener?: GraphEventListener;
    signal?: AbortSignal;
    maxConcurrency?: number;

    /** 从暂停点恢复；恢复时 input 以 checkpoint 为准 */
    checkpoint?: GraphCheckpoint;

    /**
     * @internal 嵌套运行共享的结果采集器。
     *
     * 顶层 run 不传时由 GraphRun 自行创建；Subgraph / Loop / ForEach 运行内层图时
     * 传入父 run 的采集器，使 entries 能带 graphPath 冒泡到根结果。
     */
    resultCollector?: RunResultCollector;

    /** @internal 当前内嵌图路径；写入 RunResultEntry.graphPath */
    graphPath?: readonly string[];
};

/** 可序列化的暂停快照；恢复时仍需要原 Graph 定义 */
export type GraphCheckpoint = {
    version: 2;
    runId: string;
    graphId: string;
    /** 可执行图定义（不含 ui / title / metadata）的稳定指纹 */
    graphHash: string;
    /** 顶层节点 id -> typeVersion；恢复时逐项比对 */
    nodeVersions: Record<string, number>;
    input: GraphRunInput;
    outputs: Record<string, NodeOutputValues>;
    records: NodeRunRecord[];
    edgeStates: Record<string, "value" | "skipped">;
    pending: Record<string, number>;
    ready: string[];
};

export type NodeRunRecordStatus = "completed" | "failed" | "cancelled" | "skipped";

export type NodeRunRecord = {
    nodeId: string;
    type: string;
    status: NodeRunRecordStatus;
    startedAt: number;
    endedAt: number;
    outputs?: NodeOutputValues;
    error?: unknown;
};

export type GraphRunResult = {
    runId: string;
    /** 本次运行的图 id；嵌套运行时为内层图 id */
    graphId: string;
    status: GraphRunStatus;
    outputs: NodeOutputValues;
    records: readonly NodeRunRecord[];
    /** 运行期间采集的模型调用 / Agent 会话条目；嵌套运行的条目带 graphPath */
    entries: readonly RunResultEntry[];
    startedAt: number;
    endedAt: number;
    error?: unknown;
};

/* ---------------------------------------------------------------------------
 * RunResult：运行结果的版本化、JSON-safe 聚合文档
 * ------------------------------------------------------------------------- */

export type RunResultEntryStatus = "completed" | "failed";

/** 一次模型调用的结果条目（A 类节点）。 */
export type RunResultModelCallEntry = {
    kind: "model-call";
    id: string;
    nodeId: string;
    nodeType: string;
    /** 内嵌图路径；顶层节点省略。数组元素形如 `subgraph.<nodeId>` / `loop.<nodeId>.<index>` */
    graphPath?: string[];
    providerId: string;
    modelId: string;
    mode: "chat" | "generate";
    status: RunResultEntryStatus;
    startedAt: number;
    endedAt: number;
    input: {
        prompt: string;
        system?: string;
        attachments?: AttachmentRef[];
    };
    output?: {
        text: string;
        thinking?: string;
        attachments?: AttachmentRef[];
        usage?: ChatUsage;
        stopReason?: string;
        failureReason?: string;
    };
    error?: string;
};

/** 一次 Agent 会话的结果条目（B 类节点）；完整保留 wireclaw SessionData。 */
export type RunResultSessionEntry = {
    kind: "session";
    id: string;
    nodeId: string;
    nodeType: string;
    graphPath?: string[];
    providerId: string;
    modelId: string;
    status: RunResultEntryStatus;
    startedAt: number;
    endedAt: number;
    session: SessionData;
    error?: string;
};

export type RunResultEntry = RunResultModelCallEntry | RunResultSessionEntry;

/**
 * 节点提交给采集器的条目草稿。
 *
 * `id` / `nodeId` / `nodeType` / `graphPath` 由运行时统一补齐，节点不自行填写。
 */
export type RunResultEntryDraft =
    | Omit<RunResultModelCallEntry, "id" | "nodeId" | "nodeType" | "graphPath">
    | Omit<RunResultSessionEntry, "id" | "nodeId" | "nodeType" | "graphPath">;

/** 版本化运行结果文档；归 wireclaw，FH 只持久化与展示。 */
export type RunResult = {
    version: 1;
    runId: string;
    graphId: string;
    status: GraphRunStatus;
    startedAt: number;
    endedAt: number;
    input?: GraphRunInput;
    outputs: NodeOutputValues;
    entries: RunResultEntry[];
    error?: string;
};
