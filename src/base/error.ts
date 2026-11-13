/** Wireclaw错误基类 */
export class WireclawError extends Error{
    constructor(message: string){
        super(message);
    }
}

/** 无效参数错误 */
export class InvalidParameterError extends WireclawError{
    constructor(message: string){
        super(message);
    }
}

/** 反序列化错误 */
export class DeserializationError extends WireclawError{
    constructor(message: string){
        super(message);
    }
}

/** 序列化错误 */
export class SerializationError extends WireclawError{
    constructor(message: string){
        super(message);
    }
}