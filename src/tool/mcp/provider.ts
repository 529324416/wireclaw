import { fromBase64 } from "../../base";
import { DEFAULT_ATTACHMENT_MAX_BYTES } from "../../session/attachment-ingestor";
import { isToolError, ToolError, ToolErrorType } from "../../session/error";
import type { PendingAttachment } from "../../session/media";
import type { ToolCall, ToolCallResult, ToolDefinition, ToolParamSchema, ToolTrust } from "../../session/type";
import type { ToolCallOptions, ToolProvider } from "../../session/tool";
import { McpClient } from "./client";
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
import type {
    McpCallToolResult,
    McpContent,
    McpProgressNotification,
    McpTool,
    McpToolAnnotations,
} from "./type";
import type { McpTransport } from "./transport";

/**
 * 把外部 MCP Server 映射成 Wireclaw 的 ToolProvider。
 *
 * - 工具名：MCP 原始名 -> 模型安全 id（见 naming.ts）
 * - 注解：readOnlyHint / destructiveHint 等直接透传
 * - 审批：approval=auto 时，非只读工具默认需要审批
 * - 结果：文本/结构化内容保留；image/audio/resource 转为待落盘附件
 */
export class McpToolProvider implements ToolProvider {

    readonly id: string;
    readonly name: string;
    readonly description: string;

    /** 外部 MCP 工具默认按不可信处理；宿主可通过 trustHandle 覆盖 */
    readonly defaultTrust: ToolTrust = "untrusted";

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
            clientInfo: { name: "wireclaw", version: "1.0.0" },
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
            return mapCallToolResult(result, call);
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
        const adviceTimeout = resolveAdviceTimeout(
            tool.adviceTimeout,
            this._config.adviceTimeoutMs,
        );

        return {
            name: safeName,
            title: tool.title ?? tool.name,
            description: tool.description ?? tool.name,
            inputSchema: normalizeInputSchema(tool.inputSchema),
            ...(tool.outputSchema === undefined
                ? {}
                : { outputSchema: normalizeInputSchema(tool.outputSchema) }),
            ...(adviceTimeout === undefined ? {} : { adviceTimeout }),
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

function resolveAdviceTimeout(
    toolValue: unknown,
    configValue: number | undefined,
): number | undefined {
    const value = typeof toolValue === "number" && Number.isFinite(toolValue)
        ? toolValue
        : configValue;
    if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
    return Math.min(Math.floor(value), 3_600_000);
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

function mapCallToolResult(result: McpCallToolResult, call: ToolCall): ToolCallResult {
    const parts = Array.isArray(result.content) ? result.content : [];
    const isSuccess = result.isError !== true;
    const textParts: string[] = [];
    const attachments: PendingAttachment[] = [];

    if (isSuccess) {
        for (const [index, part] of parts.entries()) {
            const mapped = mapContentPart(part, call, index);
            if (mapped.text !== undefined && mapped.text.length > 0) textParts.push(mapped.text);
            if (mapped.attachment !== undefined) attachments.push(mapped.attachment);
        }
    } else {
        // 错误结果只保留文本，避免把诊断媒体写入附件库
        for (const part of parts) {
            const text = contentToText(part);
            if (text.length > 0) textParts.push(text);
        }
    }

    const text = textParts.join("\n");

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
        ...(attachments.length > 0 ? { attachments } : {}),
        structuredContent: isRecord(result.structuredContent) ? result.structuredContent : undefined,
        raw: result,
    };
}

function mapContentPart(
    part: unknown,
    call: ToolCall,
    index: number,
): { text?: string; attachment?: PendingAttachment } {
    if (!isRecord(part) || typeof part.type !== "string") return {};

    switch (part.type) {
        case "text":
            return { text: typeof part.text === "string" ? part.text : "" };

        case "image": {
            if (typeof part.data !== "string" || part.data.length === 0) {
                return { text: `[image ${typeof part.mimeType === "string" ? part.mimeType : "unknown"}]` };
            }
            return {
                attachment: {
                    kind: "bytes",
                    name: `mcp-${call.name}-${index}`,
                    mimeType: typeof part.mimeType === "string" ? part.mimeType : undefined,
                    data: decodeMcpBase64(part.data, "MCP image"),
                    origin: "tool",
                },
            };
        }

        case "audio": {
            if (typeof part.data !== "string" || part.data.length === 0) {
                return { text: `[audio ${typeof part.mimeType === "string" ? part.mimeType : "unknown"}]` };
            }
            return {
                attachment: {
                    kind: "bytes",
                    name: `mcp-${call.name}-${index}`,
                    mimeType: typeof part.mimeType === "string" ? part.mimeType : undefined,
                    data: decodeMcpBase64(part.data, "MCP audio"),
                    origin: "tool",
                },
            };
        }

        case "resource_link": {
            const uri = typeof part.uri === "string" ? part.uri : undefined;
            if (uri !== undefined && isHttpUrl(uri)) {
                return {
                    attachment: {
                        kind: "url",
                        url: uri,
                        name: nameFromUri(uri),
                        mimeType: typeof part.mimeType === "string" ? part.mimeType : undefined,
                        origin: "tool",
                    },
                };
            }
            return { text: `[resource ${uri ?? "unknown"}]` };
        }

        case "resource": {
            const resource = isRecord(part.resource) ? part.resource : {};
            if (typeof resource.text === "string") return { text: resource.text };

            const uri = typeof resource.uri === "string" ? resource.uri : undefined;
            if (typeof resource.blob === "string" && resource.blob.length > 0) {
                return {
                    attachment: {
                        kind: "bytes",
                        name: nameFromUri(uri) ?? `mcp-resource-${index}`,
                        mimeType: typeof resource.mimeType === "string"
                            ? resource.mimeType
                            : undefined,
                        data: decodeMcpBase64(resource.blob, "MCP resource"),
                        origin: "tool",
                    },
                };
            }

            return { text: `[resource ${uri ?? "unknown"}]` };
        }

        default:
            return { text: `[unsupported content "${part.type}"]` };
    }
}

function contentToText(part: McpContent | unknown): string {
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

function decodeMcpBase64(value: string, label: string): Uint8Array {
    const maxBase64Length = Math.ceil(DEFAULT_ATTACHMENT_MAX_BYTES * 4 / 3) + 8;
    if (value.length > maxBase64Length) {
        throw new ToolError(
            ToolErrorType.ProviderError,
            false,
            `${label} exceeds the ${DEFAULT_ATTACHMENT_MAX_BYTES} byte attachment limit`,
        );
    }

    try {
        return fromBase64(value);
    } catch (error) {
        throw new ToolError(
            ToolErrorType.ProviderError,
            false,
            `Invalid ${label} base64 data`,
            error,
        );
    }
}

function isHttpUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

function nameFromUri(value: string | undefined): string | undefined {
    if (value === undefined || value.length === 0) return undefined;
    try {
        const pathname = new URL(value).pathname;
        const name = pathname.split("/").filter((part) => part.length > 0).pop();
        return name === undefined || name.length === 0 ? undefined : decodeURIComponent(name);
    } catch {
        return undefined;
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
