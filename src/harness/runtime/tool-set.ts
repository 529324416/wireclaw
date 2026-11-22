import { ToolError, ToolErrorType } from "../../session/error";
import type { RegisteredTool, ToolInvokeOptions } from "../../session/tool";
import type { ToolSource } from "../../session/session";
import type { ToolCall, ToolCallResult } from "../../session/type";
import type { ToolSetSpec } from "../graph/type";

/**
 * Harness 层的工具可见范围。
 *
 * - ToolRegistry 负责承载/调用；
 * - ToolSet 只在现有 ToolSource 上做过滤，不修改 Session；
 * - 多个 spec 叠加时取交集（include 必须全部命中，exclude 任一命中即排除）；
 * - host 工具策略按 AND 合并（false 优先）。
 */
export class ToolSet implements ToolSource{

    private readonly _registry: ToolSource;
    private readonly _specs: readonly ToolSetSpec[];

    constructor(registry: ToolSource, specs: readonly ToolSetSpec[] = []){
        this._registry = registry;
        this._specs = [...specs];
    }

    get specs(): readonly ToolSetSpec[]{
        return [...this._specs];
    }

    /** host 内置工具策略；未声明时返回空对象，由 Session 默认值兜底 */
    get hostTools(): { askUser?: boolean; viewMedia?: boolean }{
        let askUser: boolean | undefined;
        let viewMedia: boolean | undefined;

        for (const spec of this._specs){
            if (spec.hostTools?.askUser === false) askUser = false;
            else if (spec.hostTools?.askUser === true && askUser === undefined) askUser = true;

            if (spec.hostTools?.viewMedia === false) viewMedia = false;
            else if (spec.hostTools?.viewMedia === true && viewMedia === undefined) viewMedia = true;
        }

        return {
            ...(askUser === undefined ? {} : { askUser }),
            ...(viewMedia === undefined ? {} : { viewMedia }),
        };
    }

    /** 追加一层更窄的范围；不会突破已有 include/exclude */
    narrow(spec: ToolSetSpec): ToolSet{
        return new ToolSet(this._registry, [...this._specs, spec]);
    }

    async listTools(signal?: AbortSignal): Promise<RegisteredTool[]>{
        const tools = await this._registry.listTools(signal);
        return tools.filter((tool) => this._allows(tool.name));
    }

    async invoke(
        call: ToolCall,
        options?: ToolInvokeOptions,
    ): Promise<ToolCallResult>{
        if (!this._allows(call.name)){
            const error = new ToolError(
                ToolErrorType.NotFound,
                false,
                `Tool "${call.name}" is not available in the current ToolSet`,
            );
            return {
                content: error.message,
                status: {
                    isSuccess: false,
                    duration: 0,
                    error,
                },
            };
        }

        return await this._registry.invoke(call, options);
    }

    private _allows(toolName: string): boolean{
        for (const spec of this._specs){
            if (spec.include !== undefined
                && !spec.include.some((pattern) => matchesPattern(toolName, pattern))){
                return false;
            }
            if (spec.exclude !== undefined
                && spec.exclude.some((pattern) => matchesPattern(toolName, pattern))){
                return false;
            }
        }
        return true;
    }
}

function matchesPattern(name: string, pattern: string): boolean{
    if (pattern === "*") return true;
    if (!pattern.includes("*")) return name === pattern;

    const source = pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
    return new RegExp(`^${source}$`).test(name);
}
