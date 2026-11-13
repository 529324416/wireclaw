/* Session模块类型定义 */

import { ToolError, type ToolErrorType } from "./error";
import type { AssistantMessage } from "./message";

/** 附件引用（只保存内容指纹，不保存文件名、路径或远端文件ID） */
export type AttachmentRef = {

    /** 内容指纹（SHA-256 小写十六进制） */
    contentHash: string;
}

/** 消息内容部分 */
export type ContentPart = 
    | { type: "text", text: string }
    | { type: "attachment", attachment: AttachmentRef };


/** 消息内容部分(为了形成先后顺序) */
export type MessageContent = string | ContentPart[];

/** Provider 侧的附件表示
 * - remote-id：已上传到当前平台，fileId 可用
 * - inline：随请求内联，data 为原始字节，具体编码由 ProtocolAdapter 负责
 * - url：平台可直接访问的 URL
 * @note expiresAt 只是提示值，不能作为文件是否有效的唯一依据
 */
export type RemoteFileRef =
    | {
        kind: "remote-id";
        fileId: string;
        name?: string;
        mimeType?: string;
        expiresAt?: number;
    }
    | {
        kind: "inline";
        data: Uint8Array;
        name?: string;
        mimeType?: string;
    }
    | {
        kind: "url";
        url: string;
        name?: string;
        mimeType?: string;
        expiresAt?: number;
    };

/** 内容指纹 -> 当前 Provider 可用的附件表示；由 Session 在发送前构造 */
export type AttachmentWireMap = ReadonlyMap<string, RemoteFileRef>;

/** 工具调用请求(记录AI的调用请求) */
export type ToolCall = {
    id: string;
    name: string;
    params: Record<string, unknown>;
}

/** 包含工具调用后的状态信息（运行期，error 是 ToolError 实例） */
export type ToolCallStatus = {
    /** 是否成功 */
    isSuccess: boolean;

    /** 耗时（毫秒） */
    duration: number;

    /** 工具调用错误 */
    error?: ToolError;
}

/** 工具错误的可序列化数据 */
export type ToolErrorData = {
    /** 错误类型 */
    type: ToolErrorType;

    /** 是否可重试 */
    retryable: boolean;

    /** 错误消息 */
    message: string;
};

/** 工具调用状态的可序列化数据
 * @note error 必须是 plain object；ToolError 实例不能直接持久化
 */
export type ToolCallStatusData = {
    /** 是否成功 */
    isSuccess: boolean;

    /** 耗时（毫秒） */
    duration: number;

    /** 工具调用错误数据 */
    error?: ToolErrorData;
};

/** 工具调用进度（由支持进度的工具主动上报） */
export type ToolProgress = {

    /** 对应的工具调用 ID */
    callId: string;

    /** 当前进度值 */
    progress: number;

    /** 总量（可选） */
    total?: number;

    /** 进度消息（可选） */
    message?: string;

    /** 最后更新时间（毫秒时间戳） */
    updatedAt: number;
};

/** 选择题选项 */
export type UserQuestionOption = {
    id: string;
    label: string;
    description?: string;
};

/** 单个问题 */
export type UserQuestion = {
    id: string;
    header?: string;
    question: string;
    options: UserQuestionOption[];
    multiSelect?: boolean;
    allowOther?: boolean;
};

/** 人工输入请求 */
export type UserInputRequest = {
    id: string;
    title?: string;
    questions: UserQuestion[];
};

/** 单个问题的回答 */
export type UserInputAnswer = {
    questionId: string;
    selected: string[];
    other?: string;
};

/** 人工输入结果 */
export type UserInputResult = {
    requestId: string;
    answers: UserInputAnswer[];
    cancelled?: boolean;
};

/** 工具调用结果 */
export type ToolCallResult = {

    /** 消息内容部分(为了形成先后顺序) */
    content: MessageContent;

    /** 工具调用详情 */
    status: ToolCallStatus;

    /** 结构化内容，UI/Harness使用的结构化数据 */
    structuredContent?: object;

    /** 原始数据 */
    raw?: unknown;
}

export const ChatRoleUser = 'user'
export const ChatRoleAssistant = 'assistant'
export const ChatRoleSystem = 'system'
export const ChatRoleTool = 'tool'

/** 消息角色 */
export type ChatRole = 
    typeof ChatRoleUser | 
    typeof ChatRoleAssistant | 
    typeof ChatRoleSystem | 
    typeof ChatRoleTool

/** 消息状态 */
export const ChatStatus = {
    Pending: 'pending', // streaming状态归属于pending，由外部draft管理
    Completed: 'completed',
    Failed: 'failed',
    Canceled: 'canceled',
} as const;
export type ChatStatus = (typeof ChatStatus)[keyof typeof ChatStatus];

/** 失败原因 */
export const ChatFailureReason = {
    InternalError: 'internal_error',
    UserCanceled: 'user_canceled',
    ToolError: 'tool_error',
    Unknown: 'unknown',
} as const;
export type ChatFailureReason = (typeof ChatFailureReason)[keyof typeof ChatFailureReason];

/** 助手消息用量 */
export type ChatUsage = {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

/** 对话停止原因 */
export const ChatStopReason = {
    Stop: 'stop',
    Length: 'length',
    ToolCall: 'tool_call',
    ContentFilter: 'content_filter',
} as const;
export type ChatStopReason = (typeof ChatStopReason)[keyof typeof ChatStopReason];

/** 消息数据公共部分 */
export type MessageDataBase = {
    content: MessageContent;
    isCompressed: boolean;
};

export type MessageDataUser = MessageDataBase & { role: typeof ChatRoleUser };
export type MessageDataAssistant = MessageDataBase & { 
    role: typeof ChatRoleAssistant, 
    thinking?: string, 
    usage: ChatUsage, 
    toolCalls: ToolCall[],
    failureReason?: ChatFailureReason | undefined; 
    stopReason?: ChatStopReason | undefined; };
export type MessageDataSystem = MessageDataBase & { role: typeof ChatRoleSystem };
export type MessageDataTool = MessageDataBase & { role: typeof ChatRoleTool, toolName: string, callId: string, details: ToolCallStatusData };

/** 消息数据 */
export type MessageData = 
    | MessageDataUser
    | MessageDataAssistant
    | MessageDataSystem
    | MessageDataTool   

/** 会话数据 */
export type SessionData = {
    id: string;
    messages: MessageData[];
    isArchived: boolean;
};

export const SessionEventType = {
    /** 用户输入 */
    USER_INPUT: 'user_input',

    /** 系统输入 */
    SYSTEM_INPUT: 'system_input',
    
    /** 工具输入 */
    TOOL_INPUT: 'tool_input',
    
    /** 助手开始 */
    ASSISTANT_START: 'assistant_start',

    /** 助手流式输出 */
    ASSISTANT_TOKEN: 'assistant_token',

    /** 助手流式输出附件 */
    ASSISTANT_TOKEN_ATTACHMENT: 'assistant_token_attachment',

    /** 助手思考结束（没有思考过程的情况下也会触发） */
    ASSISTANT_THINKING_OVER: 'assistant_thinking_over',

    /** AgentLoop一回合结束 */
    ASSISTANT_COMPLETE_TURN: 'assistant_complete_turn',

    /** AgentLoop结束
     * @note 无论是因为正常完成还是因为异常结束，都会触发
     */
    ASSISTANT_COMPLETE: 'assistant_complete',

    /** 工具调用开始 */
    TOOL_CALL_START: 'tool_call_start',

    /** 工具调用结束 */
    TOOL_CALL_END: 'tool_call_end',

    /** 工具调用进度（超过延迟阈值后才会发出） */
    TOOL_PROGRESS: 'tool_progress',

    /** 工具请求人工输入（会话进入暂停状态） */
    TOOL_INPUT_REQUIRED: 'tool_input_required',

    /** 工具调用需要人工审批（会话进入暂停状态） */
    TOOL_APPROVAL_REQUIRED: 'tool_approval_required',

    /** 工具在完全权限模式下未经审批直接执行（危险警告） */
    TOOL_PERMISSION_WARNING: 'tool_permission_warning',

    /** 用户终止 */
    USER_ABORT: 'user_abort',

    /** 错误 */
    ERROR: 'error',

    /** 会话状态变更（会话从忙碌状态切换为空闲状态） */
    STATE_CHANGE: 'state_change',
} as const;
export type SessionEventType = (typeof SessionEventType)[keyof typeof SessionEventType];

export type SessionEvent = 

    // 一般输入类消息
    | { type: typeof SessionEventType.USER_INPUT, msg: MessageContent }
    | { type: typeof SessionEventType.SYSTEM_INPUT, msg: MessageContent }
    | { type: typeof SessionEventType.TOOL_INPUT, msg: MessageContent }

    // 模型输出类消息
    | { type: typeof SessionEventType.ASSISTANT_START }
    | { type: typeof SessionEventType.ASSISTANT_TOKEN, token: string, isThinking: boolean }
    | { type: typeof SessionEventType.ASSISTANT_TOKEN_ATTACHMENT, attachmentId: string, token: string, isThinking: boolean }
    | { type: typeof SessionEventType.ASSISTANT_THINKING_OVER, thinking: string }
    | { type: typeof SessionEventType.ASSISTANT_COMPLETE_TURN, msg: MessageContent, usage: ChatUsage }
    | { type: typeof SessionEventType.ASSISTANT_COMPLETE, msg: MessageContent, usage: ChatUsage }

    // 工具调用类消息
    | { type: typeof SessionEventType.TOOL_CALL_START, call: ToolCall }
    | { type: typeof SessionEventType.TOOL_CALL_END, call: ToolCall, result: ToolCallResult }
    | { type: typeof SessionEventType.TOOL_PROGRESS, call: ToolCall, progress: ToolProgress }
    | { type: typeof SessionEventType.TOOL_INPUT_REQUIRED, call: ToolCall, request: UserInputRequest }
    | { type: typeof SessionEventType.TOOL_APPROVAL_REQUIRED, call: ToolCall, tool: ToolDefinition | null }
    | { type: typeof SessionEventType.TOOL_PERMISSION_WARNING, call: ToolCall, tool: ToolDefinition | null, message: string }

    // 用户操作
    | { type: typeof SessionEventType.USER_ABORT }

    // 系统类消息
    | { type: typeof SessionEventType.ERROR, msg: MessageContent }
    | { type: typeof SessionEventType.STATE_CHANGE, state: SessionState }

export type SessionEventListener = (event: SessionEvent) => void;

/** 会话状态 */
export const SessionState = {
    Idle: "idle",               // 会话空闲状态
    Run: "run",                 // 会话运行中
    Cancel: "cancel",           // 用户主动取消会话
    Pause: "pause",             // 会话因工具call而暂停
    Interrupt: "interrupt",     // 遇到各类非用户中断的其他情况，例如断电、程序被强制关闭等情况导致会话强行中断
} as const;
export type SessionState = (typeof SessionState)[keyof typeof SessionState];

/** 会话权限等级
 * - readonly：只允许只读工具，其余直接拒绝
 * - approval：审批类工具需要人工确认
 * - full：审批类/破坏性工具直接放行，但会发出危险警告
 */
export const SessionPermission = {
    ReadOnly: "readonly",
    Approval: "approval",
    Full: "full",
} as const;
export type SessionPermission = (typeof SessionPermission)[keyof typeof SessionPermission];

/** 模型思考等级 */
export type ModelThinkingLevel = string | number;

/** 会话选项（由SessionController负责维护） */
export type SessionRuntimeOptions = {

    /** 当前会话所使用的模型ID/如果目标平台不支持选择模型则忽略该字段 */
    model?: string;

    /** 是否开启思考过程 
     * @note 不填时默认不传递该参数，使用服务商默认值
    */
    think?: boolean;

    /** 思考过程等级(根据不同的协议转化为对应的参数值）
     * @note 不填时默认不传递该参数，使用服务商默认值
     */
    thinkingLv?: ModelThinkingLevel;

    /** 不支持*/
    temperature?: number;

    // 其他选项...
};

/** 模型的反馈/通常用于临时转接AssistantMessage */
export type ChatResult = {

    message: AssistantMessage;
    // 原始响应，调试用
    raw?: unknown;               
};


export type ChatOptions = {
    /** 取消信号 */
    signal: AbortSignal;

    /** 模型输出回调 */
    onToken?: (token: MessageContent, isThinking: boolean) => void;

    /** 本轮可用的工具定义；不传或空数组表示不启用工具调用 */
    tools?: ToolDefinition[];

    /** 本轮附件映射；由 Session 根据 IFileHost 和 CloudFileManager 解析后传入 */
    attachmentRefs?: AttachmentWireMap;
};

/* ---- 流式解析单元 ---- */

/** 工具调用的流式增量 */
export type StreamToolCallDelta = {
    /** 同一次响应中的工具调用序号，从 0 开始 */
    index: number;

    /** 首次出现时提供 */
    id?: string;

    /** 首次出现时提供 */
    name?: string;

    /** 参数 JSON 的增量片段 */
    argumentsDelta?: string;
};

/** 归一化后的流式片段 */
export type StreamChunk =
    | { type: "text_delta"; text: string }
    | { type: "thinking_delta"; text: string }
    | { type: "tool_call_delta"; toolCall: StreamToolCallDelta }
    | { type: "usage"; usage: ChatUsage }
    | { type: "done"; stopReason?: ChatStopReason }
    | { type: "error"; failureReason: ChatFailureReason; message?: string };


/** JSON Schema 定义（只声明工具参数会用到的关键字） */
export type ToolParamSchema = {
    /** 参数类型；JSON Schema 允许单类型或类型数组 */
    type?: string | string[];
    title?: string;
    description?: string;
    properties?: Record<string, ToolParamSchema>;
    required?: string[];
    items?: ToolParamSchema | ToolParamSchema[];
    enum?: unknown[];
    [key: string]: unknown;
}

/** 工具来源信息（由 ToolRegistry 统一填充） */
export type ToolDefinitionSource = {
    providerId: string;
    serverName?: string;
    version?: string;
};

/** 工具是什么（名称、描述、schema、权限注解）
 * @note name 是 Provider 提供的裸工具名（不含 Provider 前缀），
 *       ToolRegistry 会拼装为 `<providerId>__<name>` 后再暴露给模型。
 */
export type ToolDefinition = {
    name: string;
    title?: string;
    description: string;
    inputSchema: ToolParamSchema;      // 模型看到的参数 schema
    outputSchema?: ToolParamSchema;

    /** 建议的单次调用超时（毫秒）
     * @note 未设置时 Session 使用默认 30s；超过 1h 会被截断
     */
    adviceTimeout?: number;

    annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;

        /** 是否允许与其他工具并发执行；未声明时按不可并发处理 */
        concurrencySafe?: boolean;

        /** 调用前是否需要人工审批；未声明时不需要 */
        requiresApproval?: boolean;
    };
    /** 工具来源；Provider 可以留空，由 ToolRegistry 填充 */
    source?: ToolDefinitionSource;
};

/** 文件内容：统一使用字节数组，文本按 UTF-8 编码后存储 */
export type FileContent = Uint8Array;