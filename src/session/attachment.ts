import { sha256 } from "../base";
import type { FileContent } from "./type";

/** 内容指纹格式：SHA-256 小写十六进制 */
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

/** 判断字符串是否是合法的内容指纹 */
export function isContentHash(value: string): boolean{
    return CONTENT_HASH_PATTERN.test(value);
}

/** 规范化原始路径组：去空、去重、保持顺序 */
export function normalizeSourcePaths(paths: readonly string[] | undefined): readonly string[]{
    if (paths === undefined) return [];

    const result: string[] = [];
    const seen = new Set<string>();

    for (const path of paths){
        if (typeof path !== "string") continue;
        const trimmed = path.trim();
        if (trimmed.length === 0 || seen.has(trimmed)) continue;

        seen.add(trimmed);
        result.push(trimmed);
    }

    return result;
}

/** 附件文件的不可变快照，使用内容指纹标识 */
export class AttachmentFile {

    private readonly _contentHash: string;
    private readonly _name: string;
    private readonly _mimeType: string | undefined;
    private readonly _content: FileContent;
    private readonly _sourcePaths: readonly string[];
    private _refCounter: number;

    /** 内容指纹（SHA-256 小写十六进制） */
    get contentHash(): string { return this._contentHash; }

    /** 文件名 */
    get name(): string { return this._name; }

    /** MIME 类型；未知时为 undefined */
    get mimeType(): string | undefined { return this._mimeType; }

    /** 文件内容 */
    get content(): FileContent { return this._content; }

    /** 文件字节数 */
    get size(): number { return this._content.byteLength; }

    /** 原始文件路径组；用于宿主文件丢失时尝试恢复 */
    get sourcePaths(): readonly string[] { return [...this._sourcePaths]; }

    /** 引用计数 */
    get refCounter(): number { return this._refCounter; }

    private constructor(
        contentHash: string,
        name: string,
        mimeType: string | undefined,
        content: FileContent,
        sourcePaths: readonly string[],
        refCounter: number,
    ){
        this._contentHash = contentHash;
        this._name = name;
        this._mimeType = mimeType;
        this._content = content;
        this._sourcePaths = normalizeSourcePaths(sourcePaths);
        this._refCounter = refCounter;
    }

    /** 创建附件快照
     * @param name 文件名
     * @param content 文件内容
     * @param mimeType MIME 类型；未知时省略
     * @param sourcePaths 原始文件路径组；用于宿主文件丢失时尝试恢复
     * @param refCounter 初始引用计数
     * @note 指纹计算依赖 Web Crypto，因此使用异步工厂而不是构造函数
     */
    static async create(
        name: string,
        content: FileContent,
        mimeType?: string,
        sourcePaths: readonly string[] = [],
        refCounter: number = 0,
    ): Promise<AttachmentFile>{
        // 内容寻址要求快照不可变；复制一份，避免调用方修改原始字节导致指纹失配。
        // 不用 content.slice()：Buffer 的 slice 是视图，不是拷贝。
        const snapshot = new Uint8Array(content);
        const contentHash = await sha256(snapshot);
        return new AttachmentFile(contentHash, name, mimeType, snapshot, sourcePaths, refCounter);
    }

    /** 用存储层返回的实际元数据生成新快照，不重新计算指纹 */
    withMeta(meta: StoredAttachmentMeta): AttachmentFile{
        return new AttachmentFile(
            this._contentHash,
            meta.name,
            meta.mimeType,
            this._content,
            meta.sourcePaths,
            this._refCounter,
        );
    }

    /** 从已校验的存储记录恢复快照；信任记录中的 contentHash
     * @note 只应在内容来自可信存储或刚刚完成指纹校验后使用
     */
    static fromStored(stored: StoredAttachment): AttachmentFile{
        return new AttachmentFile(
            stored.contentHash,
            stored.name,
            stored.mimeType,
            new Uint8Array(stored.content),
            stored.sourcePaths,
            0,
        );
    }

    /** 增加引用计数 */
    addRefCounter(): void { this._refCounter++; }

    /** 减少引用计数 */
    removeRefCounter(): void { this._refCounter--; }
}

/** 存储层中的附件元数据 */
export type StoredAttachmentMeta = {
    contentHash: string;
    name: string;
    mimeType?: string;
    size: number;

    /** 原始文件路径组；用于宿主文件丢失时尝试恢复 */
    sourcePaths: readonly string[];
};

/** 存储层中的附件记录（元数据 + 字节） */
export type StoredAttachment = StoredAttachmentMeta & {
    content: FileContent;
};

/** 合并存储元数据：名称/MIME 首次写入为准，原始路径组取并集
 * @note 宿主实现应在同一 contentHash 的写入串行化后调用
 */
export function mergeAttachmentMeta(
    existing: StoredAttachmentMeta | undefined,
    incoming: StoredAttachment,
): StoredAttachmentMeta{
    if (existing === undefined){
        return {
            contentHash: incoming.contentHash,
            name: incoming.name,
            mimeType: incoming.mimeType,
            size: incoming.size,
            sourcePaths: normalizeSourcePaths(incoming.sourcePaths),
        };
    }

    return {
        contentHash: existing.contentHash,
        name: existing.name,
        mimeType: existing.mimeType,
        size: existing.size > 0 ? existing.size : incoming.size,
        sourcePaths: normalizeSourcePaths([...existing.sourcePaths, ...incoming.sourcePaths]),
    };
}

/** 原始文件宿主：只负责字节与元数据的读写，不计算指纹、不做缓存与去重策略
 * @note 具体实现由调用方提供（本地目录、OPFS、IndexedDB、Electron 桥接等）。
 *       附件策略（指纹、去重、缓存、恢复）由 AttachmentFileManager 负责。
 */
export interface IFileHost{

    /** 按内容指纹读取附件记录
     * @returns 记录；内容不存在时返回 undefined
     */
    read(contentHash: string): Promise<StoredAttachment | undefined>;

    /** 按内容指纹读取元数据
     * @returns 元数据；不存在时返回 undefined
     * @note 即使字节已被删除，实现也应尽量保留并返回元数据，供路径恢复使用
     */
    readMeta(contentHash: string): Promise<StoredAttachmentMeta | undefined>;

    /** 写入附件记录
     * @returns 实际生效的元数据
     * @note 内容已存在时不得覆盖；名称/MIME 以首次写入为准；
     *       原始路径组需要与已有记录合并（取并集）。
     */
    write(file: StoredAttachment): Promise<StoredAttachmentMeta>;

    /** 列出所有已知附件元数据
     * @note 可以包含字节已丢失、但仍保留元数据的记录
     */
    list(): Promise<readonly StoredAttachmentMeta[]>;

    /** 删除附件（可选） */
    delete?(contentHash: string): Promise<boolean>;

    /** 刷盘（可选）；用于需要显式同步的介质 */
    flush?(): Promise<void>;

    /** 关闭并释放资源（可选） */
    close?(): Promise<void>;
}
