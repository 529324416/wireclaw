/* 媒体载荷类型：Provider 输出与附件入口之间的公共协议 */

/** Provider 生成的媒体
 * - bytes：直接返回字节
 * - url：返回可下载地址
 * - remote-id：返回平台文件 ID，需要宿主提供解析器
 */
export type GeneratedMedia =
    | {
        kind: "bytes";
        name?: string;
        mimeType?: string;
        data: Uint8Array;
    }
    | {
        kind: "url";
        url: string;
        name?: string;
        mimeType?: string;
        expiresAt?: number;
    }
    | {
        kind: "remote-id";
        id: string;
        name?: string;
        mimeType?: string;
        expiresAt?: number;
    };

/** 媒体来源；用于 UI、日志和后续策略判断 */
export type AttachmentOrigin = "user" | "assistant" | "generation" | "tool";

/** 等待落盘的媒体
 * @note Provider 只负责产出这一层；IFileHost / AttachmentFileManager 由 Session 侧调用
 */
export type PendingAttachment = GeneratedMedia & {
    /** 媒体由谁产生 */
    origin: AttachmentOrigin;

    /** Provider 侧的去重键；流式片段与最终结果携带同一 sourceId 时只落盘一次 */
    sourceId?: string;
};

/** 根据文件头识别常见媒体类型；无法识别时返回 undefined
 * @note 只做轻量签名判断，不替代完整的 MIME 校验。
 */
export function detectMediaMimeType(data: Uint8Array): string | undefined{
    if (matches(data, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
    if (matches(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
    if (matches(data, 0, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
    if (matches(data, 0, [0x52, 0x49, 0x46, 0x46]) && matches(data, 8, [0x57, 0x45, 0x42, 0x50])) {
        return "image/webp";
    }

    if (matches(data, 4, [0x66, 0x74, 0x79, 0x70])) return "video/mp4";
    if (matches(data, 0, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
    if (matches(data, 0, [0x52, 0x49, 0x46, 0x46]) && matches(data, 8, [0x57, 0x41, 0x56, 0x45])) {
        return "audio/wav";
    }
    if (matches(data, 0, [0x4f, 0x67, 0x67, 0x53])) return "audio/ogg";
    if (matches(data, 0, [0x66, 0x4c, 0x61, 0x43])) return "audio/flac";
    if (matches(data, 0, [0x49, 0x44, 0x33])) return "audio/mpeg";
    if (matches(data, 0, [0xff, 0xfb]) || matches(data, 0, [0xff, 0xf3])) return "audio/mpeg";

    return undefined;
}

/** 根据 MIME 返回建议扩展名 */
export function extensionForMediaMimeType(mimeType: string): string | undefined{
    switch (mimeType.toLowerCase()){
        case "image/jpeg": return "jpg";
        case "image/png": return "png";
        case "image/webp": return "webp";
        case "image/gif": return "gif";
        case "video/mp4": return "mp4";
        case "video/webm": return "webm";
        case "audio/mpeg": return "mp3";
        case "audio/wav": return "wav";
        case "audio/ogg": return "ogg";
        case "audio/flac": return "flac";
        default: return undefined;
    }
}

/** 用 MIME 对应的扩展名替换文件名后缀；没有可用扩展名时保留原名 */
export function normalizeMediaName(name: string, mimeType: string | undefined): string{
    if (mimeType === undefined) return name;

    const extension = extensionForMediaMimeType(mimeType);
    if (extension === undefined) return name;

    const clean = name.trim();
    if (clean.length === 0) return `attachment.${extension}`;

    const dot = clean.lastIndexOf(".");
    const stem = dot > 0 ? clean.slice(0, dot) : clean;
    return `${stem}.${extension}`;
}

function matches(content: Uint8Array, offset: number, signature: readonly number[]): boolean{
    if (content.length < offset + signature.length) return false;

    for (let index = 0; index < signature.length; index++){
        if (content[offset + index] !== signature[index]) return false;
    }

    return true;
}
