import { InvalidParameterError } from "../base";
import { AttachmentFile, isContentHash } from "./attachment";
import type { IFileHost, StoredAttachment, StoredAttachmentMeta } from "./attachment";
import type { FileContent } from "./type";

/** 默认缓存条目数；0 表示不缓存 */
export const DEFAULT_MAX_CACHED_FILES = 16;

/** 默认缓存字节数；0 表示不缓存 */
export const DEFAULT_MAX_CACHED_BYTES = 64 * 1024 * 1024;

/** 附件管理器选项 */
export type AttachmentFileManagerOptions = {

    /** 最大缓存条目数，默认 16；0 表示不缓存 */
    maxCachedFiles?: number;

    /** 最大缓存字节数，默认 64 MiB；0 表示不缓存 */
    maxCachedBytes?: number;

    /** 读取时是否重新计算指纹校验，默认 true */
    verify?: boolean;

    /** 从原始路径读取字节；用于宿主文件丢失后的恢复
     * @note Node/Electron 主进程可以注入 fs 实现；浏览器通常不提供
     */
    readSourcePath?: (path: string) => Promise<FileContent | undefined>;
};

/** 附件管理器：在内存中维护索引与有界缓存，真实字节读写交给 IFileHost
 * @note 不负责持久化整个附件库；host 写入时即落盘，
 *       会话恢复依赖 Session JSON 中的内容指纹 + host 中的字节/元数据。
 */
export class AttachmentFileManager {

    private readonly _host: IFileHost;
    private readonly _maxCachedFiles: number;
    private readonly _maxCachedBytes: number;
    private readonly _verify: boolean;
    private readonly _readSourcePath?: (path: string) => Promise<FileContent | undefined>;

    /** 已知附件元数据索引（可重建） */
    private readonly _index = new Map<string, StoredAttachmentMeta>();

    /** 有界 LRU 缓存；Map 的插入顺序即访问顺序 */
    private readonly _cache = new Map<string, AttachmentFile>();
    private _cacheBytes = 0;

    /** 同一 contentHash 的并发读取合并 */
    private readonly _pending = new Map<string, Promise<AttachmentFile | undefined>>();

    private _closed = false;

    constructor(host: IFileHost, options: AttachmentFileManagerOptions = {}){
        if (host === undefined || host === null){
            throw new InvalidParameterError("AttachmentFileManager requires an IFileHost");
        }

        const maxCachedFiles = options.maxCachedFiles ?? DEFAULT_MAX_CACHED_FILES;
        if (!Number.isInteger(maxCachedFiles) || maxCachedFiles < 0){
            throw new InvalidParameterError(
                `maxCachedFiles must be a non-negative integer, got ${String(options.maxCachedFiles)}`,
            );
        }

        const maxCachedBytes = options.maxCachedBytes ?? DEFAULT_MAX_CACHED_BYTES;
        if (!Number.isInteger(maxCachedBytes) || maxCachedBytes < 0){
            throw new InvalidParameterError(
                `maxCachedBytes must be a non-negative integer, got ${String(options.maxCachedBytes)}`,
            );
        }

        this._host = host;
        this._maxCachedFiles = maxCachedFiles;
        this._maxCachedBytes = maxCachedBytes;
        this._verify = options.verify ?? true;
        this._readSourcePath = options.readSourcePath;
    }

    /** 底层宿主 */
    get host(): IFileHost { return this._host; }

    /** 当前索引中的附件数量 */
    get size(): number { return this._index.size; }

    /** 写入附件：计算指纹后立即写入宿主，并更新索引/缓存 */
    async put(
        name: string,
        content: FileContent,
        mimeType?: string,
        sourcePaths: readonly string[] = [],
    ): Promise<AttachmentFile>{
        this._assertOpen();
        if (typeof name !== "string" || name.length === 0){
            throw new InvalidParameterError("Attachment name must be a non-empty string");
        }
        if (!(content instanceof Uint8Array)){
            throw new InvalidParameterError("Attachment content must be a Uint8Array");
        }

        const file = await AttachmentFile.create(name, content, mimeType, sourcePaths);

        const stored = await this._host.write({
            contentHash: file.contentHash,
            name: file.name,
            mimeType: file.mimeType,
            size: file.size,
            sourcePaths: file.sourcePaths,
            content: file.content,
        });

        if (stored.contentHash !== file.contentHash){
            throw new InvalidParameterError(
                `IFileHost returned a mismatched contentHash: ${stored.contentHash}`,
            );
        }

        const effective = file.withMeta(stored);
        this._index.set(effective.contentHash, toMeta(stored));
        this._remember(effective);
        return effective;
    }

    /** 读取附件：缓存 -> 宿主；宿主文件丢失时尝试从原始路径恢复 */
    async get(contentHash: string): Promise<AttachmentFile | undefined>{
        if (this._closed || !isContentHash(contentHash)) return undefined;

        const cached = this._cache.get(contentHash);
        if (cached !== undefined){
            this._touch(cached);
            return cached;
        }

        const pending = this._pending.get(contentHash);
        if (pending !== undefined) return await pending;

        const task = this._load(contentHash)
            .finally(() => {
                this._pending.delete(contentHash);
            });
        this._pending.set(contentHash, task);
        return await task;
    }

    /** 判断附件是否存在（不读取完整字节） */
    async has(contentHash: string): Promise<boolean>{
        if (this._closed || !isContentHash(contentHash)) return false;
        if (this._cache.has(contentHash) || this._index.has(contentHash)) return true;

        const meta = await this._host.readMeta(contentHash);
        if (meta !== undefined){
            this._index.set(contentHash, toMeta(meta));
            return true;
        }

        const stored = await this._host.read(contentHash);
        if (stored === undefined) return false;

        this._index.set(contentHash, toMeta(stored));
        return true;
    }

    /** 从宿主列举结果重建内存索引；用于启动、GC 或列表场景 */
    async rebuild(): Promise<void>{
        this._assertOpen();

        const metas = await this._host.list();
        this._index.clear();
        this._cache.clear();
        this._cacheBytes = 0;

        for (const meta of metas){
            if (!isContentHash(meta.contentHash)) continue;
            this._index.set(meta.contentHash, toMeta(meta));
        }
    }

    /** 关闭管理器并释放宿主资源 */
    async close(): Promise<void>{
        if (this._closed) return;
        this._closed = true;

        this._cache.clear();
        this._cacheBytes = 0;
        this._index.clear();
        this._pending.clear();

        await this._host.close?.();
    }

    /** 读取单个附件；失败时返回 undefined */
    private async _load(contentHash: string): Promise<AttachmentFile | undefined>{
        const stored = await this._host.read(contentHash);

        if (stored !== undefined){
            const file = this._verify
                ? await this._verifyStored(stored)
                : AttachmentFile.fromStored(stored);

            if (file !== undefined){
                this._index.set(contentHash, toMeta(stored));
                this._remember(file);
                return file;
            }

            // 字节存在但指纹不匹配：保留元数据，尝试从原始路径恢复
            const meta = await this._host.readMeta(contentHash) ?? toMeta(stored);
            this._index.set(contentHash, meta);
            return await this._recover(meta, true);
        }

        const meta = this._index.get(contentHash) ?? await this._host.readMeta(contentHash);
        if (meta === undefined) return undefined;

        this._index.set(contentHash, toMeta(meta));
        return await this._recover(meta, false);
    }

    /** 校验宿主返回的字节与记录中的指纹一致 */
    private async _verifyStored(stored: StoredAttachment): Promise<AttachmentFile | undefined>{
        const file = await AttachmentFile.create(
            stored.name,
            stored.content,
            stored.mimeType,
            stored.sourcePaths,
        );
        return file.contentHash === stored.contentHash ? file : undefined;
    }

    /** 尝试从原始路径恢复附件，并写回宿主
     * @param replaceContent 宿主中是否已有损坏字节需要先删除
     */
    private async _recover(
        meta: StoredAttachmentMeta,
        replaceContent: boolean,
    ): Promise<AttachmentFile | undefined>{
        const readSourcePath = this._readSourcePath;
        if (readSourcePath === undefined || meta.sourcePaths.length === 0) return undefined;

        for (const path of meta.sourcePaths){
            let content: FileContent | undefined;
            try{
                content = await readSourcePath(path);
            }catch{
                content = undefined;
            }
            if (content === undefined) continue;

            const candidate = await AttachmentFile.create(
                meta.name,
                content,
                meta.mimeType,
                meta.sourcePaths,
            );
            if (candidate.contentHash !== meta.contentHash) continue;

            if (replaceContent){
                try{
                    await this._host.delete?.(meta.contentHash);
                }catch{
                    // 删除失败时仍尝试写入；不支持 delete 的宿主会保留旧字节
                }
            }

            const stored = await this._host.write({
                contentHash: candidate.contentHash,
                name: candidate.name,
                mimeType: candidate.mimeType,
                size: candidate.size,
                sourcePaths: candidate.sourcePaths,
                content: candidate.content,
            });
            const effective = candidate.withMeta(stored);

            this._index.set(effective.contentHash, toMeta(stored));
            this._remember(effective);
            return effective;
        }

        return undefined;
    }

    /** 放入缓存；按条目数/字节数淘汰最久未访问的项 */
    private _remember(file: AttachmentFile): void{
        if (this._maxCachedFiles <= 0 || this._maxCachedBytes <= 0) return;
        if (file.size > this._maxCachedBytes) return;

        const existing = this._cache.get(file.contentHash);
        if (existing !== undefined){
            this._cacheBytes -= existing.size;
            this._cache.delete(file.contentHash);
        }

        this._cache.set(file.contentHash, file);
        this._cacheBytes += file.size;

        while (this._cache.size > this._maxCachedFiles || this._cacheBytes > this._maxCachedBytes){
            const oldest = this._cache.keys().next().value;
            if (oldest === undefined) break;

            const evicted = this._cache.get(oldest);
            this._cache.delete(oldest);
            if (evicted !== undefined) this._cacheBytes -= evicted.size;
        }
    }

    /** 把缓存项移动到最近使用位置 */
    private _touch(file: AttachmentFile): void{
        this._cache.delete(file.contentHash);
        this._cache.set(file.contentHash, file);
    }

    /** 已关闭时拒绝写入/重建 */
    private _assertOpen(): void{
        if (this._closed){
            throw new InvalidParameterError("AttachmentFileManager is closed");
        }
    }
}

/** 只保留元数据，避免把内容带到索引里 */
function toMeta(stored: StoredAttachmentMeta): StoredAttachmentMeta{
    return {
        contentHash: stored.contentHash,
        name: stored.name,
        mimeType: stored.mimeType,
        size: stored.size,
        sourcePaths: [...stored.sourcePaths],
    };
}
