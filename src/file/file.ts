import { sha256 } from "../base";
import type { FileContent } from "./type";

/** 附件文件的不可变快照，使用内容指纹标识 */
export class AttachmentFile {

    private readonly _contentHash: string;
    private readonly _name: string;
    private readonly _mimeType: string | undefined;
    private readonly _content: FileContent;
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

    /** 引用计数 */
    get refCounter(): number { return this._refCounter; }

    private constructor(
        contentHash: string,
        name: string,
        mimeType: string | undefined,
        content: FileContent,
        refCounter: number,
    ){
        this._contentHash = contentHash;
        this._name = name;
        this._mimeType = mimeType;
        this._content = content;
        this._refCounter = refCounter;
    }

    /** 创建附件快照
     * @param name 文件名
     * @param content 文件内容
     * @param mimeType MIME 类型；未知时省略
     * @param refCounter 初始引用计数
     * @note 指纹计算依赖 Web Crypto，因此使用异步工厂而不是构造函数
     */
    static async create(
        name: string,
        content: FileContent,
        mimeType?: string,
        refCounter: number = 0,
    ): Promise<AttachmentFile>{
        // 内容寻址要求快照不可变；复制一份，避免调用方修改原始字节导致指纹失配。
        // 不用 content.slice()：Buffer 的 slice 是视图，不是拷贝。
        const snapshot = new Uint8Array(content);
        const contentHash = await sha256(snapshot);
        return new AttachmentFile(contentHash, name, mimeType, snapshot, refCounter);
    }

    /** 增加引用计数 */
    addRefCounter(): void { this._refCounter++; }

    /** 减少引用计数 */
    removeRefCounter(): void { this._refCounter--; }
}

/** 文件宿主：负责本地不可变文件的写入与读取
 * @note 具体实现由调用方提供（本地目录、数据库、浏览器 IndexedDB 等）。
 *       底层只要求 put / get，Node 端可以从路径读取后再调用 put；
 *       浏览器端可以从 File / Blob 读取后再调用 put。
 */
export interface IFileHost{

    /** 写入文件
     * @param name 文件名
     * @param content 文件内容
     * @param mimeType MIME 类型；未知时省略
     * @returns 文件快照
     * @note 实现应当以内容指纹去重；相同内容重复写入时返回已有快照
    */
    put(name: string, content: FileContent, mimeType?: string): Promise<AttachmentFile>;

    /** 按内容指纹读取文件
     * @param contentHash 内容指纹
     * @returns 文件快照；不存在时返回 undefined
    */
    get(contentHash: string): Promise<AttachmentFile | undefined>;
}
