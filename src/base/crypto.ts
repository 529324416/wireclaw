

/** 生成一个随机的UUID4 */
export function uuid4(): string {
    return crypto.randomUUID();
}

/** 生成一个唯一的ID */
export function uniqueId(): string {
    return uuid4();
}
