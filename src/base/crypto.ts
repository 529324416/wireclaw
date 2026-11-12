

/** 生成一个随机的UUID4 */
export function uuid4(): string {
    return crypto.randomUUID();
}

/** 生成一个唯一的ID */
export function uniqueId(): string {
    return uuid4();
}

/** 计算内容的 SHA-256 指纹（小写十六进制）
 * @param data 文本按 UTF-8 编码；二进制按原始字节计算
 * @note 使用 Web Crypto：浏览器与 Node >= 20 均可运行；浏览器需要安全上下文
 */
export async function sha256(data: string | ArrayBuffer | Uint8Array): Promise<string> {
    const bytes = toBytes(data);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return toHex(digest);
}

/** 把支持的内容类型统一为字节数组，避免 Buffer / ArrayBuffer / string 三套实现 */
function toBytes(data: string | ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
    if (typeof data === "string") {
        return new TextEncoder().encode(data);
    }

    if (data instanceof Uint8Array) {
        // 复制一份，避免调用方后续修改底层字节导致指纹失配
        const bytes = new Uint8Array(data.byteLength);
        bytes.set(data);
        return bytes;
    }

    return new Uint8Array(data);
}

/** 把摘要字节转为小写十六进制字符串 */
function toHex(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let hex = "";

    for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, "0");
    }

    return hex;
}
