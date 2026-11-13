import { isContentHash, mergeAttachmentMeta, normalizeSourcePaths } from "../session/attachment";
import type { IFileHost, StoredAttachment, StoredAttachmentMeta } from "../session/attachment";

const METADATA_STORE = "metadata";
const CONTENT_STORE = "contents";

/** IndexedDB 中的元数据记录 */
type IdbMetadataRecord = {
    contentHash: string;
    name: string;
    mimeType?: string;
    size: number;
    sourcePaths: string[];
};

/** IndexedDB 中的内容记录 */
type IdbContentRecord = {
    contentHash: string;
    content: ArrayBuffer;
};

export type IndexedDbFileHostOptions = {

    /** 数据库名，默认 "wireclaw-files" */
    dbName?: string;

    /** 数据库版本，默认 1 */
    version?: number;

    /** 可注入的 IDBFactory；测试或非标准环境使用 */
    indexedDB?: IDBFactory;
};

/** 基于 IndexedDB 的 IFileHost 实现（浏览器 / Electron 渲染进程）
 * @note 元数据与内容分两个 object store 存放；内容被删除时元数据仍可保留，
 *       以便 AttachmentFileManager 从原始路径恢复。
 */
export class IndexedDbFileHost implements IFileHost {

    private readonly _dbName: string;
    private readonly _version: number;
    private readonly _factory?: IDBFactory;

    private _dbPromise: Promise<IDBDatabase> | null = null;

    constructor(options: IndexedDbFileHostOptions = {}){
        const dbName = options.dbName ?? "wireclaw-files";
        if (typeof dbName !== "string" || dbName.trim().length === 0){
            throw new Error("IndexedDbFileHost requires a non-empty database name");
        }

        const version = options.version ?? 1;
        if (!Number.isInteger(version) || version < 1){
            throw new Error(`Invalid IndexedDB version: ${String(options.version)}`);
        }

        this._dbName = dbName;
        this._version = version;
        this._factory = options.indexedDB;
    }

    /** 当前环境是否支持 IndexedDB */
    static isSupported(): boolean{
        return typeof indexedDB !== "undefined";
    }

    /** 数据库名 */
    get dbName(): string{ return this._dbName; }

    async read(contentHash: string): Promise<StoredAttachment | undefined>{
        if (!isContentHash(contentHash)) return undefined;

        const db = await this._open();
        const tx = db.transaction([METADATA_STORE, CONTENT_STORE], "readonly");
        const metaRequest = tx.objectStore(METADATA_STORE).get(contentHash) as IDBRequest<IdbMetadataRecord | undefined>;
        const contentRequest = tx.objectStore(CONTENT_STORE).get(contentHash) as IDBRequest<IdbContentRecord | undefined>;

        const [metaRecord, contentRecord] = await Promise.all([
            requestToPromise(metaRequest),
            requestToPromise(contentRequest),
        ]);

        if (contentRecord === undefined) return undefined;

        const bytes = new Uint8Array(contentRecord.content);
        const meta = metaRecord === undefined
            ? {
                contentHash,
                name: contentHash,
                mimeType: undefined,
                size: bytes.byteLength,
                sourcePaths: [],
            }
            : toMeta(metaRecord);

        return {
            ...meta,
            size: bytes.byteLength,
            content: bytes,
        };
    }

    async readMeta(contentHash: string): Promise<StoredAttachmentMeta | undefined>{
        if (!isContentHash(contentHash)) return undefined;

        const db = await this._open();
        const tx = db.transaction(METADATA_STORE, "readonly");
        const request = tx.objectStore(METADATA_STORE).get(contentHash) as IDBRequest<IdbMetadataRecord | undefined>;
        const record = await requestToPromise(request);

        return record === undefined ? undefined : toMeta(record);
    }

    async write(file: StoredAttachment): Promise<StoredAttachmentMeta>{
        if (!isContentHash(file.contentHash)){
            throw new Error(`Invalid content hash: ${file.contentHash}`);
        }

        const db = await this._open();
        const tx = db.transaction([METADATA_STORE, CONTENT_STORE], "readwrite");
        const metaStore = tx.objectStore(METADATA_STORE);
        const contentStore = tx.objectStore(CONTENT_STORE);

        let merged: StoredAttachmentMeta | undefined;

        // 在请求回调中同步发起后续写入，避免事务提前提交
        const metaRequest = metaStore.get(file.contentHash) as IDBRequest<IdbMetadataRecord | undefined>;
        metaRequest.onsuccess = () => {
            const existing = metaRequest.result === undefined ? undefined : toMeta(metaRequest.result);
            merged = mergeAttachmentMeta(existing, file);

            metaStore.put({
                contentHash: merged.contentHash,
                name: merged.name,
                mimeType: merged.mimeType,
                size: file.size,
                sourcePaths: [...merged.sourcePaths],
            } satisfies IdbMetadataRecord);

            contentStore.put({
                contentHash: file.contentHash,
                content: toArrayBuffer(file.content),
            } satisfies IdbContentRecord);
        };

        await transactionDone(tx);

        if (merged === undefined){
            throw new Error(`IndexedDB write did not complete for ${file.contentHash}`);
        }

        return {
            ...merged,
            size: file.size,
        };
    }

    async list(): Promise<readonly StoredAttachmentMeta[]>{
        const db = await this._open();
        const tx = db.transaction(METADATA_STORE, "readonly");
        const request = tx.objectStore(METADATA_STORE).getAll() as IDBRequest<IdbMetadataRecord[]>;
        const records = await requestToPromise(request);

        return records
            .filter((record) => isContentHash(record.contentHash))
            .map((record) => toMeta(record));
    }

    async delete(contentHash: string): Promise<boolean>{
        if (!isContentHash(contentHash)) return false;

        const db = await this._open();
        const tx = db.transaction([METADATA_STORE, CONTENT_STORE], "readwrite");
        const metaStore = tx.objectStore(METADATA_STORE);
        const contentStore = tx.objectStore(CONTENT_STORE);

        let existed = false;
        const metaRequest = metaStore.get(contentHash) as IDBRequest<IdbMetadataRecord | undefined>;
        metaRequest.onsuccess = () => {
            existed = metaRequest.result !== undefined;
            metaStore.delete(contentHash);
            contentStore.delete(contentHash);
        };

        await transactionDone(tx);
        return existed;
    }

    async flush(): Promise<void>{
        // IndexedDB 事务完成即已提交；没有额外刷盘动作
    }

    async close(): Promise<void>{
        const pending = this._dbPromise;
        this._dbPromise = null;
        if (pending === null) return;

        try{
            const db = await pending;
            db.close();
        }catch{
            // 打开失败时没有需要关闭的数据库
        }
    }

    private _factoryOrDefault(): IDBFactory{
        const factory = this._factory
            ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
        if (factory === undefined){
            throw new Error("IndexedDB is not supported in the current environment");
        }
        return factory;
    }

    private _open(): Promise<IDBDatabase>{
        if (this._dbPromise !== null) return this._dbPromise;

        const factory = this._factoryOrDefault();
        const pending = new Promise<IDBDatabase>((resolve, reject) => {
            let request: IDBOpenDBRequest;
            try{
                request = factory.open(this._dbName, this._version);
            }catch(error){
                reject(error);
                return;
            }

            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(METADATA_STORE)){
                    db.createObjectStore(METADATA_STORE, { keyPath: "contentHash" });
                }
                if (!db.objectStoreNames.contains(CONTENT_STORE)){
                    db.createObjectStore(CONTENT_STORE, { keyPath: "contentHash" });
                }
            };

            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => {
                    db.close();
                    if (this._dbPromise === tracked) this._dbPromise = null;
                };
                resolve(db);
            };

            request.onerror = () => {
                reject(request.error ?? new Error("Failed to open IndexedDB"));
            };

            request.onblocked = () => {
                // 等待其它连接关闭；不主动失败
            };
        });

        const tracked = pending.catch((error: unknown) => {
            this._dbPromise = null;
            throw error;
        });
        this._dbPromise = tracked;
        return tracked;
    }
}

/** 把请求结果转换为 Promise */
function requestToPromise<T>(request: IDBRequest<T>): Promise<T>{
    return new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    });
}

/** 等待事务完成 */
function transactionDone(tx: IDBTransaction): Promise<void>{
    return new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
        tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
}

/** 元数据记录转换为对外类型 */
function toMeta(record: IdbMetadataRecord): StoredAttachmentMeta{
    return {
        contentHash: record.contentHash,
        name: typeof record.name === "string" && record.name.length > 0
            ? record.name
            : record.contentHash,
        mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined,
        size: typeof record.size === "number" && Number.isFinite(record.size) && record.size >= 0
            ? record.size
            : 0,
        sourcePaths: normalizeSourcePaths(
            Array.isArray(record.sourcePaths)
                ? record.sourcePaths.filter((item): item is string => typeof item === "string")
                : [],
        ),
    };
}

/** 复制成 ArrayBuffer，避免 SharedArrayBuffer/视图偏移问题 */
function toArrayBuffer(content: Uint8Array): ArrayBuffer{
    const copy = new Uint8Array(content.byteLength);
    copy.set(content);
    return copy.buffer;
}
