import { InvalidParameterError } from "../base";
import { isToolError, ToolError, ToolErrorType } from "./error";
import type {
    ContentPart,
    MessageContent,
    ToolCall,
    ToolCallResult,
    ToolDefinition,
    ToolDefinitionSource,
    ToolParamSchema,
    ToolProgress,
} from "./type";

/* ---------------------------------------------------------------------------
 * 工具命名：<provider_id>__<tool_id>
 * @note 模型侧函数名只允许 [A-Za-z0-9_-]（主流平台均不接受 "."），
 *       因此全链路统一使用 "__" 作为分隔符，不再出现 "."。
 * ------------------------------------------------------------------------- */
export const TOOL_NAME_SEPARATOR = "__";

/** Provider ID 允许的字符集 */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 裸工具名允许的字符集 */
const TOOL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 单次参数校验最多回传给模型的错误条数 */
const MAX_PARAM_PROBLEMS = 8;

/** 传递给 ToolProvider.call 的选项 */
export type ToolCallOptions = {
    /** 取消信号；Provider 必须响应并尽快结束 */
    signal?: AbortSignal;

    /** 进度令牌（支持进度的 Provider 透传给远端） */
    progressToken?: string | number;

    /** 进度回调 */
    onProgress?: (progress: ToolProgress) => void;
};

/** 调用工具时的选项，取消与超时由 ToolRegistry 统一处理 */
export type ToolInvokeOptions = {
    /** 取消信号 */
    signal?: AbortSignal;

    /** 超时时间（毫秒）；不传时不做主动超时 */
    timeoutMs?: number;

    /** 进度令牌 */
    progressToken?: string | number;

    /** 进度回调 */
    onProgress?: (progress: ToolProgress) => void;
};

/** 已由 ToolRegistry 拼装完成的工具定义（名称带前缀，source 必有值） */
export type RegisteredTool = ToolDefinition & {
    source: ToolDefinitionSource;
};

/** 工具结果默认上限：32 KiB 字符 */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 32 * 1024;

/** ToolRegistry 选项 */
export type ToolRegistryOptions = {
    /** 单个 Provider 失败时的回调；失败不会影响其它 Provider */
    onProviderError?: (providerId: string, error: unknown) => void;

    /** 单次工具结果的最大字符数；<= 0 表示不限制。默认 32 KiB */
    maxResultChars?: number;

    /** 工具列表缓存 TTL（毫秒）；<= 0 表示不自动过期。默认 0 */
    toolCacheTtlMs?: number;
};


/** 工具提供者(提供工具的定义与实现) */
export interface ToolProvider {
    /** 工具提供者ID */
    id: string;

    /** 工具提供者名称 */
    name: string;

    /** 工具提供者描述 */
    description: string;

    /** 列出所有工具
     * @note 返回的 name 必须是裸工具名（不含 Provider 前缀，也不含 "__"）；
     *       ToolRegistry 会拼装为 `<providerId>__<name>` 后再暴露给模型。
     */
    fetchTools(signal?: AbortSignal): Promise<ToolDefinition[]>;

    /** 调用工具
     * @param call 工具调用；call.name 已被 ToolRegistry 剥离 Provider 前缀，只有裸工具名
     * @param options 调用选项；Provider 必须响应 options.signal
     */
    call(call: ToolCall, options?: ToolCallOptions): Promise<ToolCallResult>;

    /** 关闭提供者并释放资源（可选；由 ToolRegistry.closeAll 调用） */
    close?(): Promise<void>;

    /** 订阅“工具列表已变化”（可选）
     * @returns 取消订阅函数
     */
    onToolsChanged?(listener: () => void): () => void;
}


/** 拼装模型侧工具名：<provider_id>__<tool_id> */
export function composeToolName(providerId: string, toolId: string): string {
    return `${providerId}${TOOL_NAME_SEPARATOR}${toolId}`;
}

/** 解析模型侧工具名
 * @param fullName 形如 "obsidian__read" 的工具名
 * @returns 解析结果；格式非法时返回 null
 * @note 只按第一个 "__" 切分，因此 tool_id 自身允许包含 "__"
 */
export function parseToolName(fullName: string): { providerId: string; toolId: string } | null {
    const index = fullName.indexOf(TOOL_NAME_SEPARATOR);
    if (index <= 0) return null;

    const providerId = fullName.slice(0, index);
    const toolId = fullName.slice(index + TOOL_NAME_SEPARATOR.length);
    if (toolId.length === 0) return null;
    if (!PROVIDER_ID_PATTERN.test(providerId)) return null;

    return { providerId, toolId };
}


/** 聚合所有 ToolProvider，向模型输出工具定义并转发工具调用 */
export class ToolRegistry {

    /** 工具提供者列表 */
    private readonly _providers: Map<string, ToolProvider> = new Map();

    /** 单 Provider 失败回调 */
    private readonly _onProviderError?: (providerId: string, error: unknown) => void;

    /** 工具结果字符上限 */
    private readonly _maxResultChars: number;

    /** 工具列表缓存 TTL */
    private readonly _toolCacheTtlMs: number;

    /** 工具列表缓存时间 */
    private _toolsCachedAt: number | null = null;

    /** 已拼装的工具定义缓存 */
    private _tools: RegisteredTool[] | null = null;

    /** 正在进行的工具列表拉取（用于并发合并） */
    private _pendingTools: Promise<RegisteredTool[]> | null = null;

    /** 缓存代次；注册/注销/手动失效时自增，防止过期结果写回缓存 */
    private _generation = 0;

    /** 各 Provider 的工具变更订阅 */
    private readonly _toolChangeUnsubscribes: Map<string, () => void> = new Map();

    constructor(options: ToolRegistryOptions = {}) {
        this._onProviderError = options.onProviderError;
        this._maxResultChars = options.maxResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
        this._toolCacheTtlMs = options.toolCacheTtlMs ?? 0;
    }

    /** 注册工具提供者
     * @param provider 工具提供者
     * @param force 是否覆盖已存在的同 ID Provider
     * @returns 是否成功注册（已存在且 force=false 时返回 false）
     * @throws InvalidParameterError Provider ID 非法时抛出（属于调用方的程序错误）
     */
    registerProvider(provider: ToolProvider, force: boolean = false): boolean {
        this._assertProviderId(provider.id);

        if (this._providers.has(provider.id) && !force) return false;

        this._providers.set(provider.id, provider);
        this._watchProvider(provider);
        this.invalidateTools();
        return true;
    }

    /** 注销工具提供者
     * @param provider Provider 实例或 Provider ID
     * @returns 是否成功注销
     */
    unregisterProvider(provider: ToolProvider | string): boolean {
        const providerId = typeof provider === "string" ? provider : provider.id;
        if (!this._providers.delete(providerId)) return false;

        this._unwatchProvider(providerId);
        this.invalidateTools();
        return true;
    }

    /** 使工具列表缓存失效（外部工具集发生变化时调用，例如 MCP 服务器刷新） */
    invalidateTools(): void {
        this._generation += 1;
        this._tools = null;
        this._toolsCachedAt = null;
        this._pendingTools = null;
    }

    /** 关闭所有 Provider 并清空注册表（用于程序退出） */
    async closeAll(): Promise<void> {
        const providers = [...this._providers.values()];

        for (const provider of providers) {
            this._unwatchProvider(provider.id);
        }
        this._providers.clear();
        this.invalidateTools();

        for (const provider of providers) {
            if (provider.close === undefined) continue;
            try {
                await provider.close();
            } catch {
                // 单个 Provider 关闭失败不影响其它 Provider
            }
        }
    }

    /** 订阅 Provider 的工具变更，并让缓存失效 */
    private _watchProvider(provider: ToolProvider): void {
        this._unwatchProvider(provider.id);
        if (provider.onToolsChanged === undefined) return;

        const unsubscribe = provider.onToolsChanged(() => {
            this.invalidateTools();
        });
        this._toolChangeUnsubscribes.set(provider.id, unsubscribe);
    }

    /** 取消 Provider 的工具变更订阅 */
    private _unwatchProvider(providerId: string): void {
        const unsubscribe = this._toolChangeUnsubscribes.get(providerId);
        if (unsubscribe === undefined) return;

        this._toolChangeUnsubscribes.delete(providerId);
        try {
            unsubscribe();
        } catch {
            // 忽略取消订阅异常
        }
    }

    /** 列出所有可用工具（已拼装名称、已填充 source）
     * @param signal 取消信号
     * @returns 工具定义列表；单个 Provider 失败会被隔离，不影响其它 Provider
     * @note 结果会被缓存；并发调用会合并为一次拉取
     */
    async listTools(signal?: AbortSignal): Promise<RegisteredTool[]> {
        if (this._tools !== null) {
            if (!this._isToolCacheExpired()) return this._copyTools(this._tools);
            this.invalidateTools();
        }
        if (this._pendingTools !== null) return this._copyTools(await this._pendingTools);
        if (signal?.aborted === true) return [];

        const generation = this._generation;
        const pending = this._fetchTools(signal, generation);
        this._pendingTools = pending;

        try {
            const tools = await pending;
            return this._copyTools(tools);
        } finally {
            if (this._pendingTools === pending) this._pendingTools = null;
        }
    }

    /** 调用工具
     * @param call 工具调用请求
     * @param options 取消与超时选项
     * @returns 工具调用结果；除 internalError 外的 ToolError 都会转换为结果返回
     * @throws ToolError 当 Provider 抛出 internalError 时（程序缺陷，不作为工具结果）
     * @throws unknown 当 Provider 抛出非 ToolError 异常时（程序缺陷，不作为工具结果）
     */
    async invoke(call: ToolCall, options: ToolInvokeOptions = {}): Promise<ToolCallResult> {
        const startedAt = performance.now();
        const elapsed = (): number => Math.max(0, Math.round(performance.now() - startedAt));

        // 1. 解析模型侧工具名
        const parsed = parseToolName(call.name);
        if (parsed === null) {
            return this._toErrorResult(
                new ToolError(
                    ToolErrorType.NotFound,
                    false,
                    `Invalid tool name "${call.name}": expected "<provider_id>${TOOL_NAME_SEPARATOR}<tool_id>"`,
                ),
                elapsed(),
            );
        }

        // 2. 查找 Provider
        const provider = this._providers.get(parsed.providerId);
        if (provider === undefined) {
            return this._toErrorResult(
                new ToolError(
                    ToolErrorType.NotFound,
                    false,
                    `Unknown tool provider "${parsed.providerId}" for tool "${call.name}"`,
                ),
                elapsed(),
            );
        }

        // 3. 按 inputSchema 校验参数；参数错误同样作为一种工具调用结果返回
        const definition = await this._findTool(call.name, options.signal);
        if (definition !== null) {
            const problems = validateToolParams(definition.inputSchema, call.params);
            if (problems.length > 0) {
                return this._toErrorResult(
                    new ToolError(
                        ToolErrorType.InvalidParams,
                        true,
                        formatParamProblems(call.name, problems),
                    ),
                    elapsed(),
                );
            }
        }

        // 4. 组合取消信号与超时信号
        const timeout = createTimeout(options.timeoutMs);

        try {
            const signal = combineSignals(options.signal, timeout.signal);

            if (isSignalAborted(signal)) {
                return this._toErrorResult(this._abortOrTimeout(options, timeout.signal), elapsed());
            }

            // 5. Provider 只看到裸工具名，前缀由 Registry 负责
            const providerCall: ToolCall = {
                id: call.id,
                name: parsed.toolId,
                params: call.params,
            };

            try {
                const result = await raceWithAbort(provider.call(providerCall, {
                    signal,
                    progressToken: options.progressToken,
                    onProgress: options.onProgress,
                }), signal);
                return this._finalizeResult(result, definition, elapsed());
            } catch (error) {
                if (isSignalAborted(signal)) {
                    return this._toErrorResult(this._abortOrTimeout(options, timeout.signal), elapsed());
                }

                if (isToolError(error)) {
                    // internalError 属于程序缺陷，不作为工具调用结果交给模型
                    if (error.type === ToolErrorType.InternalError) throw error;
                    return this._toErrorResult(error, elapsed());
                }

                // 非 ToolError 一律视为程序缺陷，向上抛出
                throw error;
            }
        } finally {
            timeout.clear();
        }
    }

    /** 统一处理 Provider 结果：时长、文本截断、outputSchema 校验 */
    private _finalizeResult(
        result: ToolCallResult,
        definition: ToolDefinition | null,
        durationMs: number,
    ): ToolCallResult {
        const normalized: ToolCallResult = {
            ...result,
            content: this._truncateContent(result.content),
            status: {
                ...result.status,
                duration: durationMs,
            },
        };

        if (definition?.outputSchema === undefined
            || normalized.status.isSuccess === false
            || normalized.structuredContent === undefined) {
            return normalized;
        }

        const problems = validateToolParams(definition.outputSchema, normalized.structuredContent);
        if (problems.length === 0) return normalized;

        const error = new ToolError(
            ToolErrorType.ProviderError,
            false,
            `Tool result does not match outputSchema: ${problems.join("; ")}`,
        );

        return {
            content: error.message,
            status: {
                isSuccess: false,
                error,
                duration: durationMs,
            },
            structuredContent: undefined,
            raw: normalized.raw,
        };
    }

    /** 按 Registry 上限截断工具结果文本（保留附件引用） */
    private _truncateContent(content: MessageContent): MessageContent {
        const limit = this._maxResultChars;
        if (limit <= 0) return content;

        if (typeof content === "string") {
            return truncateText(content, limit);
        }

        let remaining = limit;
        let truncated = false;
        const parts: ContentPart[] = [];

        for (const part of content) {
            if (part.type === "attachment") {
                parts.push(part);
                continue;
            }
            if (remaining <= 0) {
                truncated = true;
                break;
            }
            if (part.text.length <= remaining) {
                parts.push(part);
                remaining -= part.text.length;
            } else {
                parts.push({ type: "text", text: part.text.slice(0, remaining) });
                remaining = 0;
                truncated = true;
            }
        }

        if (truncated) {
            parts.push({ type: "text", text: "\n\n[... result truncated ...]" });
        }

        return parts;
    }

    /** 工具列表缓存是否已过期 */
    private _isToolCacheExpired(): boolean {
        if (this._toolCacheTtlMs <= 0) return false;
        if (this._toolsCachedAt === null) return false;
        return Date.now() - this._toolsCachedAt >= this._toolCacheTtlMs;
    }

    /** 拉取并拼装所有 Provider 的工具定义 */
    private async _fetchTools(
        signal: AbortSignal | undefined,
        generation: number,
    ): Promise<RegisteredTool[]> {
        const providers = [...this._providers.values()];
        if (providers.length === 0) {
            if (generation === this._generation) {
                this._tools = [];
                this._toolsCachedAt = Date.now();
            }
            return [];
        }

        const settled = await Promise.allSettled(
            providers.map(async (provider) => {
                return { provider, tools: await provider.fetchTools(signal) };
            }),
        );

        const tools: RegisteredTool[] = [];
        const seen = new Set<string>();
        let succeeded = 0;

        settled.forEach((result, index) => {
            const provider = providers[index];

            if (result.status === "rejected") {
                this._reportProviderError(provider.id, result.reason);
                return;
            }

            if (!Array.isArray(result.value.tools)) {
                this._reportProviderError(
                    provider.id,
                    new ToolError(
                        ToolErrorType.ProviderError,
                        false,
                        `Provider "${provider.id}" returned a non-array tool list`,
                    ),
                );
                return;
            }

            succeeded += 1;

            for (const definition of result.value.tools) {
                const tool = this._toRegisteredTool(provider, definition);
                if (tool === null) continue;

                if (seen.has(tool.name)) {
                    this._reportProviderError(
                        provider.id,
                        new ToolError(
                            ToolErrorType.ProviderError,
                            false,
                            `Provider "${provider.id}" returned a duplicate tool name "${tool.name}"`,
                        ),
                    );
                    continue;
                }

                seen.add(tool.name);
                tools.push(tool);
            }
        });

        if (generation === this._generation) {
            // 所有 Provider 都失败时不写缓存，方便下次重试
            this._tools = succeeded > 0 ? tools : null;
            this._toolsCachedAt = this._tools === null ? null : Date.now();
        }

        return tools;
    }

    /** 把 Provider 返回的裸定义拼装成模型侧定义 */
    private _toRegisteredTool(
        provider: ToolProvider,
        definition: ToolDefinition,
    ): RegisteredTool | null {
        const toolId = definition.name;
        if (
            typeof toolId !== "string"
            || toolId.length === 0
            || !TOOL_ID_PATTERN.test(toolId)
            || toolId.includes(TOOL_NAME_SEPARATOR)
        ) {
            this._reportProviderError(
                provider.id,
                new ToolError(
                    ToolErrorType.ProviderError,
                    false,
                    `Provider "${provider.id}" returned an invalid tool name "${String(toolId)}": `
                        + `expected /^[A-Za-z0-9_-]+$/ without "${TOOL_NAME_SEPARATOR}"`,
                ),
            );
            return null;
        }

        if (typeof definition.inputSchema !== "object" || definition.inputSchema === null) {
            this._reportProviderError(
                provider.id,
                new ToolError(
                    ToolErrorType.ProviderError,
                    false,
                    `Tool "${composeToolName(provider.id, toolId)}" has no valid inputSchema`,
                ),
            );
            return null;
        }

        return {
            ...definition,
            name: composeToolName(provider.id, toolId),
            source: { ...definition.source, providerId: provider.id },
        };
    }

    /** 按模型侧全名查找已拼装的工具定义；缓存未命中时先拉取一次 */
    private async _findTool(
        fullName: string,
        signal?: AbortSignal,
    ): Promise<RegisteredTool | null> {
        const cached = this._tools?.find((tool) => tool.name === fullName);
        if (cached !== undefined) return cached;

        const tools = await this.listTools(signal);
        return tools.find((tool) => tool.name === fullName) ?? null;
    }

    /** 返回缓存副本，避免调用方修改内部缓存 */
    private _copyTools(tools: readonly RegisteredTool[]): RegisteredTool[] {
        return tools.map((tool) => ({ ...tool, source: { ...tool.source } }));
    }

    /** 校验 Provider ID，非法时抛出（属于调用方的程序错误） */
    private _assertProviderId(providerId: string): void {
        if (
            providerId.length === 0
            || !PROVIDER_ID_PATTERN.test(providerId)
            || providerId.includes(TOOL_NAME_SEPARATOR)
        ) {
            throw new InvalidParameterError(
                `Invalid tool provider id "${providerId}": expected /^[A-Za-z0-9_-]+$/ `
                    + `without "${TOOL_NAME_SEPARATOR}"`,
            );
        }
    }

    /** 上报单个 Provider 的错误；回调异常不得影响工具列表 */
    private _reportProviderError(providerId: string, error: unknown): void {
        try {
            this._onProviderError?.(providerId, error);
        } catch {
            // 忽略回调自身的异常
        }
    }

    /** 转换错误为工具调用结果 */
    private _toErrorResult(error: ToolError, durationMs: number): ToolCallResult {
        return {
            content: error.message,
            status: {
                isSuccess: false,
                error,
                duration: durationMs,
            },
            structuredContent: undefined,
            raw: undefined,
        };
    }

    /** 判断取消失败原因：用户取消还是超时 */
    private _abortOrTimeout(
        options: ToolInvokeOptions,
        timeoutSignal: AbortSignal | undefined,
    ): ToolError {
        const userAborted = options.signal?.aborted === true;
        const timedOut = timeoutSignal?.aborted === true;

        if (timedOut && !userAborted) {
            return new ToolError(
                ToolErrorType.Timeout,
                true,
                `Tool call timed out after ${options.timeoutMs ?? 0} ms`,
            );
        }

        return new ToolError(ToolErrorType.AbortError, false, "Tool call aborted");
    }
}


/* ---------------------------------------------------------------------------
 * 参数校验：按 ToolParamSchema 做尽力而为的 JSON Schema 校验
 * @note 只校验 schema 中显式声明过的关键字，未声明的部分一律放行
 * ------------------------------------------------------------------------- */

/** 校验工具参数
 * @param schema 工具声明的 inputSchema
 * @param params 模型给出的参数
 * @returns 问题列表；空数组表示通过
 */
export function validateToolParams(schema: ToolParamSchema, params: unknown): string[] {
    const problems: string[] = [];
    validateValue(schema, params, "params", problems);
    return problems;
}

function validateValue(
    schema: ToolParamSchema,
    value: unknown,
    path: string,
    problems: string[],
): void {
    if (problems.length >= MAX_PARAM_PROBLEMS) return;

    const declaredTypes = schema.type === undefined
        ? []
        : Array.isArray(schema.type) ? schema.type : [schema.type];

    if (declaredTypes.length > 0 && !declaredTypes.some((type) => matchesType(type, value))) {
        problems.push(`${path}: expected ${declaredTypes.join(" | ")}, got ${describeValue(value)}`);
        return;
    }

    if (schema.enum !== undefined && !schema.enum.some((candidate) => jsonEquals(candidate, value))) {
        problems.push(`${path}: expected one of ${formatJson(schema.enum)}`);
        return;
    }

    if (matchesType("object", value)) {
        const record = value as Record<string, unknown>;

        for (const key of schema.required ?? []) {
            if (!(key in record)) problems.push(`${path}.${key}: missing required property`);
            if (problems.length >= MAX_PARAM_PROBLEMS) return;
        }

        const properties = schema.properties;
        if (properties !== undefined) {
            for (const [key, childSchema] of Object.entries(properties)) {
                if (!(key in record)) continue;
                validateValue(childSchema, record[key], `${path}.${key}`, problems);
                if (problems.length >= MAX_PARAM_PROBLEMS) return;
            }
        }
    }

    if (matchesType("array", value)) {
        const items = schema.items;
        if (items === undefined) return;

        const values = value as unknown[];
        const itemSchemas = Array.isArray(items) ? items : [items];

        values.forEach((item, index) => {
            const itemSchema = itemSchemas.length === 1 ? itemSchemas[0] : itemSchemas[index];
            if (itemSchema === undefined || problems.length >= MAX_PARAM_PROBLEMS) return;
            validateValue(itemSchema, item, `${path}[${index}]`, problems);
        });
    }
}

/** 判断值是否匹配某个 JSON Schema 类型 */
function matchesType(type: string, value: unknown): boolean {
    switch (type) {
        case "string":
            return typeof value === "string";
        case "number":
            return typeof value === "number" && Number.isFinite(value);
        case "integer":
            return typeof value === "number" && Number.isInteger(value);
        case "boolean":
            return typeof value === "boolean";
        case "object":
            return typeof value === "object" && value !== null && !Array.isArray(value);
        case "array":
            return Array.isArray(value);
        case "null":
            return value === null;
        default:
            // 未识别的类型不阻断调用
            return true;
    }
}

function describeValue(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
}

function jsonEquals(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        return false;
    }
}

function formatJson(value: unknown): string {
    let text: string;
    try {
        text = JSON.stringify(value) ?? String(value);
    } catch {
        text = String(value);
    }
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function formatParamProblems(toolName: string, problems: readonly string[]): string {
    return `Invalid parameters for tool "${toolName}": ${problems.join("; ")}`;
}

/** 截断文本并追加提示 */
function truncateText(text: string, limit: number): string {
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n\n[... truncated: ${text.length - limit} chars omitted ...]`;
}


/* ---------------------------------------------------------------------------
 * 取消 / 超时
 * ------------------------------------------------------------------------- */

/** 判断信号是否已取消
 * @note 用函数包裹，避免 TS 控制流把 abort 状态错误收窄成 false | undefined
 */
function isSignalAborted(signal: AbortSignal | undefined): boolean {
    return signal !== undefined && signal.aborted;
}

/** 创建超时信号
 * @note 刻意使用未被 unref 的 setTimeout：保证“工具调用是唯一待处理任务”时超时也会触发
 * @returns signal 超时信号；clear 清理定时器（调用方必须在结束时调用）
 */
function createTimeout(timeoutMs: number | undefined): { signal?: AbortSignal; clear: () => void } {
    if (timeoutMs === undefined || timeoutMs <= 0) {
        return { signal: undefined, clear: () => { /* 没有定时器 */ } };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    return {
        signal: controller.signal,
        clear: () => clearTimeout(timer),
    };
}

function combineSignals(
    a: AbortSignal | undefined,
    b: AbortSignal | undefined,
): AbortSignal | undefined {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return AbortSignal.any([a, b]);
}

/** 让 Promise 与取消信号竞速，保证不响应 signal 的 Provider 也能及时返回 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (signal === undefined) return promise;
    if (signal.aborted) return Promise.reject(createAbortError());

    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(createAbortError());
        signal.addEventListener("abort", onAbort, { once: true });

        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}

function createAbortError(): ToolError {
    return new ToolError(ToolErrorType.AbortError, false, "Tool call aborted");
}

