/** 支持的图片 MIME 类型（Ollama 图片输入的首版范围） */
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
]);

/** 归一化图片 MIME 类型；非图片或未知类型返回 undefined */
export function normalizeImageMimeType(mimeType: string | undefined): string | undefined{
    if (mimeType === undefined) return undefined;

    const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
    if (normalized === undefined || normalized.length === 0) return undefined;
    if (normalized === "image/jpg") return "image/jpeg";
    return SUPPORTED_IMAGE_MIME_TYPES.has(normalized) ? normalized : undefined;
}

/** 判断 MIME 类型是否属于首版支持的图片类型 */
export function isSupportedImageMimeType(mimeType: string | undefined): boolean{
    return normalizeImageMimeType(mimeType) !== undefined;
}

/** 根据文件头识别图片 MIME 类型；无法识别时返回 undefined */
export function detectImageMimeType(content: Uint8Array): string | undefined{
    if (matches(content, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
    if (matches(content, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
    if (matches(content, 0, [0x47, 0x49, 0x46, 0x38])) return "image/gif";

    if (matches(content, 0, [0x52, 0x49, 0x46, 0x46]) && matches(content, 8, [0x57, 0x45, 0x42, 0x50])){
        return "image/webp";
    }

    return undefined;
}

function matches(content: Uint8Array, offset: number, signature: readonly number[]): boolean{
    if (content.length < offset + signature.length) return false;

    for (let index = 0; index < signature.length; index++){
        if (content[offset + index] !== signature[index]) return false;
    }

    return true;
}
