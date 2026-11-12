import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { AttachmentFile } from "./file";
import type { IFileHost } from "./file";
import type { FileContent } from "./type";

/** 内容指纹文件名格式，避免路径注入 */
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

/** 基于本地目录的 IFileHost 实现（Node 专用）
 * @note 文件按内容指纹命名，元数据存于同目录的 `<hash>.json`。
 *       这是附件系统的本地开发/测试实现；浏览器端应使用 IndexedDB 等实现。
 */
export class LocalFileHost implements IFileHost {

    private readonly _rootDir: string;

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

    async put(name: string, content: FileContent, mimeType?: string): Promise<AttachmentFile>{
        const file = await AttachmentFile.create(name, content, mimeType);

        const existing = await this.get(file.contentHash);
        if (existing !== undefined) return existing;

        await mkdir(this._rootDir, { recursive: true });

        const target = this._pathFor(file.contentHash);
        const metadataTarget = `${target}.json`;

        // 内容相同则字节相同；wx 防止并发写入互相覆盖
        try {
            await writeFile(target, file.content, { flag: "wx" });
        } catch (error) {
            if (!isErrno(error, "EEXIST")) throw error;
            const raced = await this.get(file.contentHash);
            if (raced !== undefined) return raced;
        }

        // 元数据只写一次；首次写入的名称/MIME 为准
        try {
            await writeFile(
                metadataTarget,
                JSON.stringify({ name: file.name, mimeType: file.mimeType }),
                { encoding: "utf8", flag: "wx" },
            );
        } catch (error) {
            if (!isErrno(error, "EEXIST")) throw error;
        }

        return file;
    }

    async get(contentHash: string): Promise<AttachmentFile | undefined>{
        if (!CONTENT_HASH_PATTERN.test(contentHash)) return undefined;

        const target = this._pathFor(contentHash);

        let bytes: Buffer;
        try {
            bytes = await readFile(target);
        } catch (error) {
            if (isErrno(error, "ENOENT")) return undefined;
            throw error;
        }

        const metadata = await this._readMetadata(target);
        const file = await AttachmentFile.create(
            metadata.name ?? contentHash,
            new Uint8Array(bytes),
            metadata.mimeType,
        );

        // 反序列化/磁盘损坏时不要把错误内容当作有效附件
        return file.contentHash === contentHash ? file : undefined;
    }

    private _pathFor(contentHash: string): string{
        return join(this._rootDir, contentHash);
    }

    private async _readMetadata(target: string): Promise<{ name?: string; mimeType?: string }>{
        try {
            const raw = await readFile(`${target}.json`, "utf8");
            const parsed: unknown = JSON.parse(raw);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

            const record = parsed as Record<string, unknown>;
            return {
                name: typeof record.name === "string" ? record.name : undefined,
                mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined,
            };
        } catch (error) {
            if (isErrno(error, "ENOENT")) return {};
            // 元数据损坏不影响按内容指纹读取字节
            return {};
        }
    }
}

function isErrno(error: unknown, code: string): boolean{
    return typeof error === "object"
        && error !== null
        && (error as NodeJS.ErrnoException).code === code;
}
