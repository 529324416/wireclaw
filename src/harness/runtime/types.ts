import type { AttachmentFileManager } from "../../session/attachment-manager";
import type { AIProvider } from "../../session/protocol";
import type { ToolApprovalDecision, ToolApprovalRequest } from "../../session/session";
import type { ToolRegistry } from "../../session/tool";
import type { UserInputRequest, UserInputResult } from "../../session/type";
import type { GraphEventListener, GraphRunStatus } from "../graph/event";
import type { MaybePromise } from "../graph/node";
import type {
    HarnessInput,
    NodeOutputValues,
} from "../graph/type";

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
};

/** 可序列化的暂停快照；恢复时仍需要原 Graph 定义 */
export type GraphCheckpoint = {
    version: 1;
    runId: string;
    graphId: string;
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
    status: GraphRunStatus;
    outputs: NodeOutputValues;
    records: readonly NodeRunRecord[];
    startedAt: number;
    endedAt: number;
    error?: unknown;
};
