import { WireclawError } from "../../base/error";

/** Harness Graph 错误码 */
export const HarnessErrorCode = {
    InvalidGraph: "invalid_graph",
    InvalidNode: "invalid_node",
    InvalidPort: "invalid_port",
    DuplicateNodeId: "duplicate_node_id",
    DuplicateEdge: "duplicate_edge",
    UnknownNodeType: "unknown_node_type",
    NodeTypeConflict: "node_type_conflict",
    UnsupportedNodeTypeVersion: "unsupported_node_type_version",
    UnknownPort: "unknown_port",
    PortTypeMismatch: "port_type_mismatch",
    MissingInput: "missing_input",
    MultipleInputEdges: "multiple_input_edges",
    CycleDetected: "cycle_detected",
    InvalidValue: "invalid_value",
    InvalidRequest: "invalid_request",
    ProviderNotFound: "provider_not_found",
    MissingOutputNode: "missing_output_node",
    DuplicateOutputNode: "duplicate_output_node",
    MissingValue: "missing_value",
    NodeExecutionFailed: "node_execution_failed",
    InvalidPreset: "invalid_preset",
    UnsupportedPresetVersion: "unsupported_preset_version",
    MissingToolDependency: "missing_tool_dependency",
    MissingProviderDependency: "missing_provider_dependency",
    MissingModelDependency: "missing_model_dependency",
    MissingParameterDependency: "missing_parameter_dependency",
    InvalidDocument: "invalid_document",
    UnsupportedDocumentVersion: "unsupported_document_version",
    SerializationFailed: "serialization_failed",
    DeserializationFailed: "deserialization_failed",
    NotImplemented: "not_implemented",
} as const;
export type HarnessErrorCode = (typeof HarnessErrorCode)[keyof typeof HarnessErrorCode];

/** 一条可定位到节点/端口的校验问题 */
export type HarnessIssue = {
    code: HarnessErrorCode;
    message: string;
    nodeId?: string;
    port?: string;
    edgeIndex?: number;
};

export type HarnessErrorOptions = {
    nodeId?: string;
    port?: string;
    issues?: readonly HarnessIssue[];
    origin?: unknown;
};

/** Harness 统一异常；校验问题尽量放进 issues，便于设计器逐条高亮 */
export class HarnessError extends WireclawError{

    readonly code: HarnessErrorCode;
    readonly nodeId?: string;
    readonly port?: string;
    readonly issues?: readonly HarnessIssue[];
    readonly origin?: unknown;

    constructor(
        code: HarnessErrorCode,
        message: string,
        options: HarnessErrorOptions = {},
    ){
        super(message);
        this.name = "HarnessError";
        this.code = code;
        this.nodeId = options.nodeId;
        this.port = options.port;
        this.issues = options.issues;
        this.origin = options.origin;
    }
}

export function isHarnessError(error: unknown): error is HarnessError{
    return error instanceof HarnessError;
}

/** 把问题格式化为 "node.port: message" */
export function formatHarnessIssue(issue: HarnessIssue): string{
    const location = issue.nodeId === undefined
        ? undefined
        : issue.port === undefined
            ? issue.nodeId
            : `${issue.nodeId}.${issue.port}`;
    return location === undefined ? issue.message : `${location}: ${issue.message}`;
}
