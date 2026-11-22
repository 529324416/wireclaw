type Waiter<T> = {
    resolve: (result: IteratorResult<T>) => void;
};

/**
 * 节点输出通道。
 *
 * @note Step 3 采用无界缓冲 + 推送模型；消费端必须及时读取，
 *       后续再补背压策略与丢弃/超限诊断。
 */
export class OutputChannel<T>{

    private _queue: T[] = [];
    private readonly _waiters: Waiter<T>[] = [];
    private _closed = false;

    get isClosed(): boolean{
        return this._closed;
    }

    emit(value: T): void{
        if (this._closed) return;
        const waiter = this._waiters.shift();
        if (waiter !== undefined){
            waiter.resolve({ value, done: false });
            return;
        }
        this._queue.push(value);
    }

    close(): void{
        if (this._closed) return;
        this._closed = true;
        for (const waiter of this._waiters.splice(0)){
            waiter.resolve({ value: undefined, done: true });
        }
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<T>{
        while (true){
            const next = await this._next();
            if (next.done) return;
            yield next.value;
        }
    }

    private _next(): Promise<IteratorResult<T>>{
        const value = this._queue.shift();
        if (value !== undefined){
            return Promise.resolve({ value, done: false });
        }
        if (this._closed){
            return Promise.resolve({ value: undefined, done: true });
        }

        return new Promise<IteratorResult<T>>((resolve) =>{
            this._waiters.push({ resolve });
        });
    }
}
