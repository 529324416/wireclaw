/** Rotom错误基类 */
export class RotomError extends Error{
    constructor(message: string){
        super(message);
    }
}

/** 无效参数错误 */
export class InvalidParameterError extends RotomError{
    constructor(message: string){
        super(message);
    }
}

/** 反序列化错误 */
export class DeserializationError extends RotomError{
    constructor(message: string){
        super(message);
    }
}

/** 序列化错误 */
export class SerializationError extends RotomError{
    constructor(message: string){
        super(message);
    }
}