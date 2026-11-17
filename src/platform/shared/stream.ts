import { uniqueId } from "../../base";
import { SessionError, SessionErrorType } from "../../session/error";
import { AssistantMessage } from "../../session/message";
import type { ProtocolAdapter } from "../../session/protocol";
import { ChatStopReason } from "../../session/type";
import type {
    ChatOptions,
    ChatUsage,
    StreamChunk,
    ToolCall,
} from "../../session/type";

/** 平台流式输出格式：OpenAI 兼容平台是 SSE，Ollama 是 NDJSON */
export type ChatStreamFormat = "sse" | "ndjson";

export type ConsumeChatStreamOptions = {
    /** 流式格式 */
    format: ChatStreamFormat;

    /** 日志/错误消息中使用的平台名 */
    label: string;

    /** 平台协议适配器 */
    adapter: ProtocolAdapter;

    /** 本轮对话选项 */
    turn?: ChatOptions;

    /** 流式工具调用缺少名称时的兜底；默认 tool_<index> */
    toolNameFallback?: (index: number) => string;

    /** 非 JSON 数据的错误说明 */
    invalidJsonMessage?: string;

    /** 工具参数 JSON 非法的错误说明 */
    invalidToolArgumentsMessage?: (index: number) => string;

    /** 流内错误片段的错误说明 */
    streamErrorMessage?: (message: string | undefined) => string;
};

export type ConsumeChatStreamResult = {
    message: AssistantMessage;
    /** 最后一条原始流数据，供调试 */
    raw?: unknown;
};

/**
 * 读取并聚合对话流，把平台片段归一化为最终的 AssistantMessage。
 *
 * SSE 与 NDJSON 只在“如何切分一行数据”上不同；文本、思考、工具调用、用量、
 * 结束原因与附件回调的聚合逻辑完全一致。
 */
export async function consumeChatStream(
    response: Response,
    options: ConsumeChatStreamOptions,
): Promise<ConsumeChatStreamResult>{
    if (response.body === null){
        throw new SessionError(
            SessionErrorType.ProviderError,
            `${options.label} returned an empty response body`,
        );
    }

    const { label, adapter, turn } = options;
    const fallbackName = options.toolNameFallback ?? ((index: number) => `tool_${index}`);

    let content = "";
    let thinking = "";
    let usage: ChatUsage | undefined;
    let stopReason: ChatStopReason | undefined;
    let lastRaw: unknown;
    let streamDone = false;

    const toolCalls = new Map<number, { id?: string; name?: string; argumentsText: string }>();

    const consumeChunk = (chunk: StreamChunk): void => {
        switch (chunk.type){
            case "text_delta":
                content += chunk.text;
                if (chunk.text.length > 0) turn?.onToken?.(chunk.text, false);
                break;

            case "thinking_delta":
                thinking += chunk.text;
                if (chunk.text.length > 0) turn?.onToken?.(chunk.text, true);
                break;

            case "attachment":
                turn?.onAttachment?.(chunk.attachment);
                break;

            case "tool_call_delta": {
                const current = toolCalls.get(chunk.toolCall.index) ?? { argumentsText: "" };
                if (chunk.toolCall.id !== undefined) current.id = chunk.toolCall.id;
                if (chunk.toolCall.name !== undefined) current.name = chunk.toolCall.name;
                if (chunk.toolCall.argumentsDelta !== undefined){
                    current.argumentsText += chunk.toolCall.argumentsDelta;
                }
                toolCalls.set(chunk.toolCall.index, current);
                break;
            }

            case "usage":
                usage = { ...chunk.usage };
                break;

            case "done":
                stopReason = chunk.stopReason;
                break;

            case "error":
                throw new SessionError(
                    SessionErrorType.ProviderError,
                    options.streamErrorMessage?.(chunk.message) ?? chunk.message ?? `${label} stream error`,
                    chunk.failureReason,
                );
        }
    };

    const consumePayload = (text: string): void => {
        let raw: unknown;
        try{
            raw = JSON.parse(text);
        }catch(error){
            throw new SessionError(
                SessionErrorType.ProviderError,
                options.invalidJsonMessage ?? `${label} returned invalid stream JSON`,
                error,
            );
        }
        lastRaw = raw;

        for (const chunk of adapter.parseStreamChunk(raw)) consumeChunk(chunk);
    };

    const consumeLine = (line: string): void => {
        if (options.format === "sse"){
            if (!line.startsWith("data:")) return;

            const data = line.slice(5).trim();
            if (data.length === 0) return;
            if (data === "[DONE]"){
                streamDone = true;
                return;
            }

            consumePayload(data);
            return;
        }

        const trimmed = line.trim();
        if (trimmed.length === 0) return;
        consumePayload(trimmed);
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try{
        while (!streamDone){
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            let newlineIndex = buffer.indexOf("\n");
            while (newlineIndex >= 0 && !streamDone){
                const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
                buffer = buffer.slice(newlineIndex + 1);
                consumeLine(line);
                newlineIndex = buffer.indexOf("\n");
            }
        }

        if (!streamDone){
            buffer += decoder.decode();
            if (buffer.trim().length > 0) consumeLine(buffer);
        }
    }catch(error){
        if (turn?.signal?.aborted === true) throw error;
        if (error instanceof SessionError) throw error;
        throw new SessionError(
            SessionErrorType.ProviderError,
            `Failed to read the ${label} stream`,
            error,
        );
    }finally{
        await reader.cancel().catch(() => {
            // 读取结束/中断时取消流失败不影响结果
        });
        reader.releaseLock();
    }

    const calls: ToolCall[] = [...toolCalls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, call]) => {
            let params: Record<string, unknown> = {};
            if (call.argumentsText.trim().length > 0){
                try{
                    const parsed: unknown = JSON.parse(call.argumentsText);
                    if (!isRecord(parsed)){
                        throw new Error("tool arguments should be an object");
                    }
                    params = parsed;
                }catch(error){
                    throw new SessionError(
                        SessionErrorType.ProviderError,
                        options.invalidToolArgumentsMessage?.(index)
                            ?? `Invalid ${label} tool arguments at index ${index}`,
                        error,
                    );
                }
            }

            return {
                id: call.id ?? uniqueId(),
                name: call.name ?? fallbackName(index),
                params,
            };
        });

    return {
        message: new AssistantMessage(
            content,
            false,
            thinking.length > 0 ? thinking : undefined,
            usage,
            calls.length > 0 ? calls : undefined,
            stopReason,
        ),
        raw: lastRaw,
    };
}

function isRecord(value: unknown): value is Record<string, unknown>{
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
