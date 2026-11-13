import { isContentHash, mergeAttachmentMeta, normalizeSourcePaths } from "../session/attachment";
import type { IFileHost, StoredAttachment, StoredAttachmentMeta } from "../session/attachment";

/** OPFS 文件对象的最小能力集合 */
export type OpfsFile = {
    readonly size: number;
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
};

/** OPFS 可写流的最小能力集合 */
export type OpfsWritableFileStream = {
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
};

/** OPFS 文件句柄的最小能力集合 */
export type OpfsFileHandle = {
    readonly kind: "file";
    readonly name: string;
    getFile(): Promise<OpfsFile>;
    createWritable(): Promise<OpfsWritableFileStream>;
};

/** OPFS 目录句柄的最小能力集合；便于测试时注入替身 */
export type OpfsDirectoryHandle = {
    readonly kind: "directory";
    readonly name: string;
    getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
    getDirectoryHandle?(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
    removeEntry(name: string): Promise<void>;
    entries(): AsyncIterableIterator<[string, OpfsFileHandle | OpfsDirectoryHandle]>;
};

export type OpfsFileHostOptions = {

    /** OPFS 根目录名，默认 "wireclaw-files" */
    rootDir?: string;

    /** 可注入的根目录句柄；不传时使用 navigator.storage.getDirectory() */
    root?: OpfsDirectoryHandle;
};

type OpfsMetadataFile = {
    version?: number;
    name?: string;
    mimeType?: string;
    size?: number;
    sourcePaths?: string[];
};

/** 基于 OPFS 的 IFileHost 实现（浏览器 / Electron 渲染进程）
 * @note 内容按指纹命名，元数据存于同目录的 `<hash>.json`。
 *       字节已丢失但元数据仍在时，readMeta / list 仍会返回记录，供路径恢复使用。
 */
export class OpfsFileHost implements IFileHost {

    private readonly _rootDir: string;
    private _root: OpfsDirectoryHandle | null;
    private _rootPromise: Promise<OpfsDirectoryHandle> | null = null;

    /** 串行化写入，避免同一 contentHash 的元数据合并互相覆盖 */
    private _writeQueue: Promise<void> = Promise.resolve();

    constructor(options: OpfsFileHostOptions = {}){
        const rootDir = options.rootDir ?? "wireclaw-files";
        if (typeof rootDir !== "string" || rootDir.trim().length === 0){
            throw new Error("OpfsFileHost requires a non-empty root directory name");
        }
        if (rootDir.includes("/") || rootDir.includes("\\") || rootDir === "." || rootDir === ".."){
            throw new Error(`Invalid OPFS root directory name: ${rootDir}`);
        }

        this._rootDir = rootDir;
        this._root = options.root ?? null;
    }

    /** 当前环境是否支持 OPFS */
    static isSupported(): boolean{
        if (typeof navigator === "undefined") return false;
        const storage = (navigator as unknown as {
            storage?: { getDirectory?: () => Promise<OpfsDirectoryHandle> };
        }).storage;
        return typeof storage?.getDirectory === "function";
    }

    /** 根目录名 */
    get rootDir(): string{ return this._rootDir; }

    async read(contentHash: string): Promise<StoredAttachment | undefined>{
        if (!isContentHash(contentHash)) return undefined;

        const dir = await this._getRoot();
        let fileHandle: OpfsFileHandle;
        try{
            fileHandle = await dir.getFileHandle(contentHash);
        }catch(error){
            if (isNotFound(error)) return undefined;
            throw error;
        }

        const file = await fileHandle.getFile();
        const bytes = new Uint8Array(await file.arrayBuffer());
        const meta = await this.readMeta(contentHash) ?? {
            contentHash,
            name: contentHash,
            mimeType: undefined,
            size: bytes.byteLength,
            sourcePaths: [],
        };

        return {
            ...meta,
            size: bytes.byteLength,
            content: bytes,
        };
    }

    async readMeta(contentHash: string): Promise<StoredAttachmentMeta | undefined>{
        if (!isContentHash(contentHash)) return undefined;

        const dir = await this._getRoot();
        let handle: OpfsFileHandle;
        try{
            handle = await dir.getFileHandle(this._metadataName(contentHash));
        }catch(error){
            if (isNotFound(error)) return undefined;
            throw error;
        }

        let parsed: unknown;
        try{
            parsed = JSON.parse(await (await handle.getFile()).text());
        }catch{
            return undefined;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

        const record = parsed as OpfsMetadataFile;
        const name = typeof record.name === "string" && record.name.length > 0
            ? record.name
            : contentHash;
        const mimeType = typeof record.mimeType === "string" ? record.mimeType : undefined;
        const sourcePaths = Array.isArray(record.sourcePaths)
            ? normalizeSourcePaths(record.sourcePaths.filter((item): item is string => typeof item === "string"))
            : [];

        let size = typeof record.size === "number" && Number.isFinite(record.size) && record.size >= 0
            ? record.size
            : 0;
        if (size === 0){
            try{
                const contentHandle = await dir.getFileHandle(contentHash);
                size = (await contentHandle.getFile()).size;
            }catch(error){
                if (!isNotFound(error)) throw error;
            }
        }

        return {
            contentHash,
            name,
            mimeType,
            size,
            sourcePaths,
        };
    }

    async write(file: StoredAttachment): Promise<StoredAttachmentMeta>{
        if (!isContentHash(file.contentHash)){
            throw new Error(`Invalid content hash: ${file.contentHash}`);
        }

        return await this._enqueueWrite(async () => {
            const dir = await this._getRoot();
            const existing = await this.readMeta(file.contentHash);
            const merged = mergeAttachmentMeta(existing, file);

            let contentExists = true;
            try{
                await dir.getFileHandle(file.contentHash);
            }catch(error){
                if (!isNotFound(error)) throw error;
                contentExists = false;
            }

            if (!contentExists){
                await this._writeFile(dir, file.contentHash, file.content);
            }

            await this._writeFile(
                dir,
                this._metadataName(file.contentHash),
                new TextEncoder().encode(JSON.stringify({
                    version: 1,
                    name: merged.name,
                    mimeType: merged.mimeType,
                    size: file.size,
                    sourcePaths: merged.sourcePaths,
                })),
            );

            return {
                ...merged,
                size: file.size,
            };
        });
    }

    async list(): Promise<readonly StoredAttachmentMeta[]>{
        const dir = await this._getRoot();

        const hashes = new Set<string>();
        for await (const [name, handle] of dir.entries()){
            if (handle.kind !== "file") continue;

            if (name.endsWith(".json")){
                const base = name.slice(0, -".json".length);
                if (isContentHash(base)) hashes.add(base);
                continue;
            }

            if (isContentHash(name)) hashes.add(name);
        }

        const metas: StoredAttachmentMeta[] = [];
        for (const contentHash of [...hashes].sort()){
            const meta = await this.readMeta(contentHash);
            if (meta !== undefined){
                metas.push(meta);
                continue;
            }

            try{
                const handle = await dir.getFileHandle(contentHash);
                metas.push({
                    contentHash,
                    name: contentHash,
                    mimeType: undefined,
                    size: (await handle.getFile()).size,
                    sourcePaths: [],
                });
            }catch(error){
                if (!isNotFound(error)) throw error;
            }
        }

        return metas;
    }

    async delete(contentHash: string): Promise<boolean>{
        if (!isContentHash(contentHash)) return false;

        const dir = await this._getRoot();
        let removed = false;

        for (const name of [contentHash, this._metadataName(contentHash)]){
            try{
                await dir.removeEntry(name);
                removed = true;
            }catch(error){
                if (!isNotFound(error)) throw error;
            }
        }

        return removed;
    }

    async flush(): Promise<void>{
        // createWritable().close() 已完成写入；这里没有额外的同步需求
    }

    async close(): Promise<void>{
        // 没有常驻句柄
    }

    private async _openRoot(): Promise<OpfsDirectoryHandle>{
        if (!OpfsFileHost.isSupported()){
            throw new Error("OPFS is not supported in the current environment");
        }

        const storage = (navigator as unknown as {
            storage: { getDirectory: () => Promise<OpfsDirectoryHandle> };
        }).storage;
        const base = await storage.getDirectory();
        if (base.getDirectoryHandle === undefined){
            throw new Error("OPFS root directory handle does not support subdirectories");
        }

        return await base.getDirectoryHandle(this._rootDir, { create: true });
    }

    private async _getRoot(): Promise<OpfsDirectoryHandle>{
        if (this._root !== null) return this._root;

        if (this._rootPromise === null){
            this._rootPromise = this._openRoot();
        }

        this._root = await this._rootPromise;
        return this._root;
    }

    private _metadataName(contentHash: string): string{
        return `${contentHash}.json`;
    }

    private async _writeFile(
        dir: OpfsDirectoryHandle,
        name: string,
        content: Uint8Array,
    ): Promise<void>{
        const handle = await dir.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        // 复制到 ArrayBuffer 支撑的视图，满足 FileSystemWriteChunkType 的类型要求
        const bytes = new Uint8Array(content.byteLength);
        bytes.set(content);
        try{
            await writable.write(bytes);
        }finally{
            await writable.close();
        }
    }

    /** 串行执行写入任务 */
    private _enqueueWrite<T>(task: () => Promise<T>): Promise<T>{
        const run = this._writeQueue.then(task, task);
        this._writeQueue = run.then(() => undefined, () => undefined);
        return run;
    }
}

function isNotFound(error: unknown): boolean{
    return typeof error === "object"
        && error !== null
        && (error as { name?: unknown }).name === "NotFoundError";
}
