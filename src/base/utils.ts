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