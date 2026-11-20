import { InvalidParameterError } from "../src/base";
import { MiniMaxH3ImageProvider } from "../src/platform/minimax";
import type { MiniMaxH3ImageProviderOptions } from "../src/platform/minimax";
import type { AttachmentFile } from "../src/session/attachment";
import { isContentHash } from "../src/session/attachment";
import { ToolError, ToolErrorType } from "../src/session/error";
import type { PendingAttachment } from "../src/session/media";
import type { GenerationCapability, GenerationRequest } from "../src/session/protocol";
import type { ToolCall, ToolCallResult, ToolDefinition } from "../src/session/type";
import type { ToolCallOptions, ToolProvider } from "../src/session/tool";

/** 默认工具超时：H3-Image 服务端等待上限为 600s */
export const DEFAULT_MINIMAX_IMAGE_TOOL_TIMEOUT_MS = 600_000;

/** 工具超时的最大允许值（与 Session 的 1h 上限一致） */
const MAX_TOOL_TIMEOUT_MS = 3_600_000;

export type MiniMaxImageToolOptions = {
    /** 已构造好的 GenerationCapability；用于测试或复用现有 Provider */
    provider: GenerationCapability;

    /** ToolProvider ID，默认 "minimax-image" */
    id?: string;

    /** 默认图片尺寸；调用参数中的 size 优先 */
    size?: string;

    /** 工具建议超时，默认 600s */
    adviceTimeoutMs?: number;

    /** 把模型给出的 contentHash 解析为本会话附件；支持参考图时由宿主注入 */
    resolveReference?: (contentHash: string) => Promise<AttachmentFile | undefined>;
};

/** 把 MiniMax H3-Image 包装成多模态产出工具（本地参考实现）
 *
 * ToolCallResult.attachments 由 Session 统一写入 IFileHost；工具本身不接触附件存储。
 */
export class MiniMaxImageToolProvider implements ToolProvider {

    readonly id: string;
    readonly name: string;
    readonly description: string;

    private readonly _provider: GenerationCapability;
    private readonly _size: string | undefined;
    private readonly _resolveReference: MiniMaxImageToolOptions["resolveReference"];
    private readonly _definition: ToolDefinition;

    constructor(options: MiniMaxImageToolOptions){
        if (options.provider === undefined || options.provider === null){
            throw new InvalidParameterError("MiniMaxImageToolProvider requires a GenerationCapability");
        }

        const adviceTimeoutMs = normalizeTimeout(options.adviceTimeoutMs);
        this.id = options.id ?? "minimax-image";
        this.name = "MiniMax Image";
        this.description = "MiniMax H3-Image 多模态产出工具";
        this._provider = options.provider;
        this._size = options.size;
        this._resolveReference = options.resolveReference;
        this._definition = {
            name: "generateImage",
            title: "Generate Image",
            description: "使用 MiniMax H3-Image 生成图片，或基于参考图片进行编辑；图片会作为工具媒体回传给模型。",
            inputSchema: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                        description: "图片生成提示词",
                    },
                    size: {
                        type: "string",
                        description: "可选尺寸，例如 1024x1024；不传时使用工具默认尺寸",
                    },
                    references: {
                        type: "array",
                        description: "可选参考图，最多 16 张。每项为当前会话附件的 contentHash"
                            + "（来自 [media:<contentHash>] 或 [tool media reference: <contentHash>] 标记），"
                            + "或 http(s)/data:image 图片 URL。",
                        items: { type: "string" },
                        maxItems: 16,
                    },
                    seed: {
                        type: "integer",
                        description: "可选随机种子；用于复现或固定构图",
                    },
                    negative_prompt: {
                        type: "string",
                        description: "可选负向提示词，描述不希望出现的元素",
                    },
                },
                required: ["prompt"],
            },
            annotations: {
                readOnlyHint: false,
                concurrencySafe: false,
                requiresApproval: true,
            },
            adviceTimeout: adviceTimeoutMs,
        };
    }

    async fetchTools(): Promise<ToolDefinition[]>{
        return [this._definition];
    }

    async call(call: ToolCall, options?: ToolCallOptions): Promise<ToolCallResult>{
        const prompt = call.params.prompt;
        if (typeof prompt !== "string" || prompt.trim().length === 0){
            throw new ToolError(
                ToolErrorType.InvalidParams,
                true,
                "generateImage requires a non-empty prompt",
            );
        }

        const requestedSize = call.params.size;
        const size = typeof requestedSize === "string" && requestedSize.length > 0
            ? requestedSize
            : this._size;

        const parameters: Record<string, unknown> = {
            n: 1,
            response_format: "b64_json",
            output_format: "png",
        };
        if (size !== undefined) parameters.size = size;

        const seed = call.params.seed;
        if (seed !== undefined){
            if (!Number.isInteger(seed)){
                throw new ToolError(
                    ToolErrorType.InvalidParams,
                    true,
                    "generateImage seed must be an integer",
                );
            }
            parameters.seed = seed;
        }

        const negativePrompt = call.params.negative_prompt;
        if (negativePrompt !== undefined){
            if (typeof negativePrompt !== "string"){
                throw new ToolError(
                    ToolErrorType.InvalidParams,
                    true,
                    "generateImage negative_prompt must be a string",
                );
            }
            parameters.negative_prompt = negativePrompt;
        }

        const { files, urls } = await this._parseReferences(call.params.references);
        const request: GenerationRequest = {
            modality: "image",
            prompt: prompt.trim(),
            parameters,
            ...(files.length === 0 ? {} : {
                references: files.map((file) => ({ contentHash: file.contentHash })),
                referenceFiles: files,
            }),
            ...(urls.length === 0 ? {} : { referenceUrls: urls }),
        };

        try{
            const task = await this._provider.generate(request, { signal: options?.signal });
            const media = await task.wait({ signal: options?.signal });
            const first = media[0];
            if (first === undefined){
                throw new ToolError(
                    ToolErrorType.ProviderError,
                    false,
                    "MiniMax image generation returned no media",
                );
            }

            return {
                content: "Generated image.",
                status: { isSuccess: true, duration: 0 },
                attachments: [toPendingAttachment(first)],
            };
        }catch(error){
            if (error instanceof ToolError) throw error;
            throw new ToolError(
                ToolErrorType.ProviderError,
                false,
                error instanceof Error ? error.message : String(error),
                error,
            );
        }
    }

    /** 解析模型给出的参考图：contentHash 或平台支持的图片 URL */
    private async _parseReferences(value: unknown): Promise<{
        files: AttachmentFile[];
        urls: string[];
    }>{
        if (value === undefined || value === null) return { files: [], urls: [] };
        if (!Array.isArray(value)){
            throw new ToolError(
                ToolErrorType.InvalidParams,
                true,
                "generateImage references must be an array",
            );
        }
        if (value.length > 16){
            throw new ToolError(
                ToolErrorType.InvalidParams,
                true,
                "generateImage supports at most 16 reference images",
            );
        }

        const files: AttachmentFile[] = [];
        const urls: string[] = [];

        for (const [index, item] of value.entries()){
            if (typeof item !== "string" || item.trim().length === 0){
                throw new ToolError(
                    ToolErrorType.InvalidParams,
                    true,
                    `generateImage references[${index}] must be a non-empty string`,
                );
            }

            const reference = item.trim();
            const contentHash = reference.length === 64 ? reference.toLowerCase() : reference;
            if (isContentHash(contentHash)){
                if (this._resolveReference === undefined){
                    throw new ToolError(
                        ToolErrorType.InvalidParams,
                        true,
                        "generateImage contentHash references require resolveReference",
                    );
                }
                const file = await this._resolveReference(contentHash);
                if (file === undefined){
                    throw new ToolError(
                        ToolErrorType.InvalidParams,
                        true,
                        `generateImage reference attachment not found: ${contentHash}`,
                    );
                }
                files.push(file);
                continue;
            }

            if (isSupportedReferenceUrl(reference)){
                urls.push(reference);
                continue;
            }

            throw new ToolError(
                ToolErrorType.InvalidParams,
                true,
                `generateImage references[${index}] is neither a contentHash nor a supported image URL`,
            );
        }

        return { files, urls };
    }

    async close(): Promise<void>{
        // MiniMaxH3ImageProvider 没有常驻连接
    }
}

function isSupportedReferenceUrl(value: string): boolean{
    if (value.startsWith("data:image/") || value.startsWith("mm_file://")) return true;
    try{
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    }catch{
        return false;
    }
}

/** 快捷构造：用 MiniMax H3-Image 选项直接创建一个本地工具 Provider */
export function createMiniMaxImageToolProvider(
    options: MiniMaxH3ImageProviderOptions & {
        id?: string;
        size?: string;
        adviceTimeoutMs?: number;
        resolveReference?: (contentHash: string) => Promise<AttachmentFile | undefined>;
    },
): MiniMaxImageToolProvider{
    return new MiniMaxImageToolProvider({
        provider: new MiniMaxH3ImageProvider(options),
        id: options.id,
        size: options.size,
        adviceTimeoutMs: options.adviceTimeoutMs,
        resolveReference: options.resolveReference,
    });
}

function toPendingAttachment(media: {
    kind: "bytes" | "url" | "remote-id";
    name?: string;
    mimeType?: string;
    data?: Uint8Array;
    url?: string;
    id?: string;
}): PendingAttachment{
    switch (media.kind){
        case "bytes":
            if (media.data === undefined){
                throw new ToolError(
                    ToolErrorType.ProviderError,
                    false,
                    "MiniMax image returned empty byte media",
                );
            }
            return {
                kind: "bytes",
                data: media.data,
                name: media.name ?? "minimax-image.png",
                mimeType: media.mimeType,
                origin: "tool",
            };

        case "url":
            if (media.url === undefined || media.url.length === 0){
                throw new ToolError(
                    ToolErrorType.ProviderError,
                    false,
                    "MiniMax image returned an empty URL",
                );
            }
            return {
                kind: "url",
                url: media.url,
                name: media.name,
                mimeType: media.mimeType,
                origin: "tool",
            };

        case "remote-id":
            throw new ToolError(
                ToolErrorType.ProviderError,
                false,
                "MiniMax image remote-id media requires an AttachmentIngestor.resolveRemote",
            );
    }
}

function normalizeTimeout(value: number | undefined): number{
    if (value === undefined) return DEFAULT_MINIMAX_IMAGE_TOOL_TIMEOUT_MS;
    if (!Number.isInteger(value) || value <= 0){
        throw new InvalidParameterError(
            `adviceTimeoutMs must be a positive integer, got ${String(value)}`,
        );
    }
    return Math.min(value, MAX_TOOL_TIMEOUT_MS);
}
