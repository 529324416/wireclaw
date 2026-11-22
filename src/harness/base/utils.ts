/** 普通对象（非数组、非 null） */
export function isRecord(value: unknown): value is Record<string, unknown>{
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 深拷贝 JSON 值；调用方应先用 isJsonSafe 校验 */
export function cloneJson<T>(value: T): T{
    if (Array.isArray(value)){
        return value.map((item) => cloneJson(item)) as T;
    }
    if (isRecord(value)){
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)){
            result[key] = cloneJson(item);
        }
        return result as T;
    }
    return value;
}

/** 用于错误消息的简短值描述，避免把大对象直接打出来 */
export function describeValue(value: unknown): string{
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "string"){
        const text = value.length > 40 ? `${value.slice(0, 40)}...` : value;
        return JSON.stringify(text);
    }
    if (typeof value === "number" || typeof value === "boolean"){
        return String(value);
    }
    if (Array.isArray(value)) return `array(${String(value.length)})`;
    if (typeof value === "object") return "object";
    return typeof value;
}
