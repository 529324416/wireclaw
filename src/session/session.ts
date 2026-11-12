import { uniqueId } from "../base";
import { SessionError, SessionErrorType } from "./error";
import { AssistantMessage, ToolMessage, tool, user } from "./message";
import type { Message } from "./message";
import type { LLMProvider } from "./protocol";
import {
    ChatRoleAssistant,
    SessionState,
    SessionEventType,
} from "./type";
import type {
    ChatStopReason,
    ChatUsage,
    MessageContent,
    SessionEventListener,
    SessionEvent,
    SessionRuntimeOptions,
    ToolCall,
    ToolDefinition,
} from "./type";
import type { ToolRegistry } from "./tool";

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

/** Session 在一次运行中需要的工具能力；ToolRegistry 天然满足该结构 */
export type ToolSource = Pick<ToolRegistry, "listTools" | "invoke">;

/** run() 的运行选项 */
export type RunOptions = {

    /** 本次运行可访问的工具集；不传则不启用工具调用 */
    tools?: ToolSource;

    /** 最大模型轮数，默认 DEFAULT_MAX_STEPS */
    maxSteps?: number;
};

/** 运行上下文 */
export type RunContext = {

    /** 会话快照 */
    snapshot: Message[];

    /** 物化运行，临时存放产出结果 */
    run: Run;

    /** 对话选项 */
    runtimeOptions: SessionRuntimeOptions;

    /** 会话事件发射器 */
    emit: SessionEventListener;

    /** LLM提供器 */
    llm: LLMProvider;

    /** 取消信号 */
    signal: AbortSignal;

    /** 本次运行可访问的工具；undefined 表示不启用工具调用 */
    tools?: ToolSource;

    /** 本次运行允许的最大模型轮数 */
    maxSteps: number;
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

        emit({ type: SessionEventType.ASSISTANT_START });

        const chatResult = await ctx.llm.send(this._messages(ctx), ctx.runtimeOptions, {
            onToken: _onToken,
            signal: ctx.signal,
            tools: tools.length > 0 ? [...tools] : undefined,
        });

        // 兜底：如果模型全程思考没有输出，手动触发思考结束事件
        if (!thinkingOverEmitted){
            emit({
                type: SessionEventType.ASSISTANT_THINKING_OVER,
                thinking: thinkingAccum,
            });
        }

        const outputMsg = chatResult.message;

        if (outputMsg.failureReason !== undefined){
            throw new SessionError(
                SessionErrorType.ProviderError,
                `Provider returned a failed assistant message: ${outputMsg.failureReason}`,
                outputMsg.failureReason,
            );
        }

        ctx.run.appendMessage(outputMsg);
        emit({
            type: SessionEventType.ASSISTANT_COMPLETE_TURN,
            msg: outputMsg.content,
            usage: outputMsg.usage,
        });

        return outputMsg;
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

                await this._runTools(ctx, assistantMsg.toolCalls);
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
        if (ctx.tools === undefined) return [];

        const tools = await ctx.tools.listTools(ctx.signal);
        if (tools.length > 0 && !ctx.llm.supportsTools){
            throw new SessionError(
                SessionErrorType.MissingTools,
                "The current LLM provider does not support tool calls",
            );
        }

        return tools;
    }

    /** 顺序执行一轮助手消息中的所有工具调用
     * @note 并发策略属于 AgentLoop 的职责，Registry 只负责工具范围
     */
    private async _runTools(ctx: RunContext, calls: readonly ToolCall[]): Promise<void>{
        const toolkit = ctx.tools;
        if (toolkit === undefined){
            throw new SessionError(
                SessionErrorType.MissingTools,
                "Model requested tools but no tool source was provided for this run",
            );
        }

        for (const call of calls){
            if (ctx.signal.aborted) return;

            ctx.emit({ type: SessionEventType.TOOL_CALL_START, call });

            const result = await toolkit.invoke(call, { signal: ctx.signal });

            // 无论成功失败都物化成 ToolMessage，保证 call/result 成对
            ctx.run.appendMessage(tool(result, call.name, call.id));
            ctx.emit({ type: SessionEventType.TOOL_CALL_END, call, result });

            if (ctx.signal.aborted) return;
        }
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
    private _llm?: LLMProvider;

    private _activeRun: Run | null = null;
    private _abortController: AbortController | null = null;

    constructor(
        llm?: LLMProvider,
        history?: SessionHistory,
        options: SessionRuntimeOptions = {},
    ){
        this._llm = llm;
        this._currentSession = history;
        this._runtimeOptions = { ...options };
        this._runEngine = new RunEngine();
    }

    /** 当前会话数据 */
    get history(): SessionHistory | undefined{ return this._currentSession; }

    /** 当前活动 Run；null 表示空闲 */
    get activeRun(): Run | null{ return this._activeRun; }

    /** 是否正在运行 */
    get isBusy(): boolean{ return this._activeRun !== null; }

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

    /** 设置 LLMProvider；运行中不允许切换 */
    setLLM(llm: LLMProvider): void{
        this._assertIdle("switch LLM provider");
        this._llm = llm;
    }

    /** 切换当前会话；运行中不允许切换 */
    changeSession(history: SessionHistory): void{
        this._assertIdle("change session");
        this._currentSession = history;
    }

    /** 取消当前运行 */
    cancel(): void{
        if (this._activeRun === null || this._abortController === null) return;
        if (this._abortController.signal.aborted) return;

        this._activeRun.markAborting();
        this._emit({ type: SessionEventType.STATE_CHANGE, state: this.state });
        this._emit({ type: SessionEventType.USER_ABORT });
        this._abortController.abort();
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
     * @param options 运行选项（工具集、最大轮数）
     */
    async run(input: MessageContent, options: RunOptions = {}): Promise<Run>{
        if (this._activeRun !== null){
            throw new SessionError(SessionErrorType.Busy, "Session is already running");
        }
        if (this._currentSession === undefined){
            throw new SessionError(SessionErrorType.MissingSession, "Session history is not set");
        }
        if (this._llm === undefined){
            throw new SessionError(SessionErrorType.MissingProvider, "LLMProvider is not set");
        }

        const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
        if (!Number.isInteger(maxSteps) || maxSteps < 1){
            throw new SessionError(
                SessionErrorType.InvalidRequest,
                `maxSteps must be a positive integer, got ${String(options.maxSteps)}`,
            );
        }

        const history = this._currentSession;
        const llm = this._llm;
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
            llm,
            signal: abortController.signal,
            tools: options.tools,
            maxSteps,
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
            if (this._activeRun === run){
                this._activeRun = null;
            }
            this._abortController = null;
            this._emit({ type: SessionEventType.STATE_CHANGE, state: this.state });
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

function errorMessage(error: unknown): string{
    return error instanceof Error ? error.message : String(error);
}