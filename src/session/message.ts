import { ToolError } from "./error";
import {
    ChatRoleUser,
    ChatRoleAssistant,
    ChatRoleSystem,
    ChatRoleTool,
} from "./type";
import type {
    ChatRole,
    ChatUsage,
    ChatFailureReason,
    ChatStopReason,
    ToolCall,
    ToolCallStatus,
    ToolCallResult,
    MessageContent,
} from "./type";

import { cloneMessageContent } from "./utils";


/** 消息基类 */
export abstract class Message{

    private readonly _role: ChatRole;
    private readonly _content: MessageContent;
    private _isCompressed: boolean;

    /** 消息角色 */
    get role(): ChatRole{
        return this._role;
    }


    /** 消息内容
     * @note 只读属性，不得直接修改
    */
    get content(): MessageContent{
        return this._content;
    }
    /** 消息是否被压缩了/被压缩的消息不会被推送给AI */
    get isCompressed(): boolean{
        return this._isCompressed;
    }
    set isCompressed(value: boolean){
        this._isCompressed = value;
    }

    /** 构造函数 
     * @param role 消息角色
     * @param init 消息初始化参数
    */
    protected constructor(
        role: ChatRole,
        content: MessageContent,
        isCompressed?: boolean,
    ){
        this._role = role;
        this._content = cloneMessageContent(content);
        this._isCompressed = isCompressed ?? false;
    }

    protected _cloneBase(){
        return {
            role: this._role,
            content: cloneMessageContent(this._content),
            isCompressed: this._isCompressed,
        };
    }

    /** 深拷贝消息 */
    abstract clone(): Message;
}

/** 用户消息 */
export class UserMessage extends Message{
    constructor(content: MessageContent, isCompressed?: boolean){
        super(ChatRoleUser, content, isCompressed);
    }

    override clone(): UserMessage{
        const c = this._cloneBase();
        return new UserMessage(
            c.content,
            c.isCompressed,
        );
    }
}

/** 助手消息 */
export class AssistantMessage extends Message{
    
    private _thinking?: string;
    private _usage: ChatUsage;
    private _stopReason: ChatStopReason | undefined;
    private _failureReason: ChatFailureReason | undefined;
    private readonly _toolCalls: ToolCall[];

    /** 思考内容/undefined表示没有思考内容 */
    get thinking(): string | undefined { return this._thinking; }
    set thinking(value: string | undefined) { this._thinking = value; }

    /** 助手消息用量 */
    get usage(): ChatUsage { return {...this._usage}; }
    set usage(value: ChatUsage) { this._usage = {...value}; }

    /** 会话终止的原因 */
    get stopReason(): ChatStopReason | undefined { return this._stopReason; }
    set stopReason(value: ChatStopReason | undefined) { this._stopReason = value; }

    /** 失败原因/undefined表示没有失败原因 */
    get failureReason(): ChatFailureReason | undefined { return this._failureReason; }
    set failureReason(value: ChatFailureReason | undefined) { this._failureReason = value; }

    /** 工具调用列表 */
    get toolCalls(): readonly ToolCall[] { return [...this._toolCalls]; }

    /** 是否有工具调用 */
    get hasToolCall(): boolean { return this._toolCalls.length > 0; }

    constructor(
        content: MessageContent,
        isCompressed?: boolean,
        thinking?: string, 
        usage?: ChatUsage,
        toolCalls?: ToolCall[],
        stopReason?: ChatStopReason,
        failureReason?: ChatFailureReason,
    ){
        super(ChatRoleAssistant, content, isCompressed);
        this._thinking = thinking;
        this._usage = usage === undefined ? {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
        } : {...usage};
        this._toolCalls = toolCalls ? [...toolCalls] : [];
        this._stopReason = stopReason;
        this._failureReason = failureReason;
    }

    override clone(): AssistantMessage{
        const c = this._cloneBase();
        return new AssistantMessage(
            c.content,
            c.isCompressed,
            this._thinking,
            this._usage,
            this._toolCalls,
            this._stopReason,
            this._failureReason,
        );
    }
}

/** 系统消息
 * @note 系统消息的内容必须是字符串类型,且不可被压缩
 */
export class SystemMessage extends Message{
    constructor(prompt: string){
        super(ChatRoleSystem, prompt);
    }

    override clone(): SystemMessage{
        const c = this._cloneBase();
        return new SystemMessage(
            c.content as string,
        );
    }
}


/** 代表工具消息 */
export class ToolMessage extends Message{
    private _toolName: string;
    private _callId: string;
    private _details: ToolCallStatus;

    /** 工具名称 */
    get toolName(): string{
        return this._toolName;
    }
    /** 工具调用ID */
    get callId(): string{
        return this._callId;
    }
    /** 工具调用详情 */
    get details(): ToolCallStatus{
        return {...this._details};
    }
    /** 本次工具调用是否成功 */
    get isSuccess(): boolean{
        return this._details.isSuccess;
    }
    /** 失败信息 */
    get error(): ToolError | undefined{
        return this._details.error;
    }
    /** 耗时 */
    get duration(): number{
        return this._details.duration;
    }

    constructor(
        content: MessageContent,
        toolName: string,
        callId: string, 
        details: ToolCallStatus,
        isCompressed?: boolean
    ){
        super(ChatRoleTool, content, isCompressed);
        this._toolName = toolName;
        this._callId = callId;
        this._details = {...details};
    }

    override clone(): ToolMessage{
        const c = this._cloneBase();
        return new ToolMessage(
            c.content,
            this._toolName,
            this._callId,
            this._details,
            c.isCompressed,
        );
    }
}


/** 创建用户消息(contents优先)
 * @param content 用户消息内容
 */
export function user(content: MessageContent): UserMessage{
    return new UserMessage(content);
}


/** 助手消息
 * @param text 助手消息内容
 * @param thinking 思考内容/undefined表示没有思考内容
 * @param usage 助手消息用量
 * @param toolCalls 工具调用列表
 * @param stopReason 会话终止的原因
 * @param failureReason 失败原因/undefined表示没有失败原因
 */
export function assistant(
    content: MessageContent, 
    thinking?: string, 
    usage?: ChatUsage, 
    toolCalls?: ToolCall[],
    stopReason?: ChatStopReason,
    failureReason?: ChatFailureReason,
): AssistantMessage{

    return new AssistantMessage(
        content,
        false,
        thinking, 
        usage,
        toolCalls,
        stopReason,
        failureReason,
    );
}

/** 系统消息 
 * @param text 系统消息内容(不允许携带附件信息)
*/
export function system(text: string): SystemMessage{
    return new SystemMessage(text);
}


/** 代表工具消息
 * @param result 工具调用结果
 * @param toolName 工具名称
 * @param callId 工具调用ID
 */
export function tool(result: ToolCallResult, toolName: string, callId: string): ToolMessage{
    return new ToolMessage(
        result.content,
        toolName, 
        callId, 
        result.status,
        false
    );
}