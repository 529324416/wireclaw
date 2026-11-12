import { isToolError, ToolError, ToolErrorType } from "../../session/error";
import type { ToolCall, ToolCallResult, ToolDefinition, ToolParamSchema } from "../../session/type";
import type { ToolCallOptions, ToolProvider } from "../../session/tool";
import { McpClient } from "./client";
import { createTransport } from "./config";
import {
    McpAbortError,
    McpProtocolError,
    McpResponseError,
    McpTimeoutError,
    McpTransportError,
} from "./error";
import { createToolNameMappings } from "./naming";
import { isRecord } from "./type";
import type { McpApprovalMode, McpServerConfig } from "./config";
import type { McpCallToolResult, McpProgressNotification, McpTool, McpToolAnnotations } from "./type";
import type { McpTransport } from "./transport";

/**
 * 把外部 MCP Server 映射成 Rotom 的 ToolProvider。
 *
 * - 工具名：MCP 原始名 -> 模型安全 id（见 naming.ts）
 * - 注解：readOnlyHint / destructiveHint 等直接透传
 * - 审批：approval=auto 时，非只读工具默认需要审批
 * - 结果：content 合并为文本，structuredContent / raw 保留
 */
export class McpToolProvider implements ToolProvider {

    readonly id: string;
    readonly name: string;
    readonly description: string;

    private readonly _config: McpServerConfig;
    private readonly _client: McpClient;
    private readonly _approval: McpApprovalMode;
    private readonly _concurrencySafe: boolean;

    /** safeId -> MCP 原始工具名 */
    private _bySafeName = new Map<string, string>();
    private _loaded = false;

    constructor(config: McpServerConfig, transport: McpTransport) {
        this._config = config;
        this.id = config.id;
        this.name = config.name ?? config.id;
        this.description = config.description ?? `MCP server "${config.id}"`;
        this._approval = config.approval ?? "auto";
        this._concurrencySafe = config.concurrencySafe ?? false;

        this._client = new McpClient(transport, {
            clientInfo: { name: "rotom", version: "1.0.0" },
            protocolVersion: config.protocolVersion,
            timeoutMs: config.requestTimeoutMs,
            heartbeatIntervalMs: config.heartbeatIntervalMs ?? 30_000,
        });
    }

    /** 服务端心跳是否健康 */
    get isHealthy(): boolean {
        return this._client.isHealthy;
    }

    async fetchTools(signal?: AbortSignal): Promise<ToolDefinition[]> {
        const tools = await this._withReconnect(async () => {
            await this._client.connect();
            return await this._client.listTools({ signal });
        }, signal);

        const mappings = createToolNameMappings(tools);
        const byOriginal = new Map(tools.map((tool) => [tool.name, tool] as const));

        const bySafe = new Map<string, string>();
        const definitions: ToolDefinition[] = [];

        for (const mapping of mappings) {
            const tool = byOriginal.get(mapping.originalName);
            if (tool === undefined) continue;

            bySafe.set(mapping.safeName, mapping.originalName);
            definitions.push(this._toDefinition(tool, mapping.safeName));
        }

        this._bySafeName = bySafe;
        this._loaded = true;
        return definitions;
    }

    async call(call: ToolCall, options?: ToolCallOptions): Promise<ToolCallResult> {
        if (!this._loaded) {
            await this.fetchTools(options?.signal);
        }

        const originalName = this._bySafeName.get(call.name);
        if (originalName === undefined) {
            throw new ToolError(
                ToolErrorType.NotFound,
                false,
                `Unknown MCP tool "${call.name}"`,
            );
        }

        const onProgress = options?.onProgress === undefined
            ? undefined
            : (progress: McpProgressNotification): void => {
                options.onProgress?.({
                    callId: call.id,
                    progress: progress.progress,
                    total: progress.total,
                    message: progress.message,
                    updatedAt: Date.now(),
                });
            };

        try {
            const result = await this._client.callTool(originalName, call.params, {
                signal: options?.signal,
                // 超时由 Session/Registry 统一控制；配置了服务端级超时才覆盖
                timeoutMs: this._config.requestTimeoutMs ?? 0,
                progressToken: options?.progressToken,
                onProgress,
            });
            return mapCallToolResult(result);
        } catch (error) {
            // 工具调用不自动重试，避免重复副作用；只尝试重连以便后续调用
            if (error instanceof McpTransportError && options?.signal?.aborted !== true) {
                try {
                    await this._client.reconnect();
                } catch {
                    // 重连失败则保持断开，让上层看到 NetworkError
                }
            }
            throw toToolError(error);
        }
    }

    async close(): Promise<void> {
        await this._client.close();
    }

    onToolsChanged(listener: () => void): () => void {
        return this._client.onToolsChanged(listener);
    }

    /** 传输错误时重连并重试一次；Abort 不重试 */
    private async _withReconnect<T>(
        operation: () => Promise<T>,
        signal?: AbortSignal,
    ): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            if (!(error instanceof McpTransportError) || signal?.aborted === true) {
                throw error;
            }

            await this._client.reconnect();
            return await operation();
        }
    }

    private _toDefinition(tool: McpTool, safeName: string): ToolDefinition {
        return {
            name: safeName,
            title: tool.title ?? tool.name,
            description: tool.description ?? tool.name,
            inputSchema: normalizeInputSchema(tool.inputSchema),
            ...(tool.outputSchema === undefined
                ? {}
                : { outputSchema: normalizeInputSchema(tool.outputSchema) }),
            annotations: {
                readOnlyHint: tool.annotations?.readOnlyHint,
                destructiveHint: tool.annotations?.destructiveHint,
                idempotentHint: tool.annotations?.idempotentHint,
                openWorldHint: tool.annotations?.openWorldHint,
                concurrencySafe: this._concurrencySafe,
                requiresApproval: this._requiresApproval(tool.annotations),
            },
            source: {
                providerId: this.id,
                serverName: this._client.serverInfo?.name,
                version: this._client.serverInfo?.version,
            },
        };
    }

    private _requiresApproval(annotations: McpToolAnnotations | undefined): boolean {
        switch (this._approval) {
            case "always":
                return true;
            case "never":
                return false;
            default:
                // 只读工具自动放行，其余外部工具默认需要审批
                return annotations?.readOnlyHint !== true;
        }
    }
}

/** 从配置创建 McpToolProvider */
export function createMcpProvider(config: McpServerConfig): McpToolProvider {
    return new McpToolProvider(config, createTransport(config.transport));
}

function normalizeInputSchema(schema: Record<string, unknown> | undefined): ToolParamSchema {
    if (!isRecord(schema)) {
        return { type: "object", properties: {} };
    }

    const normalized = { ...(schema as unknown as ToolParamSchema) };
    if (normalized.type === undefined) {
        normalized.type = "object";
    }
    if (normalized.type === "object" && normalized.properties === undefined) {
        normalized.properties = {};
    }

    return normalized;
}

function mapCallToolResult(result: McpCallToolResult): ToolCallResult {
    const parts = Array.isArray(result.content) ? result.content : [];
    const text = parts.map(contentToText).filter((part) => part.length > 0).join("\n");
    const isSuccess = result.isError !== true;

    return {
        content: text,
        status: isSuccess
            ? { isSuccess: true, duration: 0 }
            : {
                isSuccess: false,
                duration: 0,
                error: new ToolError(
                    ToolErrorType.ProviderError,
                    false,
                    text.length > 0 ? text : "MCP tool returned an error",
                ),
            },
        structuredContent: isRecord(result.structuredContent) ? result.structuredContent : undefined,
        raw: result,
    };
}

function contentToText(part: unknown): string {
    if (!isRecord(part) || typeof part.type !== "string") return "";

    switch (part.type) {
        case "text":
            return typeof part.text === "string" ? part.text : "";

        case "image":
            return `[image ${typeof part.mimeType === "string" ? part.mimeType : "unknown"}]`;

        case "audio":
            return `[audio ${typeof part.mimeType === "string" ? part.mimeType : "unknown"}]`;

        case "resource_link":
            return `[resource ${typeof part.uri === "string" ? part.uri : "unknown"}]`;

        case "resource": {
            const resource = isRecord(part.resource) ? part.resource : {};
            if (typeof resource.text === "string") return resource.text;
            return `[resource ${typeof resource.uri === "string" ? resource.uri : "unknown"}]`;
        }

        default:
            return `[unsupported content "${part.type}"]`;
    }
}

function toToolError(error: unknown): ToolError {
    if (isToolError(error)) return error;

    if (error instanceof McpAbortError) {
        return new ToolError(ToolErrorType.AbortError, false, error.message, error);
    }
    if (error instanceof McpTimeoutError) {
        return new ToolError(ToolErrorType.Timeout, true, error.message, error);
    }
    if (error instanceof McpTransportError) {
        return new ToolError(ToolErrorType.NetworkError, true, error.message, error);
    }
    if (error instanceof McpResponseError) {
        return new ToolError(
            ToolErrorType.ProviderError,
            false,
            `MCP error ${error.rpcCode}: ${error.message}`,
            error,
        );
    }
    if (error instanceof McpProtocolError) {
        return new ToolError(ToolErrorType.ProviderError, false, error.message, error);
    }

    return new ToolError(
        ToolErrorType.ProviderError,
        false,
        error instanceof Error ? error.message : String(error),
        error,
    );
}
