import { isContentHash, mergeAttachmentMeta } from "../session/attachment";
import type { IFileHost, StoredAttachment, StoredAttachmentMeta } from "../session/attachment";

/** 内存文件宿主：测试与无持久化场景使用
 * @note 与真实宿主保持相同的内容寻址与路径合并语义
 */
export class MemoryFileHost implements IFileHost {

    private readonly _files = new Map<string, StoredAttachment>();

    async read(contentHash: string): Promise<StoredAttachment | undefined>{
        if (!isContentHash(contentHash)) return undefined;

        const stored = this._files.get(contentHash);
        if (stored === undefined) return undefined;

        return {
            ...toMeta(stored),
            content: new Uint8Array(stored.content),
        };
    }

    async readMeta(contentHash: string): Promise<StoredAttachmentMeta | undefined>{
        if (!isContentHash(contentHash)) return undefined;

        const stored = this._files.get(contentHash);
        return stored === undefined ? undefined : toMeta(stored);
    }

    async write(file: StoredAttachment): Promise<StoredAttachmentMeta>{
        if (!isContentHash(file.contentHash)){
            throw new Error(`Invalid content hash: ${file.contentHash}`);
        }

        const existing = this._files.get(file.contentHash);
        const merged = mergeAttachmentMeta(existing, file);

        this._files.set(file.contentHash, {
            ...merged,
            // 内容相同则字节相同；保留已有内容，避免调用方后续修改
            content: existing === undefined ? new Uint8Array(file.content) : existing.content,
        });

        return merged;
    }

    async list(): Promise<readonly StoredAttachmentMeta[]>{
        return [...this._files.values()].map((stored) => toMeta(stored));
    }

    async delete(contentHash: string): Promise<boolean>{
        return this._files.delete(contentHash);
    }

    async close(): Promise<void>{
        // 内存宿主没有需要释放的资源
    }
}

/** 只复制元数据，避免把内容带到索引里 */
function toMeta(stored: StoredAttachmentMeta): StoredAttachmentMeta{
    return {
        contentHash: stored.contentHash,
        name: stored.name,
        mimeType: stored.mimeType,
        size: stored.size,
        sourcePaths: [...stored.sourcePaths],
    };
}
