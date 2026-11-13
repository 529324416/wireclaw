import { DeserializationError } from "./error";


/** 判断一个值是否能被 JSON 无损表示 */
export function isJsonSafe(value: unknown, stack: WeakSet<object> = new WeakSet(), depth: number = 0): boolean{
    if (depth > 64) return false;
    if (value === null) return true;

    switch (typeof value){
        case 'string':
        case 'boolean':
            return true;
        case 'number':
            return Number.isFinite(value);
        case 'object': {
            if (stack.has(value)) return false;
            stack.add(value);

            let result: boolean;
            if (Array.isArray(value)){
                result = value.every((item) => isJsonSafe(item, stack, depth + 1));
            } else {
                const prototype = Object.getPrototypeOf(value);
                result = (prototype === Object.prototype || prototype === null)
                    && Object.getOwnPropertySymbols(value).length === 0
                    && Object.values(value).every((item) => isJsonSafe(item, stack, depth + 1));
            }

            stack.delete(value);
            return result;
        }
        default:
            return false;
    }
}

export function asRecord(value: unknown, field: string): Record<string, unknown>{
    if (typeof value !== 'object' || value === null || Array.isArray(value)){
        throw new DeserializationError(`Invalid message data: ${field} should be an object`);
    }
    return value as Record<string, unknown>;
}

export function asString(value: unknown, field: string): string{
    if (typeof value !== 'string'){
        throw new DeserializationError(`Invalid message data: ${field} should be a string`);
    }
    return value;
}

/** 读取必填非空字符串 */
export function asNonEmptyString(value: unknown, field: string): string{
    const text = asString(value, field);
    if (text.length === 0){
        throw new DeserializationError(`Invalid message data: ${field} should be a non-empty string`);
    }
    return text;
}

export function asBoolean(value: unknown, field: string): boolean{
    if (typeof value !== 'boolean'){
        throw new DeserializationError(`Invalid message data: ${field} should be a boolean`);
    }
    return value;
}

export function asNonNegativeNumber(value: unknown, field: string): number{
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0){
        throw new DeserializationError(`Invalid message data: ${field} should be a non-negative number`);
    }
    return value;
}

export function asNonNegativeInteger(value: unknown, field: string): number{
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0){
        throw new DeserializationError(`Invalid message data: ${field} should be a non-negative integer`);
    }
    return value;
}

export function asEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T{
    if (typeof value !== 'string' || !allowed.includes(value as T)){
        throw new DeserializationError(`Invalid message data: ${field} is invalid`);
    }
    return value as T;
}

/** 去掉路径中由剪贴板带入的不可见控制字符（Bidi / 零宽 / BOM）
 * @note Windows 资源管理器复制路径时偶尔会带上 U+202A 等字符，
 *       它们会让绝对路径被当成相对路径，最终拼到当前工作目录下。
 */
export function sanitizePathInput(value: string): string{
    const invisible = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
    let cleaned = value.replace(invisible, "").trim();

    if (cleaned.length >= 2){
        const first = cleaned[0];
        const last = cleaned[cleaned.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")){
            cleaned = cleaned.slice(1, -1).trim();
        }
    }

    return cleaned;
}

/** 把字节数组编码为 base64（不包含 data URL 前缀）
 * @note 使用 btoa；Node >= 20 与浏览器均可用。分块拼接，避免大文件参数展开溢出
 */
export function toBase64(bytes: Uint8Array): string{
    let binary = "";
    const chunkSize = 0x8000;

    for (let offset = 0; offset < bytes.length; offset += chunkSize){
        const chunk = bytes.subarray(offset, offset + chunkSize);
        binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
}