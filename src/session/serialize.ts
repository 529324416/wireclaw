import {
    asBoolean,
    asEnum,
    asNonEmptyString,
    asNonNegativeInteger,
    asNonNegativeNumber,
    asRecord,
    asString,
    DeserializationError,
    isJsonSafe,
    SerializationError,
} from "../base";
import { isContentHash } from "./attachment";
import type { StoredAttachmentMeta } from "./attachment";
import { ToolError, ToolErrorType } from "./error";
import { AssistantMessage, SystemMessage, ToolMessage, UserMessage } from "./message";
import type { Message } from "./message";
import { SessionHistory } from "./session";
import {
    ChatRoleAssistant,
    ChatRoleSystem,
    ChatRoleTool,
    ChatRoleUser,
    ChatFailureReason,
    ChatStopReason,
} from "./type";
import type {
    AttachmentRef,
    ChatUsage,
    ContentPart,
    MessageContent,
    MessageData,
    MessageDataBase,
    MessageDataUser,
    MessageDataAssistant,
    MessageDataSystem,
    MessageDataTool,
    SessionData,
    ToolCall,
    ToolCallStatus,
    ToolCallStatusData,
    ToolTrust,
} from "./type";

import { cloneMessageContent, cloneToolCalls } from "./utils";

const TOOL_TRUST_VALUES: readonly ToolTrust[] = ["trusted", "unknown", "untrusted"];


export class MessageSerializer{

    /** 序列化消息，按具体消息类型分发 */
    static serialize(message: Message): MessageData{
        switch (message.role){
            case ChatRoleUser:
                return MessageSerializer.serializeUserMessage(message as UserMessage);
            case ChatRoleAssistant:
                return MessageSerializer.serializeAssistantMessage(message as AssistantMessage);
            case ChatRoleSystem:
                return MessageSerializer.serializeSystemMessage(message as SystemMessage);
            case ChatRoleTool:
                return MessageSerializer.serializeToolMessage(message as ToolMessage);
            default:
                throw new SerializationError(`Unsupported message type: ${message.constructor.name}`);
        }
    }

    /** 序列化消息基础数据 */
    static serializeBase(message: Message): MessageDataBase{
        return {
            content: cloneMessageContent(message.content),
            isCompressed: message.isCompressed,
        }
    }

    /** 序列化用户消息 */
    static serializeUserMessage(message: UserMessage): MessageDataUser{
        return {
            role: ChatRoleUser,
            ...MessageSerializer.serializeBase(message),
        }
    }

    /** 序列化助手消息 */
    static serializeAssistantMessage(message: AssistantMessage): MessageDataAssistant{
        return {
            role: ChatRoleAssistant,
            ...MessageSerializer.serializeBase(message),
            thinking: message.thinking,
            usage: {...message.usage},
            toolCalls: cloneToolCalls(message.toolCalls),
            stopReason: message.stopReason,
            failureReason: message.failureReason,
        }
    }

    /** 序列化系统消息 */
    static serializeSystemMessage(message: SystemMessage): MessageDataSystem{
        return {
            role: ChatRoleSystem,
            ...MessageSerializer.serializeBase(message),
        }
    }

    /** 序列化工具消息 */
    static serializeToolMessage(message: ToolMessage): MessageDataTool{
        return {
            role: ChatRoleTool,
            ...MessageSerializer.serializeBase(message),
            toolName: message.toolName,
            callId: message.callId,
            details: MessageSerializer.serializeToolDetails(message.details),
            ...(message.structuredContent === undefined
                ? {}
                : { structuredContent: MessageSerializer.serializeStructuredContent(message.structuredContent) }),
            ...(message.trust === undefined ? {} : { trust: message.trust }),
            ...(message.trustReason === undefined ? {} : { trustReason: message.trustReason }),
        }
    }

    /** 序列化工具结构化内容；必须可 JSON 安全往返 */
    static serializeStructuredContent(value: object): object{
        return MessageSerializer._cloneStructuredContent(value, "structuredContent");
    }

    /** 序列化工具调用详情
     * @note ToolError 是运行期实例，这里只保留可持久化的 type / retryable / message
     */
    static serializeToolDetails(details: ToolCallStatus): ToolCallStatusData{
        if (details.error === undefined){
            return {
                isSuccess: details.isSuccess,
                duration: details.duration,
            };
        }

        return {
            isSuccess: details.isSuccess,
            duration: details.duration,
            error: {
                type: details.error.type,
                retryable: details.error.retryable,
                message: details.error.message,
            },
        };
    }

    /** 反序列化消息
     * @param data 由 SessionSerializer 提供
     */
    static deserialize(data: unknown): Message{
        const record = asRecord(data, "data");
        const role = asString(record.role, "role");
        const isCompressed = asBoolean(record.isCompressed, "isCompressed");
        const content = MessageSerializer._deserializeContent(
            record.content,
            "content",
            role === ChatRoleSystem,
        );

        switch (role){
            case ChatRoleUser:
                return new UserMessage(content, isCompressed);

            case ChatRoleAssistant: {
                const thinking = record.thinking === undefined
                    ? undefined
                    : asString(record.thinking, "thinking");
                const usage = record.usage === undefined
                    ? undefined
                    : MessageSerializer._deserializeUsage(record.usage, "usage");
                const toolCalls = record.toolCalls === undefined
                    ? undefined
                    : MessageSerializer._deserializeToolCalls(record.toolCalls, "toolCalls");
                const stopReason = MessageSerializer._deserializeOptionalEnum<ChatStopReason>(
                    record.stopReason,
                    Object.values(ChatStopReason) as ChatStopReason[],
                    "stopReason",
                );
                const failureReason = MessageSerializer._deserializeOptionalEnum<ChatFailureReason>(
                    record.failureReason,
                    Object.values(ChatFailureReason) as ChatFailureReason[],
                    "failureReason",
                );

                return new AssistantMessage(
                    content,
                    isCompressed,
                    thinking,
                    usage,
                    toolCalls,
                    stopReason,
                    failureReason,
                );
            }

            case ChatRoleSystem: {
                if (typeof content !== "string"){
                    throw new DeserializationError("Invalid message data: system content should be a string");
                }
                const message = new SystemMessage(content);
                message.isCompressed = isCompressed;
                return message;
            }

            case ChatRoleTool: {
                const toolName = asString(record.toolName, "toolName");
                const callId = asString(record.callId, "callId");
                const details = MessageSerializer._deserializeToolDetails(record.details, "details");
                const structuredContent = MessageSerializer._deserializeStructuredContent(
                    record.structuredContent,
                    "structuredContent",
                );
                const trust = record.trust === undefined
                    ? undefined
                    : asEnum(record.trust, TOOL_TRUST_VALUES, "trust");
                const trustReason = record.trustReason === undefined
                    ? undefined
                    : asString(record.trustReason, "trustReason");

                return new ToolMessage(
                    content,
                    toolName,
                    callId,
                    details,
                    isCompressed,
                    structuredContent,
                    trust,
                    trustReason,
                );
            }

            default:
                throw new DeserializationError(`Invalid message data: unknown role "${role}"`);
        }
    }

    /** 反序列化可选枚举，undefined/null 都归一成 undefined */
    private static _deserializeOptionalEnum<T extends string>(
        value: unknown,
        allowed: readonly T[],
        field: string,
    ): T | undefined{
        if (value === undefined || value === null) return undefined;
        return asEnum(value, allowed, field);
    }

    /** 反序列化消息内容 */
    private static _deserializeContent(
        value: unknown,
        field: string,
        stringOnly: boolean,
    ): MessageContent{
        if (typeof value === "string") return value;
        if (stringOnly){
            throw new DeserializationError(`Invalid message data: ${field} should be a string`);
        }
        if (!Array.isArray(value)){
            throw new DeserializationError(`Invalid message data: ${field} should be a string or an array`);
        }

        return value.map((part, index) => {
            return MessageSerializer._deserializeContentPart(part, `${field}[${index}]`);
        });
    }

    /** 反序列化一个内容部分 */
    private static _deserializeContentPart(
        value: unknown,
        field: string,
    ): ContentPart{
        const record = asRecord(value, field);
        const type = asString(record.type, `${field}.type`);

        switch (type){
            case "text": {
                if (record.attachment !== undefined){
                    throw new DeserializationError(`Invalid message data: ${field}.attachment is not allowed for a text part`);
                }
                return {
                    type,
                    text: asString(record.text, `${field}.text`),
                };
            }

            case "attachment": {
                if (record.text !== undefined){
                    throw new DeserializationError(`Invalid message data: ${field}.text is not allowed for an attachment part`);
                }
                return {
                    type,
                    attachment: MessageSerializer._deserializeAttachment(
                        record.attachment,
                        `${field}.attachment`,
                    ),
                };
            }

            default:
                throw new DeserializationError(`Invalid message data: ${field}.type "${type}" is not supported`);
        }
    }

    /** 反序列化附件引用 */
    private static _deserializeAttachment(value: unknown, field: string): AttachmentRef{
        const record = asRecord(value, field);
        return {
            contentHash: asNonEmptyString(record.contentHash, `${field}.contentHash`),
        };
    }

    /** 反序列化并复制一个 JSON 安全的参数对象 */
    private static _deserializeParams(value: unknown, field: string): Record<string, unknown>{
        const record = asRecord(value, field);
        if (!isJsonSafe(record)){
            throw new DeserializationError(`Invalid message data: ${field} should be JSON-serializable`);
        }

        const serialized = JSON.stringify(record);
        if (serialized === undefined){
            throw new DeserializationError(`Invalid message data: ${field} should be JSON-serializable`);
        }
        return JSON.parse(serialized) as Record<string, unknown>;
    }

    /** 反序列化工具结构化内容 */
    private static _deserializeStructuredContent(
        value: unknown,
        field: string,
    ): object | undefined{
        if (value === undefined || value === null) return undefined;
        return MessageSerializer._cloneStructuredContent(asRecord(value, field), field);
    }

    /** 校验并深拷贝 JSON 安全的工具结构化内容 */
    private static _cloneStructuredContent(value: object, field: string): object{
        if (!isJsonSafe(value)){
            throw new SerializationError(`Tool ${field} should be JSON-serializable`);
        }

        const serialized = JSON.stringify(value);
        if (serialized === undefined){
            throw new SerializationError(`Tool ${field} should be JSON-serializable`);
        }
        return JSON.parse(serialized) as object;
    }

    /** 反序列化助手消息用量 */
    private static _deserializeUsage(value: unknown, field: string): ChatUsage{
        const record = asRecord(value, field);
        return {
            promptTokens: asNonNegativeNumber(record.promptTokens, `${field}.promptTokens`),
            completionTokens: asNonNegativeNumber(record.completionTokens, `${field}.completionTokens`),
            totalTokens: asNonNegativeNumber(record.totalTokens, `${field}.totalTokens`),
        };
    }

    /** 反序列化工具调用请求 */
    private static _deserializeToolCall(value: unknown, field: string): ToolCall{
        const record = asRecord(value, field);
        return {
            id: asString(record.id, `${field}.id`),
            name: asString(record.name, `${field}.name`),
            params: MessageSerializer._deserializeParams(record.params, `${field}.params`),
        };
    }

    /** 反序列化工具调用请求列表 */
    private static _deserializeToolCalls(value: unknown, field: string): ToolCall[]{
        if (!Array.isArray(value)){
            throw new DeserializationError(`Invalid message data: ${field} should be an array`);
        }
        return value.map((item, index) => {
            return MessageSerializer._deserializeToolCall(item, `${field}[${index}]`);
        });
    }

    /** 反序列化工具调用详情 */
    private static _deserializeToolDetails(value: unknown, field: string): ToolCallStatus{
        const record = asRecord(value, field);
        const error = MessageSerializer._deserializeToolError(record.error, `${field}.error`);

        return {
            isSuccess: asBoolean(record.isSuccess, `${field}.isSuccess`),
            duration: asNonNegativeNumber(record.duration, `${field}.duration`),
            ...(error === undefined ? {} : { error }),
        };
    }

    /** 反序列化工具错误；字段缺失时返回 undefined */
    private static _deserializeToolError(value: unknown, field: string): ToolError | undefined{
        if (value === undefined || value === null) return undefined;

        const record = asRecord(value, field);
        return new ToolError(
            asEnum(record.type, Object.values(ToolErrorType) as ToolErrorType[], `${field}.type`),
            asBoolean(record.retryable, `${field}.retryable`),
            asString(record.message, `${field}.message`),
        );
    }
}

/** 当前会话 schema 版本；旧文件缺省按 1 处理 */
export const SESSION_DATA_VERSION = 2;

const SESSION_DATA_MIN_VERSION = 1;

/** 附件元数据清单版本 */
export const ATTACHMENT_MANIFEST_VERSION = 1;

/** 与会话文件配套的附件元数据清单
 * @note 单独保存，避免把原始路径写进会话 JSON；用于宿主元数据丢失后的恢复。
 */
export type SessionAttachmentManifest = {
    version: number;
    attachments: StoredAttachmentMeta[];
};

/** 附件元数据清单序列化器 */
export class SessionAttachmentManifestSerializer{

    /** 序列化附件元数据清单 */
    static serialize(metas: readonly StoredAttachmentMeta[]): SessionAttachmentManifest{
        return {
            version: ATTACHMENT_MANIFEST_VERSION,
            attachments: metas.map((meta) => ({
                contentHash: meta.contentHash,
                name: meta.name,
                ...(meta.mimeType === undefined ? {} : { mimeType: meta.mimeType }),
                size: meta.size,
                sourcePaths: [...meta.sourcePaths],
            })),
        };
    }

    /** 反序列化附件元数据清单 */
    static deserialize(data: unknown): StoredAttachmentMeta[]{
        const record = asRecord(data, "attachmentManifest");
        const version = asNonNegativeInteger(record.version, "attachmentManifest.version");
        if (version !== ATTACHMENT_MANIFEST_VERSION){
            throw new DeserializationError(
                `Invalid attachment manifest: unsupported version ${version}`,
            );
        }

        if (!Array.isArray(record.attachments)){
            throw new DeserializationError(
                "Invalid attachment manifest: attachments should be an array",
            );
        }

        return record.attachments.map((item, index) => {
            const field = `attachmentManifest.attachments[${index}]`;
            const meta = asRecord(item, field);
            const contentHash = asNonEmptyString(meta.contentHash, `${field}.contentHash`);
            if (!isContentHash(contentHash)){
                throw new DeserializationError(
                    `Invalid attachment manifest: ${field}.contentHash must be a SHA-256 hex string`,
                );
            }

            const sourcePaths = meta.sourcePaths === undefined
                ? []
                : (() => {
                    if (!Array.isArray(meta.sourcePaths)){
                        throw new DeserializationError(
                            `Invalid attachment manifest: ${field}.sourcePaths should be an array`,
                        );
                    }
                    return meta.sourcePaths.map((path, pathIndex) => {
                        return asString(path, `${field}.sourcePaths[${pathIndex}]`);
                    });
                })();

            return {
                contentHash,
                name: asString(meta.name, `${field}.name`),
                ...(meta.mimeType === undefined
                    ? {}
                    : { mimeType: asString(meta.mimeType, `${field}.mimeType`) }),
                size: asNonNegativeNumber(meta.size, `${field}.size`),
                sourcePaths,
            };
        });
    }
}

/** 会话数据序列化器 */
export class SessionSerializer{
    /** 序列化会话数据 */
    static serialize(session: SessionHistory): SessionData{
        return {
            version: SESSION_DATA_VERSION,
            id: session.id,
            messages: session.messages.map(msg => MessageSerializer.serialize(msg)),
            isArchived: session.isArchived,
        };
    }

    /** 反序列化会话数据 */
    static deserialize(data: unknown): SessionHistory{
        const record = asRecord(data, "session");
        const version = record.version === undefined
            ? SESSION_DATA_MIN_VERSION
            : asNonNegativeInteger(record.version, "version");
        if (version < SESSION_DATA_MIN_VERSION || version > SESSION_DATA_VERSION){
            throw new DeserializationError(
                `Invalid session data: unsupported version ${version}`,
            );
        }

        const id = asString(record.id, "id");
        const isArchived = asBoolean(record.isArchived, "isArchived");

        if (!Array.isArray(record.messages)){
            throw new DeserializationError("Invalid session data: messages should be an array");
        }

        const messages = record.messages.map((message, index) => {
            try{
                return MessageSerializer.deserialize(message);
            }catch(error){
                if (error instanceof DeserializationError){
                    throw new DeserializationError(`Invalid session data: messages[${index}]: ${error.message}`);
                }
                throw error;
            }
        });

        return new SessionHistory(id, messages, isArchived);
    }
}
