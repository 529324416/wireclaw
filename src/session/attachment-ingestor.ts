import { InvalidParameterError } from "../base";
import type { AttachmentFileManager } from "./attachment-manager";
import { SessionError, SessionErrorType } from "./error";
import { detectMediaMimeType, normalizeMediaName } from "./media";
import type { PendingAttachment } from "./media";
import type { AttachmentRef } from "./type";

/** 默认单文件上限：64 MiB；与 DeepSeek Files API 的上限保持一致 */
export const DEFAULT_ATTACHMENT_MAX_BYTES = 64 * 1024 * 1024;

const DEFAULT_MEDIA_NAME = "attachment.bin";

export type AttachmentIngestorOptions = {
    /** 自定义 fetch；浏览器/Electron 可以注入宿主代理 */
    fetch?: typeof fetch;

    /** 单文件字节上限，默认 64 MiB */
    maxBytes?: number;

    /** 允许的 MIME 列表；未设置时不额外限制 */
    allowedMimeTypes?: readonly string[];

    /** 是否允许下载 URL 媒体；默认 true，但只允许 http/https */
    allowUrl?: boolean;

    /** 是否允许访问 localhost / 私有地址；默认 false */
    allowPrivateHosts?: boolean;

    /** 额外的 URL 安全校验；抛出异常即拒绝 */
    assertUrl?: (url: URL) => void;

    /** 解析 remote-id 媒体；不提供时遇到 remote-id 会失败 */
    resolveRemote?: (
        attachment: Extract<PendingAttachment, { kind: "remote-id" }>,
        signal?: AbortSignal,
    ) => Promise<Uint8Array>;
};

/** 把 Provider 产出的媒体落盘为附件引用
 *
 * @note 该层只处理“已经产出的媒体描述”，不负责生成任务轮询。
 *       URL 下载是可选的，并且必须经过协议、大小、MIME 和地址校验。
 */
export class AttachmentIngestor {

    private readonly _manager: AttachmentFileManager;
    private readonly _fetch: typeof fetch | undefined;
    private readonly _maxBytes: number;
    private readonly _allowedMimeTypes: readonly string[] | undefined;
    private readonly _allowUrl: boolean;
    private readonly _allowPrivateHosts: boolean;
    private readonly _assertUrl: ((url: URL) => void) | undefined;
    private readonly _resolveRemote: AttachmentIngestorOptions["resolveRemote"];

    constructor(manager: AttachmentFileManager, options: AttachmentIngestorOptions = {}){
        if (manager === undefined || manager === null){
            throw new InvalidParameterError("AttachmentIngestor requires an AttachmentFileManager");
        }

        const maxBytes = options.maxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES;
        if (!Number.isInteger(maxBytes) || maxBytes <= 0){
            throw new InvalidParameterError(
                `maxBytes must be a positive integer, got ${String(options.maxBytes)}`,
            );
        }

        this._manager = manager;
        this._fetch = options.fetch ?? (typeof fetch === "function" ? fetch : undefined);
        this._maxBytes = maxBytes;
        this._allowedMimeTypes = options.allowedMimeTypes?.map((item) => item.toLowerCase());
        this._allowUrl = options.allowUrl ?? true;
        this._allowPrivateHosts = options.allowPrivateHosts ?? false;
        this._assertUrl = options.assertUrl;
        this._resolveRemote = options.resolveRemote;
    }

    /** 将媒体写入 AttachmentFileManager，并返回内容引用 */
    async ingest(
        attachment: PendingAttachment,
        options: { signal?: AbortSignal } = {},
    ): Promise<AttachmentRef>{
        const media = await this._read(attachment, options.signal);

        this._assertSize(media.data, attachment.kind);

        // 平台返回的 output_format 可能不可靠（例如请求 png 但实际是 jpeg），
        // 落盘前以文件头识别结果为准。
        const detectedMime = detectMediaMimeType(media.data);
        const effectiveMime = detectedMime ?? media.mimeType;
        this._assertMime(effectiveMime, attachment.kind);

        const baseName = normalizeName(attachment.name)
            ?? nameFromUrl(attachment.kind === "url" ? attachment.url : undefined)
            ?? DEFAULT_MEDIA_NAME;
        const name = normalizeMediaName(baseName, effectiveMime);

        const file = await this._manager.put(name, media.data, effectiveMime);
        return { contentHash: file.contentHash };
    }

    private async _read(
        attachment: PendingAttachment,
        signal?: AbortSignal,
    ): Promise<{ data: Uint8Array; mimeType?: string }>{
        switch (attachment.kind){
            case "bytes":
                return {
                    data: attachment.data,
                    mimeType: attachment.mimeType,
                };

            case "remote-id": {
                if (this._resolveRemote === undefined){
                    throw new SessionError(
                        SessionErrorType.InvalidRequest,
                        "remote-id media requires AttachmentIngestor.resolveRemote",
                    );
                }
                const data = await this._resolveRemote(attachment, signal);
                return { data, mimeType: attachment.mimeType };
            }

            case "url": {
                if (!this._allowUrl){
                    throw new SessionError(
                        SessionErrorType.InvalidRequest,
                        "URL media is disabled by AttachmentIngestorOptions.allowUrl",
                    );
                }
                if (this._fetch === undefined){
                    throw new SessionError(
                        SessionErrorType.InvalidRequest,
                        "URL media requires a fetch implementation",
                    );
                }

                const url = parseRemoteUrl(attachment.url, this._allowPrivateHosts, this._assertUrl);
                let response: Response;
                try{
                    response = await this._fetch(url, {
                        method: "GET",
                        redirect: "follow",
                        signal,
                    });
                }catch(error){
                    if (signal?.aborted === true) throw error;
                    throw new SessionError(
                        SessionErrorType.NetworkError,
                        `Failed to download generated media: ${url.toString()}`,
                        error,
                    );
                }

                if (!response.ok){
                    throw new SessionError(
                        SessionErrorType.ProviderError,
                        `Generated media download returned HTTP ${response.status}`,
                    );
                }

                // 跟随重定向后再次校验最终地址，避免初始地址安全但最终落到私有地址
                if (response.url.length > 0){
                    parseRemoteUrl(response.url, this._allowPrivateHosts, this._assertUrl);
                }

                const declaredLength = Number(response.headers.get("content-length") ?? "");
                if (Number.isFinite(declaredLength) && declaredLength > this._maxBytes){
                    throw new SessionError(
                        SessionErrorType.InvalidData,
                        `Generated media exceeds ${this._maxBytes} bytes`,
                    );
                }

                let buffer: ArrayBuffer;
                try{
                    buffer = await response.arrayBuffer();
                }catch(error){
                    if (signal?.aborted === true) throw error;
                    throw new SessionError(
                        SessionErrorType.NetworkError,
                        "Failed to read generated media body",
                        error,
                    );
                }

                const data = new Uint8Array(buffer);
                this._assertSize(data, attachment.kind);

                const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
                return {
                    data,
                    mimeType: attachment.mimeType
                        ?? (contentType !== undefined && contentType.length > 0 ? contentType : undefined),
                };
            }

            default:
                throw new InvalidParameterError("Unsupported PendingAttachment kind");
        }
    }

    private _assertSize(data: Uint8Array, kind: string): void{
        if (data.byteLength > this._maxBytes){
            throw new SessionError(
                SessionErrorType.InvalidData,
                `Generated ${kind} media exceeds ${this._maxBytes} bytes`,
            );
        }
    }

    private _assertMime(mimeType: string | undefined, kind: string): void{
        if (this._allowedMimeTypes === undefined || this._allowedMimeTypes.length === 0) return;
        if (mimeType === undefined){
            throw new SessionError(
                SessionErrorType.InvalidData,
                `Generated ${kind} media has no MIME type`,
            );
        }
        if (!this._allowedMimeTypes.includes(mimeType.toLowerCase())){
            throw new SessionError(
                SessionErrorType.InvalidData,
                `Generated ${kind} media has unsupported MIME type: ${mimeType}`,
            );
        }
    }
}

function normalizeName(value: string | undefined): string | undefined{
    if (value === undefined) return undefined;
    const name = value.trim();
    return name.length > 0 ? name : undefined;
}

function nameFromUrl(value: string | undefined): string | undefined{
    if (value === undefined) return undefined;
    try{
        const pathname = new URL(value).pathname;
        const name = pathname.split("/").filter((part) => part.length > 0).pop();
        return name === undefined || name.length === 0 ? undefined : decodeURIComponent(name);
    }catch{
        return undefined;
    }
}

function parseRemoteUrl(
    value: string,
    allowPrivateHosts: boolean,
    assertUrl: ((url: URL) => void) | undefined,
): URL{
    let url: URL;
    try{
        url = new URL(value);
    }catch{
        throw new SessionError(SessionErrorType.InvalidData, `Invalid generated media URL: ${value}`);
    }

    if (url.protocol !== "https:" && url.protocol !== "http:"){
        throw new SessionError(
            SessionErrorType.InvalidData,
            `Generated media URL must use http or https, got "${url.protocol}"`,
        );
    }

    if (!allowPrivateHosts && isPrivateHost(url.hostname)){
        throw new SessionError(
            SessionErrorType.InvalidData,
            `Generated media URL points to a private host: ${url.hostname}`,
        );
    }

    assertUrl?.(url);
    return url;
}

function isPrivateHost(hostname: string): boolean{
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

    if (host === "localhost" || host.endsWith(".localhost")) return true;
    if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
    if (host === "0.0.0.0") return true;

    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (ipv4 === null) return false;

    const octets = ipv4.slice(1).map((part) => Number(part));
    if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;

    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
}
