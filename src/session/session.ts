import { readMediaDuration, uniqueId } from "../base";
import { SessionError, SessionErrorType, ToolError, ToolErrorType } from "./error";
import type { AttachmentFileManager } from "./attachment-manager";
import { AttachmentIngestor } from "./attachment-ingestor";
import {
    AttachmentFileError,
    AttachmentFileErrorCode,
    collectAttachmentHashes,
    isContentHash,
} from "./attachment";
import {
    detectMediaMimeType,
    mediaModalityFromMimeType,
    validateMediaInputLimit,
} from "./media";
import type { PendingAttachment } from "./media";
import { AssistantMessage, ToolMessage, UserMessage, tool, user } from "./message";
import type { Message } from "./message";
import { isChatProvider } from "./protocol";
import type {
    AIProvider,
    ChatProvider,
    MediaInputLimit,
    ModelCapabilities,
    ModelInfo,
    ModelLimits,
    ModelModality,
} from "./protocol";
import {
    ChatRoleAssistant,
    SessionPermission,
    SessionState,
    SessionEventType,
} from "./type";
import type {
    AttachmentRef,
    AttachmentWireMap,
    ChatStopReason,
    ChatUsage,
    ContentPart,
    MessageContent,
    RemoteFileRef,
    SessionEventListener,
    SessionEvent,
    SessionRuntimeOptions,
    ToolCall,
    ToolCallResult,
    ToolDefinition,
    ToolProgress,
    UserInputRequest,
    UserInputResult,
} from "./type";
import type { ToolRegistry } from "./tool";
import {
    ASK_USER_TOOL_DEFINITION,
    ASK_USER_TOOL_NAME,
    HOST_TOOL_DEFINITIONS,
    VIEW_MEDIA_TOOL_DEFINITION,
    VIEW_MEDIA_TOOL_NAME,
    formatUserInputResult,
    parseUserInputRequest,
    validateUserInputResult,
} from "./host-tool";

function emptyUsage(): ChatUsage{
    return {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
    }
}

/** 会话数据类 */
export class SessionHistory{

    private _id: string;
    private _messages: Message[];
    private _isArchived: boolean;
    
    private _tmpUsage?: ChatUsage;

    /** 会话ID */
    get id(): string{ return this._id; }

    /** 会话消息列表 
     * @note 只读数组，外部不能直接修改
    */
    get messages(): readonly Message[]{ return this._messages; }

    /** 是否为空 */
    get isEmpty(): boolean{ return this._messages.length === 0; }

    /** 会话使用统计 */
    get usage(): ChatUsage{
        if (this._tmpUsage === undefined) {
            this._tmpUsage = emptyUsage();
            for (const msg of this._messages) {
                if (msg.role !== ChatRoleAssistant) continue;
                const assistantMsg = msg as AssistantMessage;
                this._tmpUsage.promptTokens += assistantMsg.usage.promptTokens;
                this._tmpUsage.completionTokens += assistantMsg.usage.completionTokens;
                this._tmpUsage.totalTokens += assistantMsg.usage.totalTokens;
            }
        }
        return { ...this._tmpUsage };
    }

    /** 是否已归档 */
    get isArchived(): boolean{ return this._isArchived; }

    /** 构造函数 
     * @param id 会话ID
     * @param messages 会话消息列表
     * @param isArchived 是否已归档
    */
    constructor(id?: string, messages?: Message[], isArchived?: boolean){
        this._id = id === undefined || id.length === 0 ? uniqueId() : id;
        this._messages = messages ? [...messages] : [];
        this._isArchived = isArchived === undefined ? false : isArchived;
    }

    /** 会话快照
     * @note 快照是消息的深拷贝，不会影响原始会话数据，且不包含压缩消息
     * @returns 会话消息列表的深拷贝
    */
    snapshot(): Message[]{
        return this._messages
            .filter(msg => !msg.isCompressed)
            .map(msg => msg.clone());
    }

    /** 提交一次运行产生的消息
     * @note 提交是原子的：校验失败时不会写入任何消息
    */
    commitMessages(pendingMsgs: readonly Message[]): void{
        if (pendingMsgs.length === 0) return;
        if (this._isArchived){
            throw new SessionError(SessionErrorType.Archived, "Cannot commit messages to an archived session");
        }

        this._validatePendingMessages(pendingMsgs);
        this._messages.push(...pendingMsgs);
        this._tmpUsage = undefined;
    }

    /** 校验一次 Run 的 pending 消息是否构成合法的提交单元 */
    private _validatePendingMessages(pendingMsgs: readonly Message[]): void{
        const openToolCalls = new Map<string, ToolCall>();

        for (const [index, message] of pendingMsgs.entries()){
            if (message instanceof AssistantMessage){
                if (message.failureReason !== undefined){
                    throw new SessionError(
                        SessionErrorType.InvalidData,
                        `Cannot commit failed assistant message at pendingMessages[${index}]`,
                    );
                }

                for (const call of message.toolCalls){
                    if (openToolCalls.has(call.id)){
                        throw new SessionError(
                            SessionErrorType.InvalidData,
                            `Duplicate tool call id "${call.id}" at pendingMessages[${index}]`,
                        );
                    }
                    openToolCalls.set(call.id, call);
                }
                continue;
            }

            if (message instanceof ToolMessage){
                if (!openToolCalls.has(message.callId)){
                    throw new SessionError(
                        SessionErrorType.InvalidData,
                        `Tool message at pendingMessages[${index}] has no matching tool call "${message.callId}"`,
                    );
                }
                openToolCalls.delete(message.callId);
            }
        }

        if (openToolCalls.size > 0){
            const ids = [...openToolCalls.keys()].join(", ");
            throw new SessionError(
                SessionErrorType.InvalidData,
                `Pending messages contain unresolved tool calls: ${ids}`,
            );
        }

        const last = pendingMsgs[pendingMsgs.length - 1];
        // 正常结束以助手消息收尾；因步数上限被截断时允许以已闭合的工具消息收尾
        if (!(last instanceof AssistantMessage) && !(last instanceof ToolMessage)){
            throw new SessionError(
                SessionErrorType.InvalidData,
                "Pending messages should end with an assistant or tool message",
            );
        }
    }
}



/** Run 状态 */
export const RunStatus = {
    Running: "running",
    Aborting: "aborting",
    Paused: "paused",
    Completed: "completed",
    Failed: "failed",
    Canceled: "canceled",
} as const;

export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

/** 运行数据类(物化一次运行记录，同时也作为RunEngine本轮的产出内容) 
 * @note 只保存运行数据，不承担状态锁；状态迁移由 Session 控制
*/
export class Run{
    private _runId: string;
    private _sessionId: string;
    private _status: RunStatus;
    private _pendingMessages: Message[];
    private _pendingUsage: ChatUsage;
    private _step: number;

    /** 本次运行中各工具调用的最新进度 */
    private readonly _toolProgress: Map<string, ToolProgress> = new Map();

    private _startAt: Date;
    private _endAt?: Date;
    private _stopReason?: ChatStopReason;
    private _error?: unknown;

    /** 运行ID */
    get id(): string{ return this._runId; }

    /** 会话ID */
    get sessionId(): string{ return this._sessionId; }

    /** 运行状态 */
    get status(): RunStatus{ return this._status; }

    /** 当前步数 */
    get step(): number{ return this._step; }

    /** 待处理消息列表 */
    get pendingMessages(): readonly Message[]{ return this._pendingMessages; }

    /** 待处理使用统计 */
    get pendingUsage(): ChatUsage{ return { ...this._pendingUsage }; }

    /** 开始时间 */
    get startAt(): Date{ return this._startAt; }

    /** 结束时间 */
    get endAt(): Date | undefined{ return this._endAt; }

    /** 运行时长 */
    get duration(): number{
        if (this._endAt === undefined) return 0;
        return this._endAt.getTime() - this._startAt.getTime();
    }

    /** 是否已停止 */
    get isStopped(): boolean{
        return this._status === RunStatus.Completed
            || this._status === RunStatus.Failed
            || this._status === RunStatus.Canceled;
    }

    /** 停止原因 */
    get stopReason(): ChatStopReason | undefined{ return this._stopReason; }

    /** 错误信息 */
    get error(): unknown | undefined{ return this._error; }

    constructor(sessionId: string, runId?: string, pendingMessages?: readonly Message[], pendingUsage?: ChatUsage){
        this._sessionId = sessionId;
        this._runId = runId ?? uniqueId();
        this._status = RunStatus.Running;
        this._pendingMessages = pendingMessages ? [...pendingMessages] : [];
        this._pendingUsage = pendingUsage ? { ...pendingUsage } : emptyUsage();
        this._step = 0;
        this._startAt = new Date();
    }

    /** 追加待处理消息 */
    appendMessage(msg: Message): void{
        this._pendingMessages.push(msg);
        if (!(msg instanceof AssistantMessage)) return;
        this._pendingUsage.promptTokens += msg.usage.promptTokens;
        this._pendingUsage.completionTokens += msg.usage.completionTokens;
        this._pendingUsage.totalTokens += msg.usage.totalTokens;
    }

    /** 推进步数 */
    nextStep(): number{
        this._step += 1;
        return this._step;
    }

    /** 记录工具进度 */
    setToolProgress(progress: ToolProgress): void{
        this._toolProgress.set(progress.callId, progress);
    }

    /** 获取某个工具调用的最新进度 */
    getToolProgress(callId: string): ToolProgress | undefined{
        return this._toolProgress.get(callId);
    }

    /** 进入 aborting 状态 */
    markAborting(): void{
        if (this.isStopped) return;
        this._status = RunStatus.Aborting;
    }

    /** 进入 paused 状态 */
    markPaused(): void{
        if (this.isStopped) return;
        this._status = RunStatus.Paused;
    }

    /** 从 paused/aborting 恢复运行 */
    resume(): void{
        if (this.isStopped) return;
        this._status = RunStatus.Running;
    }

    /** 正常完成 */
    complete(stopReason?: ChatStopReason): void{
        this._status = RunStatus.Completed;
        this._stopReason = stopReason;
        this._endAt = new Date();
    }

    /** 失败 */
    fail(error: unknown): void{
        this._status = RunStatus.Failed;
        this._error = error;
        this._endAt = new Date();
    }

    /** 取消 */
    cancel(): void{
        this._status = RunStatus.Canceled;
        this._endAt = new Date();
    }
}

/** 单次运行的最大模型轮数（防止工具调用死循环） */
export const DEFAULT_MAX_STEPS = 16;

/** 默认工具并发上限（1 = 顺序执行） */
export const DEFAULT_TOOL_CONCURRENCY = 1;

/** 工具进度事件默认延迟（5s 后才向前端推送） */
export const DEFAULT_TOOL_PROGRESS_DELAY_MS = 5_000;

/** 工具调用默认超时（毫秒） */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** 工具调用允许的最大超时（毫秒） */
export const MAX_TOOL_TIMEOUT_MS = 3_600_000;

/** 默认会话权限：审批类工具需要人工确认 */
export const DEFAULT_SESSION_PERMISSION = SessionPermission.Approval;

/** Session 在一次运行中需要的工具能力；ToolRegistry 天然满足该结构 */
export type ToolSource = Pick<ToolRegistry, "listTools" | "invoke">;

/** 工具审批决定 */
export type ToolApprovalDecision = "approve" | "deny";

/** 审批等待期间的内部结果；abort 表示运行已被取消 */
export type ToolApprovalResult = ToolApprovalDecision | "abort";

/** 审批请求 */
export type ToolApprovalRequest = {

    /** 待审批的工具调用 */
    call: ToolCall;

    /** 工具定义；未命中时为 null */
    tool: ToolDefinition | null;
};

/** run() 的运行选项 */
export type RunOptions = {

    /** 本次运行可访问的工具集；不传则不启用工具调用 */
    tools?: ToolSource;

    /** 最大模型轮数，默认 DEFAULT_MAX_STEPS */
    maxSteps?: number;

    /** 单批工具调用的最大并发数，默认 DEFAULT_TOOL_CONCURRENCY */
    toolConcurrency?: number;

    /** 本次运行的权限等级，默认 DEFAULT_SESSION_PERMISSION */
    permission?: SessionPermission;

    /** 工具进度事件延迟（毫秒），默认 DEFAULT_TOOL_PROGRESS_DELAY_MS */
    toolProgressDelayMs?: number;

    /** 是否向模型暴露 host__ask_user，默认 true */
    enableUserInput?: boolean;
};

/** 运行上下文 */
/** 已落盘的媒体及其原始描述 */
export type IngestedAttachment = {
    attachment: PendingAttachment;
    ref: AttachmentRef;
};

/** 一次附件解析的结果 */
export type AttachmentResolution = {

    /** 当前 Provider 可用的附件表示；没有任何可用附件时省略 */
    attachmentRefs?: AttachmentWireMap;

    /** 历史消息中缺失、已被降级为文本占位符的 contentHash */
    missing: ReadonlySet<string>;
};

export type RunContext = {

    /** 会话快照 */
    snapshot: Message[];

    /** 物化运行，临时存放产出结果 */
    run: Run;

    /** 对话选项 */
    runtimeOptions: SessionRuntimeOptions;

    /** 会话事件发射器 */
    emit: SessionEventListener;

    /** 当前绑定的对话 Provider（AIProvider + ChatCapability） */
    provider: ChatProvider;

    /** 取消信号 */
    signal: AbortSignal;

    /** 本次运行可访问的工具；undefined 表示不启用工具调用 */
    tools?: ToolSource;

    /** 本次运行允许的最大模型轮数 */
    maxSteps: number;

    /** 单批工具调用的最大并发数 */
    toolConcurrency: number;

    /** 本次运行的权限等级 */
    permission: SessionPermission;

    /** 当前模型是否允许工具调用（Provider 支持且模型未声明 tools:false） */
    enableTools: boolean;

    /** 当前模型是否允许思考参数（模型未声明 thinking:false） */
    enableThinking: boolean;

    /** 工具进度事件延迟（毫秒） */
    toolProgressDelayMs: number;

    /** 是否启用 host 内置工具（ask_user） */
    enableUserInput: boolean;

    /** 是否允许模型调用 host__view_media 回看 assistant 历史媒体 */
    enableViewMedia: boolean;

    /** 当前模型可接收的媒体输入；用于把当前轮 tool 媒体转换为 user 消息 */
    viewableModalities: readonly ModelModality[];

    /** 模型自己的产出中可回看的媒体模态（输入 ∩ 输出）；用于 host__view_media */
    selfViewableModalities: readonly ModelModality[];

    /** 解析附件的内容模态；用于 host__view_media 和 tool 媒体模态过滤 */
    resolveMediaModality: (contentHash: string) => Promise<ModelModality | undefined>;

    /** 请求人工输入；返回用户回答 */
    requestUserInput: (request: UserInputRequest, call: ToolCall) => Promise<UserInputResult>;

    /** 请求人工审批；返回 abort 表示运行已取消 */
    requestApproval: (request: ToolApprovalRequest) => Promise<ToolApprovalResult>;

    /** 把历史消息转换为本轮实际发送给 Provider 的副本
     * @note assistant 媒体统一写 [media:<contentHash>] 标记；当前轮的 tool 媒体转成 synthetic user 消息
     */
    prepareMessages: (messages: readonly Message[]) => Promise<readonly Message[]>;

    /** 解析本轮消息中的附件
     * @note 当前轮附件缺失视为失败；历史附件缺失会放入 missing，由 RunEngine 降级为文本占位符。
     */
    resolveAttachments: (messages: readonly Message[]) => Promise<AttachmentResolution>;

    /** 把 Provider 输出媒体落盘；无 AttachmentFileManager 时抛错 */
    ingestAttachments: (
        attachments: readonly PendingAttachment[],
        signal: AbortSignal,
    ) => Promise<readonly IngestedAttachment[]>;
}

export class RunEngine{

    /** 会话消息列表 */
    _messages(ctx: RunContext){
        return [...ctx.snapshot, ...ctx.run.pendingMessages];
    }


    /** 单次模型调用；返回本轮助手消息 */
    private async _turn(ctx: RunContext, tools: readonly ToolDefinition[]): Promise<AssistantMessage>{
        const { emit } = ctx;

        let thinkingAccum = "";
        let isThinkingState = true;
        let thinkingOverEmitted = false;
        const streamedAttachments: PendingAttachment[] = [];

        const _onToken = (token: MessageContent, isThinking: boolean) => {
            const text = this._tokenToText(token);
            if (isThinking) {
                thinkingAccum += text;
            }
            if (isThinkingState && !isThinking) {
                isThinkingState = false;
                thinkingOverEmitted = true;
                emit({
                    type: SessionEventType.ASSISTANT_THINKING_OVER,
                    thinking: thinkingAccum,
                });
            }
            emit({
                type: SessionEventType.ASSISTANT_TOKEN,
                token: text,
                isThinking,
            });
        }

        const _onAttachment = (attachment: PendingAttachment) => {
            streamedAttachments.push(attachment);
        };

        // 附件解析必须发生在 Adapter 转换之前；Adapter 本身不访问 IFileHost。
        // prepareMessages 负责按回放策略裁剪历史媒体，再只解析真正会发送的附件。
        const preparedMessages = await ctx.prepareMessages(this._messages(ctx));
        const resolution = await ctx.resolveAttachments(preparedMessages);
        const messages = resolution.missing.size === 0
            ? preparedMessages
            : degradeMissingAttachments(preparedMessages, resolution.missing);

        emit({ type: SessionEventType.ASSISTANT_START });

        const runtimeOptions = ctx.enableThinking
            ? ctx.runtimeOptions
            : withoutThinkingOptions(ctx.runtimeOptions);
        const chatResult = await ctx.provider.chat(messages, runtimeOptions, {
            onToken: _onToken,
            onAttachment: _onAttachment,
            signal: ctx.signal,
            tools: tools.length > 0 ? [...tools] : undefined,
            ...(resolution.attachmentRefs === undefined
                ? {}
                : { attachmentRefs: resolution.attachmentRefs }),
        });

        // 兜底：如果模型全程思考没有输出，手动触发思考结束事件
        if (!thinkingOverEmitted){
            emit({
                type: SessionEventType.ASSISTANT_THINKING_OVER,
                thinking: thinkingAccum,
            });
        }

        let outputMsg = chatResult.message;

        if (outputMsg.failureReason !== undefined){
            throw new SessionError(
                SessionErrorType.ProviderError,
                `Provider returned a failed assistant message: ${outputMsg.failureReason}`,
                outputMsg.failureReason,
            );
        }

        // 合并所有附件进行去重，同时将流式附件的pendingAttachments落盘至ingestor
        const pendingAttachments = mergePendingAttachments([
            ...streamedAttachments,
            ...(chatResult.attachments ?? []),
        ]);

        if (pendingAttachments.length > 0){
            const ingested = await ctx.ingestAttachments(pendingAttachments, ctx.signal);
            if (ingested.length > 0){
                outputMsg = this._appendAttachments(
                    outputMsg,
                    ingested.map((item) => item.ref),
                );
                for (const item of ingested){
                    emit({
                        type: SessionEventType.ASSISTANT_ATTACHMENT,
                        attachment: item.ref,
                        name: item.attachment.name,
                        mimeType: item.attachment.mimeType,
                    });
                }
            }
        }

        ctx.run.appendMessage(outputMsg);
        emit({
            type: SessionEventType.ASSISTANT_COMPLETE_TURN,
            msg: outputMsg.content,
            usage: outputMsg.usage,
        });

        return outputMsg;
    }

    /** 把已落盘的附件引用追加到助手消息内容末尾 */
    private _appendAttachments(
        message: AssistantMessage,
        refs: readonly AttachmentRef[],
    ): AssistantMessage{
        if (refs.length === 0) return message;

        const content = appendAttachmentRefs(message.content, refs);
        const parts: ContentPart[] = typeof content === "string"
            ? (content.length > 0 ? [{ type: "text", text: content }] : [])
            : content.map((part) => ({ ...part }));

        return new AssistantMessage(
            parts,
            message.isCompressed,
            message.thinking,
            message.usage,
            [...message.toolCalls],
            message.stopReason,
            message.failureReason,
        );
    }

    /** 推进一次运行：对话 -> 工具调用循环 -> 最终输出 */
    async _run(ctx: RunContext){
        if (ctx.signal.aborted) return;

        let lastAssistant: AssistantMessage | undefined;

        try{
            const tools = await this._resolveTools(ctx);

            while (ctx.signal.aborted === false){
                // 步数上限：防止工具调用死循环
                if (ctx.run.step >= ctx.maxSteps) break;

                ctx.run.nextStep();
                const assistantMsg = await this._turn(ctx, tools);
                lastAssistant = assistantMsg;

                if (!assistantMsg.hasToolCall) break;

                await this._runTools(ctx, tools, assistantMsg.toolCalls);
            }
        }finally{
            ctx.emit({
                type: SessionEventType.ASSISTANT_COMPLETE,
                msg: lastAssistant?.content ?? "",
                usage: ctx.run.pendingUsage,
            });
        }
    }

    /** 取本次运行的工具快照；工具集在整轮运行内保持稳定 */
    private async _resolveTools(ctx: RunContext): Promise<ToolDefinition[]>{
        const tools: ToolDefinition[] = ctx.tools === undefined
            ? []
            : await ctx.tools.listTools(ctx.signal);

        if (tools.length > 0 && !ctx.provider.supportsTools){
            throw new SessionError(
                SessionErrorType.MissingTools,
                "The current LLM provider does not support tool calls",
            );
        }

        // 模型明确声明 tools:false 时保持纯对话，也不注入 host 工具。
        if (!ctx.enableTools) return [];

        // host 工具本身依赖工具调用能力；不支持工具的 Provider 保持纯对话
        const names = new Set(tools.map((tool) => tool.name));
        const hostTools: readonly ToolDefinition[] = [
            ...(ctx.enableUserInput ? HOST_TOOL_DEFINITIONS : []),
            ...(ctx.enableViewMedia ? [VIEW_MEDIA_TOOL_DEFINITION] : []),
        ];
        for (const hostTool of hostTools){
            if (names.has(hostTool.name)) continue;
            names.add(hostTool.name);
            tools.push(hostTool);
        }

        return tools;
    }

    /** 执行一轮助手消息中的工具调用
     * @note 并发策略属于 AgentLoop 的职责，Registry 只负责工具范围
     * @note approval 模式下只要本批存在需要审批的调用，就退化为顺序执行，保证同一时刻只有一个审批
     */
    private async _runTools(
        ctx: RunContext,
        tools: readonly ToolDefinition[],
        calls: readonly ToolCall[],
    ): Promise<void>{
        const toolkit = ctx.tools;
        if (calls.length === 0) return;

        const definitions = calls.map(
            (call) => tools.find((item) => item.name === call.name) ?? null,
        );

        // 只有 approval 模式下审批类工具才会真正暂停；full 模式可以并行
        const willAskApproval = ctx.permission === SessionPermission.Approval
            && definitions.some(
                (definition) => definition?.annotations?.requiresApproval === true,
            );

        // 只有并发安全的工具才支持并发执行
        const allConcurrencySafe = definitions.every(
            (definition) => definition?.annotations?.concurrencySafe === true,
        );

        if (toolkit !== undefined
            && !willAskApproval
            && calls.length > 1
            && ctx.toolConcurrency > 1
            && allConcurrencySafe){
            await this._runToolsConcurrently(ctx, toolkit, calls, definitions);
            return;
        }

        await this._runToolsSequentially(ctx, toolkit, calls, definitions);
    }

    /** 顺序执行一批工具调用 */
    private async _runToolsSequentially(
        ctx: RunContext,
        toolkit: ToolSource | undefined,
        calls: readonly ToolCall[],
        definitions: readonly (ToolDefinition | null)[],
    ): Promise<void>{
        for (const [index, call] of calls.entries()){
            let result = await this._invokeTool(ctx, toolkit, call, definitions[index] ?? null);
            if (result === null) return;

            result = await this._ingestToolAttachments(ctx, call, result);

            // 无论成功失败都物化成 ToolMessage，保证 call/result 成对
            ctx.run.appendMessage(tool(result, call.name, call.id));
            ctx.emit({ type: SessionEventType.TOOL_CALL_END, call, result });
        }
    }

    /** 在并发上限内执行一批并发安全的工具调用
     * @note 结果按调用顺序物化，保证历史可重放
     */
    private async _runToolsConcurrently(
        ctx: RunContext,
        toolkit: ToolSource,
        calls: readonly ToolCall[],
        definitions: readonly (ToolDefinition | null)[],
    ): Promise<void>{
        const results: (ToolCallResult | undefined)[] = new Array(calls.length).fill(undefined);
        let cursor = 0;

        const worker = async (): Promise<void> => {
            while (ctx.signal.aborted === false){
                const index = cursor;
                cursor += 1;
                if (index >= calls.length) return;

                const call = calls[index];
                const startedAt = Date.now();
                ctx.emit({ type: SessionEventType.TOOL_CALL_START, call });
                results[index] = await toolkit.invoke(call, {
                    signal: ctx.signal,
                    timeoutMs: resolveToolTimeout(definitions[index] ?? null),
                    progressToken: call.id,
                    onProgress: this._createProgressHandler(ctx, call, startedAt),
                });
            }
        };

        const workerCount = Math.min(ctx.toolConcurrency, calls.length);
        const settled = await Promise.allSettled(
            Array.from({ length: workerCount }, () => worker()),
        );

        const failure = settled.find((item) => item.status === "rejected");
        if (failure !== undefined && failure.status === "rejected") throw failure.reason;

        for (const [index, call] of calls.entries()){
            const rawResult = results[index];
            if (rawResult === undefined) continue;

            const result = await this._ingestToolAttachments(ctx, call, rawResult);
            ctx.run.appendMessage(tool(result, call.name, call.id));
            ctx.emit({ type: SessionEventType.TOOL_CALL_END, call, result });
        }
    }

    /** 把工具产出的媒体落盘为 AttachmentRef，并追加到工具结果内容
     * @note 落盘失败按“工具调用失败”处理，不终止整轮运行。
     */
    private async _ingestToolAttachments(
        ctx: RunContext,
        call: ToolCall,
        result: ToolCallResult,
    ): Promise<ToolCallResult>{
        const pending = result.attachments;
        if (pending === undefined || pending.length === 0) return result;
        if (!result.status.isSuccess) return { ...result, attachments: undefined };

        try{
            const ingested = await ctx.ingestAttachments(pending, ctx.signal);
            if (ingested.length === 0) return { ...result, attachments: undefined };

            const content = appendAttachmentRefs(
                result.content,
                ingested.map((item) => item.ref),
            );

            for (const item of ingested){
                ctx.emit({
                    type: SessionEventType.TOOL_ATTACHMENT,
                    call,
                    attachment: item.ref,
                    name: item.attachment.name,
                    mimeType: item.attachment.mimeType,
                });
            }

            return { ...result, content, attachments: undefined };
        }catch(error){
            if (ctx.signal.aborted) throw error;

            const detail = error instanceof Error ? error.message : String(error);
            const original = typeof result.content === "string" ? result.content : "";
            const message = original.length > 0
                ? `${original}\n\nTool media ingestion failed: ${detail}`
                : `Tool media ingestion failed: ${detail}`;

            return toolErrorResult(new ToolError(
                ToolErrorType.ProviderError,
                false,
                message,
                error,
            ));
        }
    }

    /** 执行单个工具调用（含审批）
     * @returns 工具结果；null 表示运行已取消
     */
    private async _invokeTool(
        ctx: RunContext,
        toolkit: ToolSource | undefined,
        call: ToolCall,
        definition: ToolDefinition | null,
    ): Promise<ToolCallResult | null>{
        if (ctx.signal.aborted) return null;

        ctx.emit({ type: SessionEventType.TOOL_CALL_START, call });

        // host 内置工具：人工输入（不经过 ToolRegistry）
        if (ctx.enableUserInput && ctx.provider.supportsTools && call.name === ASK_USER_TOOL_NAME){
            return applyHostTrust(
                await this._askUser(ctx, call),
                ASK_USER_TOOL_DEFINITION.defaultTrust,
            );
        }

        // host 内置工具：回看当前会话中 assistant 生成过的媒体
        if (ctx.enableViewMedia && call.name === VIEW_MEDIA_TOOL_NAME){
            return applyHostTrust(
                await this._viewMedia(ctx, call),
                VIEW_MEDIA_TOOL_DEFINITION.defaultTrust,
            );
        }

        if (toolkit === undefined){
            throw new SessionError(
                SessionErrorType.MissingTools,
                "Model requested tools but no tool source was provided for this run",
            );
        }

        const annotations = definition?.annotations;
        const readOnly = annotations?.readOnlyHint === true;
        const requiresApproval = annotations?.requiresApproval === true;

        // 只读模式：只允许只读工具，其余直接拒绝
        if (ctx.permission === SessionPermission.ReadOnly && !readOnly){
            return deniedByPermissionResult(call, ctx.permission);
        }

        // 审批模式：审批类工具先暂停等待人工决定
        if (ctx.permission === SessionPermission.Approval && requiresApproval){
            const decision = await ctx.requestApproval({ call, tool: definition });

            // 取消也物化成结果，保证 TOOL_CALL_START / TOOL_CALL_END 成对
            if (decision === "abort" || ctx.signal.aborted) return abortedResult(call);
            if (decision === "deny") return deniedResult(call);
        }

        // 完全权限：审批类/破坏性工具直接放行，但发出危险警告
        if (ctx.permission === SessionPermission.Full
            && (requiresApproval || annotations?.destructiveHint === true)){
            ctx.emit({
                type: SessionEventType.TOOL_PERMISSION_WARNING,
                call,
                tool: definition,
                message: `Executing "${call.name}" without approval in full permission mode`,
            });
        }

        const startedAt = Date.now();
        return await toolkit.invoke(call, {
            signal: ctx.signal,
            timeoutMs: resolveToolTimeout(definition),
            progressToken: call.id,
            onProgress: this._createProgressHandler(ctx, call, startedAt),
        });
    }

    /** 处理 host__ask_user：暂停等待用户作答 */
    private async _askUser(ctx: RunContext, call: ToolCall): Promise<ToolCallResult>{
        const startedAt = Date.now();
        const parsed = parseUserInputRequest(call);
        if (!parsed.ok){
            return toolErrorResult(new ToolError(
                ToolErrorType.InvalidParams,
                false,
                `Invalid ask_user parameters: ${parsed.message}`,
            ));
        }

        const result = await ctx.requestUserInput(parsed.request, call);
        const duration = Math.max(0, Math.round(performance.now() - startedAt));

        if (result.cancelled === true){
            return {
                content: "User cancelled the input request",
                status: {
                    isSuccess: false,
                    error: new ToolError(
                        ToolErrorType.Denied,
                        false,
                        "User cancelled the input request",
                    ),
                    duration,
                },
                structuredContent: {
                    requestId: parsed.request.id,
                    answers: [],
                    cancelled: true,
                },
            };
        }

        return {
            content: formatUserInputResult(parsed.request, result),
            status: {
                isSuccess: true,
                duration,
            },
            structuredContent: {
                requestId: parsed.request.id,
                answers: result.answers,
            },
        };
    }

    /** 处理 host__view_media：把 assistant 历史媒体重新作为工具结果返回
     * @note 只允许当前会话 assistant 消息中出现过的 contentHash
     */
    private async _viewMedia(ctx: RunContext, call: ToolCall): Promise<ToolCallResult>{
        const startedAt = performance.now();
        const rawHash = call.params.contentHash;
        if (typeof rawHash !== "string" || !isContentHash(rawHash)){
            return toolErrorResult(new ToolError(
                ToolErrorType.InvalidParams,
                false,
                "Invalid view_media parameters: contentHash must be a 64-character lowercase hex string",
            ));
        }

        const messages = [...ctx.snapshot, ...ctx.run.pendingMessages];
        const allowed = messages.some((message) => {
            if (!(message instanceof AssistantMessage)) return false;
            if (typeof message.content === "string") return false;
            return message.content.some(
                (part) => part.type === "attachment"
                    && part.attachment.contentHash === rawHash,
            );
        });

        if (!allowed){
            return toolErrorResult(new ToolError(
                ToolErrorType.InvalidParams,
                false,
                `Media ${rawHash} is not an assistant-generated attachment in this session`,
            ));
        }

        // 只允许当前模型确实能接收的媒体模态；避免把音频/视频塞给纯视觉模型
        const modality = await ctx.resolveMediaModality(rawHash);
        if (modality === undefined){
            return toolErrorResult(new ToolError(
                ToolErrorType.InvalidParams,
                false,
                `Media ${rawHash} is not a supported image, audio or video attachment`,
            ));
        }
        if (!ctx.selfViewableModalities.includes(modality)){
            return toolErrorResult(new ToolError(
                ToolErrorType.InvalidParams,
                false,
                `The current model cannot receive ${modality} media`,
            ));
        }

        const duration = Math.max(0, Math.round(performance.now() - startedAt));
        return {
            content: [
                { type: "text", text: `Assistant media ${rawHash} is attached below.` },
                { type: "attachment", attachment: { contentHash: rawHash } },
            ],
            status: {
                isSuccess: true,
                duration,
            },
            structuredContent: {
                contentHash: rawHash,
            },
        };
    }

    /** 生成进度回调：先存储最新值，超过延迟阈值再向前端发事件 */
    private _createProgressHandler(
        ctx: RunContext,
        call: ToolCall,
        startedAt: number,
    ): (progress: ToolProgress) => void{
        return (progress) => {
            const normalized: ToolProgress = { ...progress, callId: call.id };
            ctx.run.setToolProgress(normalized);

            if (Date.now() - startedAt >= ctx.toolProgressDelayMs){
                ctx.emit({
                    type: SessionEventType.TOOL_PROGRESS,
                    call,
                    progress: normalized,
                });
            }
        };
    }

    /** 取消运行；当前阶段只依赖外部 AbortSignal */
    _cancel(){
    }

    private _tokenToText(token: MessageContent): string{
        if (typeof token === "string") return token;
        return token
            .map(part => part.type === "text" ? part.text : "")
            .join("");
    }
}


/** 会话运行时环境 */
export class Session{

    private readonly _runEngine: RunEngine;
    private readonly _listeners = new Set<SessionEventListener>();

    private _runtimeOptions: SessionRuntimeOptions;
    private _currentSession?: SessionHistory;
    private _provider?: ChatProvider;
    private _attachmentManager?: AttachmentFileManager;
    private _attachmentIngestor?: AttachmentIngestor;

    /** 当前会话的运行期附件映射；只在内存中存在，不进入 SessionData */
    private _attachmentRefs: AttachmentWireMap = new Map();

    private _activeRun: Run | null = null;
    private _abortController: AbortController | null = null;

    /** 等待人工审批的调用；同一时刻最多一个 */
    private _approval: {
        request: ToolApprovalRequest;
        resolve: (result: ToolApprovalResult) => void;
    } | null = null;

    /** 等待人工输入的表单；同一时刻最多一个 */
    private _userInput: {
        request: UserInputRequest;
        resolve: (result: UserInputResult) => void;
    } | null = null;

    constructor(
        provider?: ChatProvider,
        history?: SessionHistory,
        options: SessionRuntimeOptions = {},
        attachmentManager?: AttachmentFileManager,
    ){
        this._provider = provider;
        this._currentSession = history;
        this._runtimeOptions = { ...options };
        this._attachmentManager = attachmentManager;
        this._attachmentIngestor = attachmentManager === undefined
            ? undefined
            : new AttachmentIngestor(attachmentManager);
        this._runEngine = new RunEngine();
    }

    /** 当前会话数据 */
    get history(): SessionHistory | undefined{ return this._currentSession; }

    /** 当前绑定的对话 Provider */
    get provider(): ChatProvider | undefined{ return this._provider; }

    /** 当前运行时选项；返回副本，避免外部修改内部状态 */
    get runtimeOptions(): SessionRuntimeOptions{ return { ...this._runtimeOptions }; }

    /** 当前附件管理器；undefined 表示不支持附件 */
    get attachmentManager(): AttachmentFileManager | undefined{ return this._attachmentManager; }

    /** 当前会话的附件映射；返回副本，避免外部修改内部状态 */
    get attachmentRefs(): AttachmentWireMap{ return new Map(this._attachmentRefs); }

    /** 当前活动 Run；null 表示空闲 */
    get activeRun(): Run | null{ return this._activeRun; }

    /** 是否正在运行 */
    get isBusy(): boolean{ return this._activeRun !== null; }

    /** 当前待审批的工具调用；null 表示没有 */
    get pendingApproval(): ToolApprovalRequest | null{
        return this._approval?.request ?? null;
    }

    /** 获取当前运行中某次工具调用的最新进度 */
    getToolProgress(callId: string): ToolProgress | undefined{
        return this._activeRun?.getToolProgress(callId);
    }

    /** 当前待填写的人工输入表单；null 表示没有 */
    get pendingUserInput(): UserInputRequest | null{
        return this._userInput?.request ?? null;
    }

    /** 会话状态由 activeRun/RunStatus 派生，不单独保存一份状态 */
    get state(): SessionState{
        const run = this._activeRun;
        if (run === null) return SessionState.Idle;

        switch (run.status){
            case RunStatus.Paused:
                return SessionState.Pause;
            case RunStatus.Aborting:
            case RunStatus.Canceled:
                return SessionState.Cancel;
            case RunStatus.Failed:
                return SessionState.Interrupt;
            default:
                return SessionState.Run;
        }
    }

    /** 订阅会话事件；返回取消订阅函数 */
    subscribe(listener: SessionEventListener): () => void{
        this._listeners.add(listener);
        return () => {
            this._listeners.delete(listener);
        };
    }

    /** 切换模型；运行中不允许切换 */
    switchModel(model: string): void{
        this._assertIdle("switch model");
        this._runtimeOptions = { ...this._runtimeOptions, model };
    }

    /** 设置对话 Provider；运行中不允许切换
     * @note Session 只接受同时实现 ChatCapability 的 AIProvider；
     *       纯生图/生视频/决策 Provider 由独立运行时消费。
     * @note 远端附件表示与 Provider 绑定，切换时必须丢弃旧映射
     */
    setProvider(provider: AIProvider): void{
        this._assertIdle("switch AI provider");
        if (!isChatProvider(provider)){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "The selected AIProvider does not support chat",
            );
        }
        this._provider = provider;
        this._attachmentRefs = new Map();
    }

    /** 设置附件管理器；运行中不允许切换
     * @note 管理器应与当前历史中的附件指纹兼容；切换会话时由调用方保证
     */
    setAttachmentManager(attachmentManager: AttachmentFileManager | undefined): void{
        this._assertIdle("switch attachment manager");
        this._attachmentManager = attachmentManager;
        this._attachmentIngestor = attachmentManager === undefined
            ? undefined
            : new AttachmentIngestor(attachmentManager);
        this._attachmentRefs = new Map();
    }

    /** 切换当前会话；运行中不允许切换 */
    changeSession(history: SessionHistory): void{
        this._assertIdle("change session");
        this._currentSession = history;
        this._attachmentRefs = new Map();
    }

    /** 取消当前运行（暂停等待审批时同样有效） */
    cancel(): void{
        if (this._activeRun === null || this._abortController === null) return;
        if (this._abortController.signal.aborted) return;

        const pending = this._takeApproval();
        const pendingInput = this._userInput;
        this._userInput = null;

        this._activeRun.markAborting();
        this._emit({ type: SessionEventType.STATE_CHANGE, state: this.state });
        this._emit({ type: SessionEventType.USER_ABORT });
        this._abortController.abort();
        pending?.resolve("abort");
        pendingInput?.resolve({
            requestId: pendingInput.request.id,
            answers: [],
            cancelled: true,
        });
    }

    /** 提交审批结果并恢复被暂停的运行
     * @param decision approve 继续执行；deny 把拒绝作为工具结果回灌模型
     * @returns 是否成功恢复
     */
    resume(decision: ToolApprovalDecision): boolean{
        if (decision !== "approve" && decision !== "deny") return false;

        const pending = this._takeApproval();
        const run = this._activeRun;
        if (pending === null || run === null) return false;

        run.resume();
        this._emit({ type: SessionEventType.STATE_CHANGE, state: this.state });
        pending.resolve(decision);
        return true;
    }

    /** 提交人工输入结果并恢复运行
     * @returns 无待处理表单、requestId 不匹配或答案非法时返回 false
     */
    respondUserInput(result: UserInputResult): boolean{
        const pending = this._userInput;
        if (pending === null) return false;
        if (result.requestId !== pending.request.id) return false;

        if (result.cancelled !== true){
            const problems = validateUserInputResult(pending.request, result);
            if (problems.length > 0) return false;
        }

        this._userInput = null;
        this._activeRun?.resume();
        this._emit({ type: SessionEventType.STATE_CHANGE, state: this.state });
        pending.resolve(result);
        return true;
    }

    /**
     * 执行一次对话。
     *
     * 流程：对话 -> 工具调用循环 -> 最终输出。
     * 工具集由调用方通过 options.tools 传入，并在整轮运行内保持稳定；
     * 成功时才把 run.pendingMessages 提交到 SessionHistory；
     * 失败或取消时直接丢弃 pending，历史保持干净。
     *
     * @param input 用户输入
     * @param options 运行选项（工具集、最大轮数、并发与权限）
     */
    async run(input: MessageContent, options: RunOptions = {}): Promise<Run>{
        if (this._activeRun !== null){
            throw new SessionError(SessionErrorType.Busy, "Session is already running");
        }
        if (this._currentSession === undefined){
            throw new SessionError(SessionErrorType.MissingSession, "Session history is not set");
        }
        if (this._provider === undefined){
            throw new SessionError(
                SessionErrorType.MissingProvider,
                "AIProvider is not set or does not support chat",
            );
        }

        const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
        if (!Number.isInteger(maxSteps) || maxSteps < 1){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                `maxSteps must be a positive integer, got ${String(options.maxSteps)}`,
            );
        }

        const toolConcurrency = options.toolConcurrency ?? DEFAULT_TOOL_CONCURRENCY;
        if (!Number.isInteger(toolConcurrency) || toolConcurrency < 1){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                `toolConcurrency must be a positive integer, got ${String(options.toolConcurrency)}`,
            );
        }

        const permission = options.permission ?? DEFAULT_SESSION_PERMISSION;
        if (permission !== SessionPermission.ReadOnly
            && permission !== SessionPermission.Approval
            && permission !== SessionPermission.Full){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                `permission must be "readonly", "approval" or "full", got ${String(options.permission)}`,
            );
        }

        const toolProgressDelayMs = options.toolProgressDelayMs ?? DEFAULT_TOOL_PROGRESS_DELAY_MS;
        if (!Number.isFinite(toolProgressDelayMs) || toolProgressDelayMs < 0){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                `toolProgressDelayMs must be a non-negative number, got ${String(options.toolProgressDelayMs)}`,
            );
        }

        const enableUserInput = options.enableUserInput ?? true;
        if (typeof enableUserInput !== "boolean"){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                `enableUserInput must be a boolean, got ${String(options.enableUserInput)}`,
            );
        }

        const history = this._currentSession;
        const provider = this._provider;
        await this._ensureRuntimeModel(provider);
        await this._ensureModelCatalog(provider, this._runtimeOptions.model);

        // 模型能力只读取已加载的模型列表或宿主覆盖数据；失败时退化为 Provider 级判断
        let modelInfo: ModelInfo | undefined;
        try{
            modelInfo = await provider.resolveModelInfo(this._runtimeOptions.model);
        }catch{
            modelInfo = undefined;
        }

        let modelCapabilities: ModelCapabilities | undefined = modelInfo?.capabilities;
        if (modelCapabilities === undefined){
            try{
                modelCapabilities = await provider.resolveModelCapabilities(this._runtimeOptions.model);
            }catch{
                modelCapabilities = undefined;
            }
        }

        // viewableModalities 表示模型可接受的媒体输入；selfViewableModalities 表示
        // 模型自己的产出可以回放（输入 ∩ 输出）。工具媒体只使用前者。
        const inputModalities = modelCapabilities?.chat?.input ?? [];
        const outputModalities = modelCapabilities?.chat?.output ?? [];
        const viewableModalities: ModelModality[] = inputModalities.filter(
            (modality): modality is ModelModality => modality !== "text" && modality !== "structured",
        );
        const selfViewableModalities = viewableModalities.filter(
            (modality) => outputModalities.includes(modality),
        );
        // 模型级门禁：模型明确声明 tools:false / thinking:false 时不再下发对应能力。
        // 模型能力未知（undefined）时保持 Provider 级旧行为。
        const modelChatCapabilities = modelCapabilities?.chat;
        const enableTools = provider.supportsTools
            && modelChatCapabilities?.tools !== false;
        const enableThinking = modelChatCapabilities?.thinking !== false;
        const enableViewMedia = enableTools && selfViewableModalities.length > 0;
        const snapshot = history.snapshot();

        const inputMessage = user(input);

        const run = new Run(history.id);
        const abortController = new AbortController();

        this._activeRun = run;
        this._abortController = abortController;

        run.appendMessage(inputMessage);
        this._emit({ type: SessionEventType.STATE_CHANGE, state: this.state });
        this._emit({ type: SessionEventType.USER_INPUT, msg: input });

        const ctx: RunContext = {
            snapshot,
            run,
            runtimeOptions: this._runtimeOptions,
            emit: (event) => this._emit(event),
            provider,
            signal: abortController.signal,
            tools: options.tools,
            maxSteps,
            toolConcurrency,
            permission,
            enableTools,
            enableThinking,
            toolProgressDelayMs,
            enableUserInput,
            enableViewMedia,
            viewableModalities,
            selfViewableModalities,
            resolveMediaModality: (contentHash) => this._resolveMediaModality(contentHash),
            requestUserInput: (request, call) => this._requestUserInput(request, call),
            requestApproval: (request) => this._requestApproval(request),
            prepareMessages: async (messages) =>
                prepareProviderMessages(
                    messages,
                    snapshot.length,
                    viewableModalities,
                    (contentHash) => this._resolveMediaModality(contentHash),
                ),
            resolveAttachments: (messages) => this._resolveAttachments(
                messages,
                new Set(collectAttachmentHashes(run.pendingMessages)),
                provider,
                abortController.signal,
                modelCapabilities,
                modelInfo,
            ),
            ingestAttachments: (attachments, signal) => this._ingestAttachments(
                attachments,
                signal,
            ),
        };

        try{
            await this._runEngine._run(ctx);

            // abort 可能在模型返回后才到达；此时不得提交
            if (abortController.signal.aborted){
                run.cancel();
                return run;
            }

            // 提交是原子的；校验失败会 throw，并且不会写入任何消息
            history.commitMessages(run.pendingMessages);

            const last = run.pendingMessages[run.pendingMessages.length - 1];
            run.complete(last instanceof AssistantMessage ? last.stopReason : undefined);
            return run;
        }catch(error){
            if (abortController.signal.aborted){
                run.cancel();
            }else{
                run.fail(error);
                this._emit({
                    type: SessionEventType.ERROR,
                    msg: errorMessage(error),
                });
            }
            return run;
        }finally{
            // 运行结束时不留下悬空的审批 Promise
            const pending = this._takeApproval();
            pending?.resolve("abort");

            const pendingInput = this._userInput;
            this._userInput = null;
            pendingInput?.resolve({
                requestId: pendingInput.request.id,
                answers: [],
                cancelled: true,
            });

            if (this._activeRun === run){
                this._activeRun = null;
            }
            this._abortController = null;
            this._emit({ type: SessionEventType.STATE_CHANGE, state: this.state });
        }
    }

    /** 把 Provider 输出的媒体落盘为 AttachmentRef */
    private async _ingestAttachments(
        attachments: readonly PendingAttachment[],
        signal: AbortSignal,
    ): Promise<readonly IngestedAttachment[]>{
        if (this._attachmentIngestor === undefined){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "Generated media requires an AttachmentFileManager",
            );
        }

        const ingested: IngestedAttachment[] = [];
        for (const attachment of attachments){
            if (signal.aborted){
                throw new SessionError(
                    SessionErrorType.InvalidRequest,
                    "Attachment ingestion was aborted",
                );
            }

            const ref = await this._attachmentIngestor.ingest(attachment, { signal });
            ingested.push({ attachment, ref });
        }
        return ingested;
    }

    /** 解析本轮消息中的附件
     * @param messages 本轮发送给模型的消息（快照 + 待提交消息）
     * @param requiredHashes 当前轮必须可用的附件；缺失时直接失败
     * @param provider 当前对话 Provider
     * @param signal 取消信号
     * @param capabilities 当前模型的模型级能力；undefined 表示模型能力未知
     * @param modelInfo 当前模型的完整信息
     * @returns 可用附件映射与已降级的历史缺失附件
     */
    private async _resolveAttachments(
        messages: readonly Message[],
        requiredHashes: ReadonlySet<string>,
        provider: ChatProvider,
        signal: AbortSignal,
        capabilities: ModelCapabilities | undefined,
        modelInfo: ModelInfo | undefined,
    ): Promise<AttachmentResolution>{
        const contentHashes = new Set(collectAttachmentHashes(messages));
        if (contentHashes.size === 0){
            this._attachmentRefs = new Map();
            return { missing: new Set() };
        }

        const attachmentManager = this._attachmentManager;
        if (attachmentManager === undefined){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "Attachment content requires an AttachmentFileManager",
            );
        }

        const cloudFileManager = provider.cloudFileManager;
        if (!provider.supportsAttachmentInput || cloudFileManager === null){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "The current LLM provider does not support attachments",
            );
        }

        const model = this._runtimeOptions.model;
        const inputModalities = capabilities?.chat?.input;
        const modalityCounts = new Map<ModelModality, number>();
        const missing = new Set<string>();

        // 先构建新映射，成功后再替换；解析失败时不破坏上一轮的有效状态
        const attachmentRefs = new Map<string, RemoteFileRef>();

        for (const contentHash of contentHashes){
            if (signal.aborted){
                throw new SessionError(
                    SessionErrorType.InvalidRequest,
                    "Attachment resolution was aborted",
                );
            }

            const file = await attachmentManager.get(contentHash);
            if (file === undefined){
                // 当前轮附件缺失必须失败；历史附件缺失只降级，不阻塞会话继续。
                if (requiredHashes.has(contentHash)){
                    const meta = await attachmentManager.getMeta(contentHash).catch(() => undefined);
                    throw new AttachmentFileError(
                        AttachmentFileErrorCode.Missing,
                        `Attachment file is missing or corrupted: ${contentHash}`,
                        {
                            contentHash,
                            sourcePaths: meta?.sourcePaths,
                        },
                    );
                }

                missing.add(contentHash);
                continue;
            }

            const mimeType = file.mimeType ?? detectMediaMimeType(file.content);
            const modality = mediaModalityFromMimeType(mimeType);

            // 模型列表已加载时按模型模态拒绝媒体输入；非媒体附件交由具体 Provider 判断
            if (modality !== undefined){
                if (inputModalities !== undefined && !inputModalities.includes(modality)){
                    throw new SessionError(
                        SessionErrorType.UnsupportedInput,
                        `Model "${model ?? ""}" does not support ${modality} input`,
                    );
                }

                const limit = resolveMediaInputLimit(
                    provider.defaultModelLimits,
                    modelInfo?.limits,
                    modality,
                );
                const durationSeconds = limit?.maxDurationSeconds === undefined
                    ? undefined
                    : readMediaDuration(file.content, mimeType);
                const problems = validateMediaInputLimit({
                    mimeType,
                    size: file.size,
                    durationSeconds,
                }, limit);
                if (problems.length > 0){
                    const formatProblem = problems.some((problem) =>
                        problem.startsWith("unsupported MIME type")
                        || problem.startsWith("media duration could not be determined")
                        || problem.startsWith("invalid media duration"));
                    throw new SessionError(
                        formatProblem
                            ? SessionErrorType.UnsupportedMediaFormat
                            : SessionErrorType.InputLimitExceeded,
                        `Invalid ${modality} input "${file.name}": ${problems.join("; ")}`,
                    );
                }

                if (limit?.maxCount !== undefined){
                    const nextCount = (modalityCounts.get(modality) ?? 0) + 1;
                    if (nextCount > limit.maxCount){
                        throw new SessionError(
                            SessionErrorType.InputLimitExceeded,
                            `Too many ${modality} inputs: ${nextCount} (max ${limit.maxCount})`,
                        );
                    }
                }
                modalityCounts.set(modality, (modalityCounts.get(modality) ?? 0) + 1);
            }

            attachmentRefs.set(contentHash, await cloudFileManager.ensureFile(file, signal));
        }

        this._attachmentRefs = attachmentRefs;
        return {
            ...(attachmentRefs.size === 0 ? {} : { attachmentRefs }),
            missing,
        };
    }

    /** 解析附件的内容模态；附件缺失或不是媒体时返回 undefined */
    private async _resolveMediaModality(contentHash: string): Promise<ModelModality | undefined>{
        const manager = this._attachmentManager;
        if (manager === undefined) return undefined;

        const file = await manager.get(contentHash);
        if (file === undefined) return undefined;

        const mimeType = file.mimeType ?? detectMediaMimeType(file.content);
        return mediaModalityFromMimeType(mimeType);
    }

    /** 请求人工输入；由 RunEngine 在调用 host__ask_user 时调用 */
    private _requestUserInput(
        request: UserInputRequest,
        call: ToolCall,
    ): Promise<UserInputResult>{
        const run = this._activeRun;
        if (run === null || this._abortController?.signal.aborted === true){
            return Promise.resolve({
                requestId: request.id,
                answers: [],
                cancelled: true,
            });
        }

        return new Promise<UserInputResult>((resolve) => {
            this._userInput = { request, resolve };
            run.markPaused();
            this._emit({ type: SessionEventType.STATE_CHANGE, state: this.state });
            this._emit({
                type: SessionEventType.TOOL_INPUT_REQUIRED,
                call,
                request,
            });
        });
    }

    /** 请求人工审批；由 RunEngine 在工具调用前调用 */
    private _requestApproval(request: ToolApprovalRequest): Promise<ToolApprovalResult>{
        const run = this._activeRun;
        if (run === null || this._abortController?.signal.aborted === true){
            return Promise.resolve("abort");
        }

        return new Promise<ToolApprovalResult>((resolve) => {
            this._approval = { request, resolve };
            run.markPaused();
            this._emit({ type: SessionEventType.STATE_CHANGE, state: this.state });
            this._emit({
                type: SessionEventType.TOOL_APPROVAL_REQUIRED,
                call: request.call,
                tool: request.tool,
            });
        });
    }

    /** 取走当前审批，保证同一时间只有一个 */
    private _takeApproval(): {
        request: ToolApprovalRequest;
        resolve: (result: ToolApprovalResult) => void;
    } | null{
        const pending = this._approval;
        this._approval = null;
        return pending;
    }

    /** 未显式指定模型时，由 Provider 选择默认模型
     * @note 只补齐 model；think / thinkingLv 未设置时保持 Provider 默认
     */
    private async _ensureRuntimeModel(provider: ChatProvider): Promise<void>{
        const current = this._runtimeOptions.model;
        if (typeof current === "string" && current.length > 0) return;

        const model = await provider.resolveDefaultModel();
        if (model !== undefined && model.length > 0){
            this._runtimeOptions = { ...this._runtimeOptions, model };
        }
    }

    /** 模型目录未加载时自动初始化；宿主覆盖过的模型以覆盖数据为准
     * @note 初始化失败不抛出；后续按“模型能力未知”处理（不发送媒体输入）。
     */
    private async _ensureModelCatalog(
        provider: ChatProvider,
        model: string | undefined,
    ): Promise<void>{
        const modelProvider = provider.modelProvider;
        if (modelProvider === null || modelProvider.isModelsInitialized) return;
        if (model !== undefined && model.length > 0 && modelProvider.hasOverride(model)) return;

        try{
            await modelProvider.initModels();
        }catch{
            // 能力未知时退化为纯文本；不阻塞对话本身
        }
    }

    private _assertIdle(action: string): void{
        if (this._activeRun !== null){
            throw new SessionError(
                SessionErrorType.Busy,
                `Cannot ${action} while the session is running`,
            );
        }
    }

    private _emit(event: SessionEvent): void{
        for (const listener of [...this._listeners]){
            try{
                listener(event);
            }catch{
                // 监听器异常不能破坏 Session/Run 状态
            }
        }
    }
}

/** 合并流式与最终媒体；final 结果覆盖同 sourceId 的流式片段 */
function mergePendingAttachments(
    attachments: readonly PendingAttachment[],
): PendingAttachment[]{
    const merged = new Map<string, PendingAttachment>();
    let fallbackIndex = 0;

    for (const attachment of attachments){
        merged.set(pendingAttachmentKey(attachment, fallbackIndex++), attachment);
    }

    return [...merged.values()];
}

function pendingAttachmentKey(attachment: PendingAttachment, fallbackIndex: number): string{
    if (attachment.sourceId !== undefined && attachment.sourceId.length > 0){
        return `source:${attachment.sourceId}`;
    }

    switch (attachment.kind){
        case "url":
            return `url:${attachment.url}`;
        case "remote-id":
            return `remote-id:${attachment.id}`;
        case "bytes":
            // 没有 sourceId 时不能按大小/名称去重，否则同尺寸图片会被误合并
            return `bytes:${fallbackIndex}`;
    }
}

/** 合并 Provider 级默认限制与模型级限制；模型声明优先 */
function resolveMediaInputLimit(
    providerLimits: ModelLimits | undefined,
    modelLimits: ModelLimits | undefined,
    modality: ModelModality,
): MediaInputLimit | undefined{
    const base = providerLimits?.input?.[modality];
    const specific = modelLimits?.input?.[modality];
    if (base === undefined) return specific;
    if (specific === undefined) return base;
    return { ...base, ...specific };
}

/** 模型不支持思考时，不把 think / thinkingLv 传给 Provider */
function withoutThinkingOptions(options: SessionRuntimeOptions): SessionRuntimeOptions{
    const next = { ...options };
    delete next.think;
    delete next.thinkingLv;
    return next;
}

/** 计算工具调用超时：工具建议值优先，默认 30s，上限 1h */
function resolveToolTimeout(definition: ToolDefinition | null): number{
    const configured = definition?.adviceTimeout;
    if (configured === undefined || !Number.isFinite(configured) || configured <= 0){
        return DEFAULT_TOOL_TIMEOUT_MS;
    }
    return Math.min(Math.floor(configured), MAX_TOOL_TIMEOUT_MS);
}

/** 把工具错误包装成工具调用结果 */
function toolErrorResult(error: ToolError): ToolCallResult{
    return {
        content: error.message,
        status: {
            isSuccess: false,
            error,
            duration: 0,
        },
        structuredContent: undefined,
        raw: undefined,
    };
}

/** 审批被拒绝时返回的工具结果 */
function deniedResult(call: ToolCall): ToolCallResult{
    return toolErrorResult(
        new ToolError(
            ToolErrorType.Denied,
            false,
            `Tool call "${call.name}" was denied by the user`,
        ),
    );
}

/** 只读模式下拒绝非只读工具 */
function deniedByPermissionResult(call: ToolCall, permission: SessionPermission): ToolCallResult{
    return toolErrorResult(
        new ToolError(
            ToolErrorType.Denied,
            false,
            `Tool call "${call.name}" is not allowed while the session permission is "${permission}"`,
        ),
    );
}

/** 运行在审批阶段被取消时返回的工具结果 */
function abortedResult(call: ToolCall): ToolCallResult{
    return toolErrorResult(
        new ToolError(
            ToolErrorType.AbortError,
            false,
            `Tool call "${call.name}" was aborted`,
        ),
    );
}

/** 把历史消息中已缺失的附件降级为文本占位符
 * @note 当前轮附件缺失会在 resolveAttachments 阶段直接失败；这里只处理历史附件。
 *       同时移除紧随其后的 `[media:<hash>]` 标记，避免模型继续引用不存在的媒体。
 */
function degradeMissingAttachments(
    messages: readonly Message[],
    missing: ReadonlySet<string>,
): Message[]{
    return messages.map((message) => {
        if (typeof message.content === "string") return message;

        let changed = false;
        const parts: ContentPart[] = [];

        for (const part of message.content){
            if (part.type === "attachment" && missing.has(part.attachment.contentHash)){
                changed = true;
                parts.push({
                    type: "text",
                    text: `[attachment unavailable: ${part.attachment.contentHash}]`,
                });
                continue;
            }

            if (part.type === "text"){
                const markerHash = mediaMarkerHash(part.text);
                if (markerHash !== undefined && missing.has(markerHash)){
                    changed = true;
                    continue;
                }
            }

            parts.push(part);
        }

        if (!changed) return message;

        if (message instanceof AssistantMessage){
            return new AssistantMessage(
                parts,
                message.isCompressed,
                message.thinking,
                message.usage,
                [...message.toolCalls],
                message.stopReason,
                message.failureReason,
            );
        }
        if (message instanceof ToolMessage){
            return new ToolMessage(
                parts,
                message.toolName,
                message.callId,
                message.details,
                message.isCompressed,
            );
        }
        if (message instanceof UserMessage){
            return new UserMessage(parts, message.isCompressed);
        }

        return message;
    });
}

/** 从 `[media:<hash>]` 标记中取出 contentHash */
function mediaMarkerHash(text: string): string | undefined{
    const match = /^\[media:([a-f0-9]{64})\]$/.exec(text.trim());
    return match?.[1];
}

/** 构造本轮发送给 Provider 的消息副本
 *
 * - assistant 附件统一替换为 `[media:<contentHash>]`，让模型知道可回看；
 * - 当前轮的 tool 附件转成 synthetic user 消息（主流 chat 协议不接受 tool 媒体）；
 * - 历史 tool 附件剥离，避免每轮重复上传/发送。
 */
async function prepareProviderMessages(
    messages: readonly Message[],
    historyCount: number,
    viewableModalities: readonly ModelModality[],
    resolveMediaModality: (contentHash: string) => Promise<ModelModality | undefined>,
): Promise<Message[]>{
    const result: Message[] = [];
    let pendingMedia: string[] = [];
    const supportedModalities = new Set(viewableModalities);

    const flushToolMedia = async (): Promise<void> => {
        if (pendingMedia.length === 0) return;

        const hashes = [...new Set(pendingMedia)];
        pendingMedia = [];

        const parts: ContentPart[] = [];
        const omitted: string[] = [];

        for (const contentHash of hashes){
            if (supportedModalities.size === 0){
                omitted.push(`[tool media omitted: ${contentHash} (model does not accept media input)]`);
                continue;
            }

            const modality = await resolveMediaModality(contentHash);
            if (modality === undefined){
                omitted.push(`[tool media omitted: ${contentHash} (media unavailable)]`);
                continue;
            }
            if (!supportedModalities.has(modality)){
                omitted.push(`[tool media omitted: ${contentHash} (${modality} input not supported)]`);
                continue;
            }

            parts.push({ type: "attachment", attachment: { contentHash } });
        }

        const content: ContentPart[] = [];
        if (parts.length > 0){
            content.push({ type: "text", text: "Media returned by tool calls (attached below):" });
            content.push(...parts);
            content.push({
                type: "text",
                text: parts
                    .filter((part) => part.type === "attachment")
                    .map((part) => `[media:${part.attachment.contentHash}]`)
                    .join("\n"),
            });
        }
        if (omitted.length > 0){
            content.push({ type: "text", text: omitted.join("\n") });
        }
        if (content.length > 0){
            result.push(new UserMessage(content));
        }
    };

    for (const [index, message] of messages.entries()){
        const isPending = index >= historyCount;

        if (message instanceof ToolMessage){
            const prepared = prepareToolMessage(message, isPending);
            result.push(prepared.message);
            pendingMedia.push(...prepared.media);

            const next = messages[index + 1];
            if (!(next instanceof ToolMessage)) await flushToolMedia();
            continue;
        }

        await flushToolMedia();
        result.push(message instanceof AssistantMessage
            ? prepareAssistantMessage(message)
            : message instanceof UserMessage
                ? prepareUserMessage(message)
                : message);
    }

    await flushToolMedia();
    return result;
}

/** 用户附件在发送给模型时保留图片内容，并附带 contentHash 供工具引用 */
function prepareUserMessage(message: UserMessage): UserMessage{
    if (typeof message.content === "string") return message;
    if (!message.content.some((part) => part.type === "attachment")) return message;

    const parts: ContentPart[] = [];
    for (const part of message.content){
        parts.push(part);
        if (part.type === "attachment"){
            parts.push({ type: "text", text: `[media:${part.attachment.contentHash}]` });
        }
    }

    return new UserMessage(parts, message.isCompressed);
}

/** assistant 媒体在当前架构下只可能来自会话级媒体产出；统一写回 contentHash 标记 */
function prepareAssistantMessage(message: AssistantMessage): AssistantMessage{
    if (typeof message.content === "string") return message;
    if (!message.content.some((part) => part.type === "attachment")) return message;

    const parts: ContentPart[] = message.content.map((part) => part.type === "text"
        ? part
        : { type: "text" as const, text: `[media:${part.attachment.contentHash}]` });

    return new AssistantMessage(
        parts.length === 0 ? "" : parts,
        message.isCompressed,
        message.thinking,
        message.usage,
        [...message.toolCalls],
        message.stopReason,
        message.failureReason,
    );
}

/** 当前轮的 tool 媒体交给 synthetic user 消息；历史 tool 媒体直接剥离 */
function prepareToolMessage(
    message: ToolMessage,
    isPending: boolean,
): { message: ToolMessage; media: string[] }{
    if (typeof message.content === "string"){
        return { message, media: [] };
    }
    if (!message.content.some((part) => part.type === "attachment")){
        return { message, media: [] };
    }

    const parts: ContentPart[] = [];
    const media: string[] = [];

    for (const part of message.content){
        if (part.type === "text"){
            parts.push(part);
            continue;
        }
        if (isPending){
            media.push(part.attachment.contentHash);
        }else{
            parts.push({
                type: "text",
                text: `[tool media reference: ${part.attachment.contentHash}]`,
            });
        }
    }

    return {
        message: new ToolMessage(
            parts.length === 0 ? "" : parts,
            message.toolName,
            message.callId,
            message.details,
            message.isCompressed,
        ),
        media,
    };
}

/** 在消息内容末尾追加附件引用 */
function appendAttachmentRefs(
    content: MessageContent,
    refs: readonly AttachmentRef[],
): MessageContent{
    if (refs.length === 0) return content;

    const parts: ContentPart[] = typeof content === "string"
        ? (content.length > 0 ? [{ type: "text", text: content }] : [])
        : content.map((part) => ({ ...part }));

    for (const ref of refs){
        parts.push({ type: "attachment", attachment: { contentHash: ref.contentHash } });
    }
    return parts;
}

/** 为不经过 ToolRegistry 的 host 工具补充默认信任级别 */
function applyHostTrust(
    result: ToolCallResult,
    trust: ToolDefinition["defaultTrust"],
): ToolCallResult{
    return trust === undefined ? result : { ...result, trust };
}

function errorMessage(error: unknown): string{
    return error instanceof Error ? error.message : String(error);
}