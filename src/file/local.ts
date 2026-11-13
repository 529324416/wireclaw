import { mkdir, open, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { isContentHash, mergeAttachmentMeta, normalizeSourcePaths } from "../session/attachment";
import type { IFileHost, StoredAttachment, StoredAttachmentMeta } from "../session/attachment";
import type { FileContent } from "../session/type";

/** 本地元数据文件结构 */
type MetadataFile = {
    version?: number;
    name?: string;
    mimeType?: string;
    size?: number;
    sourcePaths?: string[];
};

/** 基于本地目录的 IFileHost 实现（Node / Electron 主进程）
 * @note 文件按内容指纹命名，元数据存于同目录的 `<hash>.json`。
 *       字节已丢失但元数据仍在时，readMeta / list 仍会返回记录，供路径恢复使用。
 */
export class LocalFileHost implements IFileHost {

    private readonly _rootDir: string;

    /** 串行化写入，避免同一 contentHash 的元数据合并互相覆盖 */
    private _writeQueue: Promise<void> = Promise.resolve();

    constructor(rootDir: string){
        if (typeof rootDir !== "string" || rootDir.trim().length === 0){
            throw new Error("LocalFileHost requires a non-empty root directory");
        }
        this._rootDir = resolve(rootDir);
    }

    /** 文件仓库根目录 */
    get rootDir(): string{
        return this._rootDir;
    }

    async read(contentHash: string): Promise<StoredAttachment | undefined>{
        if (!isContentHash(contentHash)) return undefined;

        let bytes: Buffer;
        try{
            bytes = await readFile(this._pathFor(contentHash));
        }catch(error){
            if (isErrno(error, "ENOENT")) return undefined;
            throw error;
        }

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
            content: new Uint8Array(bytes),
        };
    }

    async readMeta(contentHash: string): Promise<StoredAttachmentMeta | undefined>{
        if (!isContentHash(contentHash)) return undefined;

        let raw: string;
        try{
            raw = await readFile(this._metadataPathFor(contentHash), "utf8");
        }catch(error){
            if (isErrno(error, "ENOENT")) return undefined;
            throw error;
        }

        let parsed: unknown;
        try{
            parsed = JSON.parse(raw);
        }catch{
            // 元数据损坏时不要把它当作有效附件
            return undefined;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

        const record = parsed as MetadataFile;
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
                const info = await stat(this._pathFor(contentHash));
                size = info.size;
            }catch(error){
                if (!isErrno(error, "ENOENT")) throw error;
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
            await mkdir(this._rootDir, { recursive: true });

            const existing = await this.readMeta(file.contentHash);
            const merged = mergeAttachmentMeta(existing, file);

            const contentTarget = this._pathFor(file.contentHash);
            try{
                // 内容相同则字节相同；wx 防止并发写入互相覆盖
                await writeFile(contentTarget, file.content, { flag: "wx" });
            }catch(error){
                if (!isErrno(error, "EEXIST")) throw error;
            }

            await writeFile(
                this._metadataPathFor(file.contentHash),
                JSON.stringify({
                    version: 1,
                    name: merged.name,
                    mimeType: merged.mimeType,
                    size: file.size,
                    sourcePaths: merged.sourcePaths,
                }),
                "utf8",
            );

            return {
                ...merged,
                size: file.size,
            };
        });
    }

    async list(): Promise<readonly StoredAttachmentMeta[]>{
        await mkdir(this._rootDir, { recursive: true });

        let entries;
        try{
            entries = await readdir(this._rootDir, { withFileTypes: true });
        }catch(error){
            if (isErrno(error, "ENOENT")) return [];
            throw error;
        }

        const hashes = new Set<string>();
        for (const entry of entries){
            if (!entry.isFile()) continue;

            if (entry.name.endsWith(".json")){
                const base = entry.name.slice(0, -".json".length);
                if (isContentHash(base)) hashes.add(base);
                continue;
            }

            if (isContentHash(entry.name)) hashes.add(entry.name);
        }

        const metas: StoredAttachmentMeta[] = [];
        for (const contentHash of [...hashes].sort()){
            const meta = await this.readMeta(contentHash);
            if (meta !== undefined){
                metas.push(meta);
                continue;
            }

            // 字节存在但元数据丢失：仍然返回一个最小记录
            try{
                const info = await stat(this._pathFor(contentHash));
                metas.push({
                    contentHash,
                    name: contentHash,
                    mimeType: undefined,
                    size: info.size,
                    sourcePaths: [],
                });
            }catch(error){
                if (!isErrno(error, "ENOENT")) throw error;
            }
        }

        return metas;
    }

    async delete(contentHash: string): Promise<boolean>{
        if (!isContentHash(contentHash)) return false;

        let removed = false;
        for (const target of [this._pathFor(contentHash), this._metadataPathFor(contentHash)]){
            try{
                await unlink(target);
                removed = true;
            }catch(error){
                if (!isErrno(error, "ENOENT")) throw error;
            }
        }

        return removed;
    }

    async flush(): Promise<void>{
        // 尽力刷目录项；部分平台不允许对目录 fsync，失败不影响已写入的数据
        try{
            const handle = await open(this._rootDir, "r");
            try{
                await handle.sync();
            }finally{
                await handle.close();
            }
        }catch{
            // 目录 fsync 不是所有平台都支持
        }
    }

    async close(): Promise<void>{
        // 没有常驻句柄
    }

    private _pathFor(contentHash: string): string{
        return join(this._rootDir, contentHash);
    }

    private _metadataPathFor(contentHash: string): string{
        return `${this._pathFor(contentHash)}.json`;
    }

    /** 串行执行写入任务 */
    private _enqueueWrite<T>(task: () => Promise<T>): Promise<T>{
        const run = this._writeQueue.then(task, task);
        this._writeQueue = run.then(() => undefined, () => undefined);
        return run;
    }
}

function isErrno(error: unknown, code: string): boolean{
    return typeof error === "object"
        && error !== null
        && (error as NodeJS.ErrnoException).code === code;
}

/** 从本地路径读取原始文件；用于 AttachmentFileManager 的路径恢复 */
export async function readLocalSourcePath(path: string): Promise<FileContent | undefined>{
    try{
        return new Uint8Array(await readFile(path));
    }catch{
        return undefined;
    }
}
