import { isJsonSafe, SerializationError } from "../base";
import type { MessageContent, ContentPart, ToolCall } from "./type";


/** 深拷贝消息内容 */
export function cloneMessageContent(content: MessageContent): MessageContent{
    if (typeof content === "string") return content;

    return content.map((part): ContentPart => {
        if (part.type === "text"){
            return {
                type: "text",
                text: part.text,
            };
        }
        return {
            type: "attachment",
            attachment: {
                contentHash: part.attachment.contentHash,
            },
        };
    });
}


/** 深拷贝工具调用列表 */
export function cloneToolCalls(toolCalls: readonly ToolCall[]): ToolCall[]{
    return toolCalls.map((toolCall) => {
        return {
            id: toolCall.id,
            name: toolCall.name,
            params: _cloneToolCallParams(toolCall.params),
        };
    });
}

/** 深拷贝工具参数；params 在协议上必须是 JSON-safe */
function _cloneToolCallParams(params: Record<string, unknown>): Record<string, unknown>{
    if (!isJsonSafe(params)){
        throw new SerializationError("Tool call params should be JSON-serializable");
    }
    return JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
}