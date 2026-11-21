import assert from "node:assert/strict";

import { OpfsFileHost } from "../src/file/opfs";
import { AttachmentFileManager } from "../src/session/attachment-manager";

/** 最小 OPFS 替身：只实现 OpfsFileHost 用到的目录/文件能力 */
class FakeFileHandle {
    readonly kind = "file";
    readonly name: string;
    private readonly _dir: FakeDirectoryHandle;

    constructor(dir: FakeDirectoryHandle, name: string) {
        this._dir = dir;
        this.name = name;
    }

    async getFile(): Promise<{ size: number; arrayBuffer: () => Promise<ArrayBuffer>; text: () => Promise<string> }> {
        const bytes = this._dir.files.get(this.name) ?? new Uint8Array();
        return {
            size: bytes.byteLength,
            arrayBuffer: async () => bytes.slice().buffer,
            text: async () => new TextDecoder().decode(bytes),
        };
    }

    async createWritable(): Promise<{ write: (chunk: Uint8Array) => Promise<void>; close: () => Promise<void> }> {
        const chunks: Uint8Array[] = [];
        return {
            write: async (chunk: Uint8Array) => {
                chunks.push(new Uint8Array(chunk));
            },
            close: async () => {
                const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
                const bytes = new Uint8Array(length);
                let offset = 0;
                for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                this._dir.files.set(this.name, bytes);
            },
        };
    }
}

class FakeDirectoryHandle {
    readonly kind = "directory";
    readonly name = "root";
    readonly files = new Map<string, Uint8Array>();

    async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
        if (!this.files.has(name)) {
            if (options?.create !== true) {
                throw Object.assign(new Error(`not found: ${name}`), { name: "NotFoundError" });
            }
            this.files.set(name, new Uint8Array());
        }
        return new FakeFileHandle(this, name);
    }

    async removeEntry(name: string): Promise<void> {
        if (!this.files.delete(name)) {
            throw Object.assign(new Error(`not found: ${name}`), { name: "NotFoundError" });
        }
    }

    async *entries(): AsyncGenerator<[string, FakeFileHandle]> {
        for (const name of [...this.files.keys()]) {
            yield [name, new FakeFileHandle(this, name)];
        }
    }
}

const dir = new FakeDirectoryHandle();
const sourceFiles = new Map<string, Uint8Array>();
const readSourcePath = async (path: string): Promise<Uint8Array | undefined> => {
    const bytes = sourceFiles.get(path);
    return bytes === undefined ? undefined : new Uint8Array(bytes);
};

const host = new OpfsFileHost({ root: dir });
const manager = new AttachmentFileManager(host, { readSourcePath });

const bytes = new Uint8Array([1, 2, 3, 4]);
const firstPath = "/source/first.bin";
sourceFiles.set(firstPath, bytes);

const first = await manager.put("first.bin", bytes, "application/octet-stream", [firstPath]);
assert.equal(first.contentHash.length, 64);
assert.equal(first.name, "first.bin");
assert.deepEqual([...first.sourcePaths], [firstPath]);

const got = await manager.get(first.contentHash);
assert.ok(got !== undefined);
assert.deepEqual([...got.content], [...bytes]);
assert.deepEqual([...got.sourcePaths], [firstPath]);

const secondPath = "/source/second.bin";
sourceFiles.set(secondPath, bytes);
const second = await manager.put("second.bin", bytes, "application/octet-stream", [secondPath]);
assert.equal(second.contentHash, first.contentHash);
assert.equal(second.name, "first.bin");
assert.deepEqual([...second.sourcePaths], [firstPath, secondPath]);

const metas = await host.list();
assert.equal(metas.length, 1);
assert.deepEqual([...metas[0].sourcePaths], [firstPath, secondPath]);
console.log("PASS OPFS 写入 / 读取 / 去重名称 / 路径合并");

// 模拟 OPFS 静默删除内容文件，保留元数据
dir.files.delete(first.contentHash);

const recoveryManager = new AttachmentFileManager(host, { readSourcePath });
const recovered = await recoveryManager.get(first.contentHash);
assert.ok(recovered !== undefined);
assert.deepEqual([...recovered.content], [...bytes]);
assert.ok(dir.files.has(first.contentHash), "恢复后应写回 OPFS");

// 原始路径也不可用时，视为数据损坏
const lostBytes = new Uint8Array([9, 9, 9]);
const lostPath = "/source/lost.bin";
sourceFiles.set(lostPath, lostBytes);
const lost = await manager.put("lost.bin", lostBytes, undefined, [lostPath]);
dir.files.delete(lost.contentHash);
sourceFiles.delete(lostPath);

const lostManager = new AttachmentFileManager(host, { readSourcePath });
assert.equal(await lostManager.get(lost.contentHash), undefined);
assert.ok(await host.readMeta(lost.contentHash) !== undefined);
console.log("PASS OPFS 路径恢复 / 恢复失败 / 元数据保留");

console.log("\nAll OPFS host checks passed.");
