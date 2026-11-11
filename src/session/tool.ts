import { ToolError } from "./error";
import { ToolCall, ToolCallResult, ToolDefinition } from "./type";


/** 工具提供者(提供工具的定义) */
export interface ToolProvider {
    /** 工具提供者ID */
    id: string;

    /** 工具提供者名称 */
    name: string;

    /** 工具提供者描述 */
    description: string;

    /** 列出所有工具
     * @note 最终输出的工具名称=工具提供者ID.工具ID，比如"obsidian.read"
     */
    fetchTools(signal?: AbortSignal): Promise<ToolDefinition[]>;

    /** 调用工具 */
    call(call: ToolCall): Promise<ToolCallResult>;
}


/** 向模型输出所有可用的工具定义 */
export class ToolRegistry{

    /** 工具提供者列表 */
    private _providers: Map<string, ToolProvider> = new Map();

    /** 注册工具提供者 */
    registerProvider(provider: ToolProvider): void {
        this._providers.set(provider.id, provider);
    }

    /** 注销工具提供者 */
    unregisterProvider(provider: ToolProvider): void {

        const providerId = provider.id;
        if (!this._providers.has(providerId)) return;
        this._providers.delete(providerId);
    }

    /** 调用工具 */
    /** @param call 工具调用 */
    /** @returns 工具调用结果 */
    async invoke(call: ToolCall): Promise<ToolCallResult> {
        const something = this._getProvider(call.name);
        if (something instanceof ToolError) {
            return this._toErrorToolResult(something);
        }
        return await something.call(call);
    }

    /** 查找工具提供者
     * @param callName 工具调用名称，比如"obsidian.read"
     * @returns 工具提供者或错误信息
     */
    private _getProvider(callName: string): ToolProvider | ToolError {
        // TODO: 实现该函数，根据callName查找工具提供者，如果不存在则返回错误信息（不要抛出异常）
    }

    /** 转换错误为工具调用结果 */
    /** @param err 错误信息 */
    /** @returns 工具调用结果 */
    private _toErrorToolResult(err: ToolError){
        return {
            content: err.message,
            status: {
                isSuccess: false,
                error: err,
                retryable: err.retryable,
                duration: 0,
            },
            structuredContent: undefined,
            raw: undefined,
        };
    }
}