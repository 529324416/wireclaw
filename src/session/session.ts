import { uniqueId } from "../base";
import { SessionError, SessionErrorType, ToolError, ToolErrorType } from "./error";
import type { AttachmentFileManager } from "./attachment-manager";
import { AttachmentIngestor } from "./attachment-ingestor";
import type { PendingAttachment } from "./media";
import { AssistantMessage, ToolMessage, tool, user } from "./message";
import type { Message } from "./message";
import { isChatProvider } from "./protocol";
import type { AIProvider, ChatProvider } from "./protocol";
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
    ASK_USER_TOOL_NAME,
    HOST_TOOL_DEFINITIONS,
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

    /** 工具进度事件延迟（毫秒） */
    toolProgressDelayMs: number;

    /** 是否启用 host 内置工具（ask_user） */
    enableUserInput: boolean;

    /** 请求人工输入；返回用户回答 */
    requestUserInput: (request: UserInputRequest, call: ToolCall) => Promise<UserInputResult>;

    /** 请求人工审批；返回 abort 表示运行已取消 */
    requestApproval: (request: ToolApprovalRequest) => Promise<ToolApprovalResult>;

    /** 解析本轮消息中的附件；无附件时返回 undefined
     * @note 由 Session 通过 IFileHost 和 CloudFileManager 实现，RunEngine 不感知附件细节
     */
    resolveAttachments: (messages: readonly Message[]) => Promise<AttachmentWireMap | undefined>;

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

        // 附件解析必须发生在 Adapter 转换之前；Adapter 本身不访问 IFileHost
        const messages = this._messages(ctx);
        const attachmentRefs = await ctx.resolveAttachments(messages);

        emit({ type: SessionEventType.ASSISTANT_START });

        const chatResult = await ctx.provider.chat(messages, ctx.runtimeOptions, {
            onToken: _onToken,
            onAttachment: _onAttachment,
            signal: ctx.signal,
            tools: tools.length > 0 ? [...tools] : undefined,
            ...(attachmentRefs === undefined ? {} : { attachmentRefs }),
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

        const parts: ContentPart[] = typeof message.content === "string"
            ? (message.content.length > 0 ? [{ type: "text", text: message.content }] : [])
            : message.content.map((part) => ({ ...part }));

        for (const ref of refs){
            parts.push({ type: "attachment", attachment: { contentHash: ref.contentHash } });
        }

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

        // host 工具本身依赖工具调用能力；不支持工具的 Provider 保持纯对话
        if (ctx.enableUserInput && ctx.provider.supportsTools){
            tools.push(...HOST_TOOL_DEFINITIONS);
        }

        if (tools.length > 0 && !ctx.provider.supportsTools){
            throw new SessionError(
                SessionErrorType.MissingTools,
                "The current LLM provider does not support tool calls",
            );
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
            const result = await this._invokeTool(ctx, toolkit, call, definitions[index] ?? null);
            if (result === null) return;

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
            const result = results[index];
            if (result === undefined) continue;

            ctx.run.appendMessage(tool(result, call.name, call.id));
            ctx.emit({ type: SessionEventType.TOOL_CALL_END, call, result });
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
            return await this._askUser(ctx, call);
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
        const inputMessage = user(input);

        const run = new Run(history.id);
        const abortController = new AbortController();

        this._activeRun = run;
        this._abortController = abortController;

        run.appendMessage(inputMessage);
        this._emit({ type: SessionEventType.STATE_CHANGE, state: this.state });
        this._emit({ type: SessionEventType.USER_INPUT, msg: input });

        const ctx: RunContext = {
            snapshot: history.snapshot(),
            run,
            runtimeOptions: this._runtimeOptions,
            emit: (event) => this._emit(event),
            provider,
            signal: abortController.signal,
            tools: options.tools,
            maxSteps,
            toolConcurrency,
            permission,
            toolProgressDelayMs,
            enableUserInput,
            requestUserInput: (request, call) => this._requestUserInput(request, call),
            requestApproval: (request) => this._requestApproval(request),
            resolveAttachments: (messages) => this._resolveAttachments(
                messages,
                provider,
                abortController.signal,
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
     * @param provider 当前对话 Provider
     * @param signal 取消信号
     * @returns 内容指纹到 Provider 附件表示的映射；无附件时返回 undefined
     */
    private async _resolveAttachments(
        messages: readonly Message[],
        provider: ChatProvider,
        signal: AbortSignal,
    ): Promise<AttachmentWireMap | undefined>{
        const contentHashes = collectAttachmentHashes(messages);
        if (contentHashes.size === 0){
            this._attachmentRefs = new Map();
            return undefined;
        }

        const attachmentManager = this._attachmentManager;
        if (attachmentManager === undefined){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "Attachment content requires an AttachmentFileManager",
            );
        }

        const cloudFileManager = provider.cloudFileManager;
        if (!provider.supportsAttachments || cloudFileManager === null){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                "The current LLM provider does not support attachments",
            );
        }

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
                throw new SessionError(
                    SessionErrorType.InvalidData,
                    `Attachment file is missing or corrupted: ${contentHash}; `
                        + "the session data cannot be fully restored",
                );
            }

            attachmentRefs.set(contentHash, await cloudFileManager.ensureFile(file, signal));
        }

        this._attachmentRefs = attachmentRefs;
        return attachmentRefs;
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

/** 收集消息内容中的唯一附件内容指纹 */
function collectAttachmentHashes(messages: readonly Message[]): Set<string>{
    const contentHashes = new Set<string>();

    for (const message of messages){
        if (typeof message.content === "string") continue;

        for (const part of message.content){
            if (part.type === "attachment"){
                contentHashes.add(part.attachment.contentHash);
            }
        }
    }

    return contentHashes;
}

function errorMessage(error: unknown): string{
    return error instanceof Error ? error.message : String(error);
}