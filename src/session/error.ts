import { WireclawError } from "../base";

/** 会话错误类型 */
export const SessionErrorType = {
    Busy: 'Session is busy',
    Archived: 'Session is archived',
    InvalidRequest: 'Invalid request',
    InvalidData: 'Invalid data format',
    MissingSession: 'Missing session',
    MissingProvider: 'Missing provider',
    MissingTools: 'Missing tools',
    ModelUnavailable: 'Model is unavailable',
    NetworkError: 'Network error',
    ProviderError: 'Provider error',
    Unknown: 'Unknown error'
} as const;

export type SessionErrorType = (typeof SessionErrorType)[keyof typeof SessionErrorType];

/** 会话错误 */
export class SessionError extends WireclawError{

    /** 错误类型 */
    readonly type: SessionErrorType;

    /** 错误来源 */
    readonly origin?: unknown;

    constructor(type: SessionErrorType, message?: string, origin?: unknown){
        super(message ?? type);
        this.name = "SessionError";
        this.type = type;
        this.origin = origin;
    }
}

/** 工具错误类型 */
export const ToolErrorType = {
    NotFound: 'Tool not found',
    InvalidParams: 'Invalid tool parameters',
    ProviderError: 'Provider error',
    NetworkError: 'Network error',
    Occupied: 'Tool is occupied',
    Timeout: 'Timeout',
    Denied: 'Denied',
    InternalError: 'Internal error',
    AbortError: 'Abort error',
} as const;

export type ToolErrorType = (typeof ToolErrorType)[keyof typeof ToolErrorType];


/** 工具错误 */
export class ToolError extends WireclawError{

    /** 错误类型 */
    readonly type: ToolErrorType;

    /** 是否可重试 */
    readonly retryable: boolean;

    /** 错误来源 */
    readonly origin?: unknown;

    constructor(type: ToolErrorType, retryable: boolean, message?: string, origin?: unknown){
        super(message ?? type);
        this.name = "ToolError";
        this.type = type;
        this.retryable = retryable;
        this.origin = origin;
    }
}

/** duck typing 判断 ToolError，避免跨 bundle 时 instanceof 失效 */
export function isToolError(e: unknown): e is ToolError {
    if (typeof e !== "object" || e === null) return false;

    const candidate = e as { name?: unknown; type?: unknown; retryable?: unknown };
    return candidate.name === "ToolError"
        && typeof candidate.type === "string"
        && typeof candidate.retryable === "boolean";
}

/** duck typing 判断，避免跨 bundle 时 instanceof 失效 */
export function isSessionError(e: unknown): e is SessionError {
    return e instanceof Error && typeof (e as { type?: unknown }).type === 'string';
}

/** 把任意 unknown 错误归一化为 SessionError */
export function toSessionError(
    e: unknown,
    fallback: SessionErrorType = SessionErrorType.Unknown,
): SessionError {
    if (isSessionError(e)) return e;
    const err = e instanceof Error ? e : new Error(String(e));
    return new SessionError(fallback, err.message, err);
}

/** 公共错误处理函数 */
export function handleSessionError(
    err: unknown,
    onError?: (error: SessionError) => void,
): void {
    const error = toSessionError(err);
    if (onError) onError(error);
    else throw error;
}