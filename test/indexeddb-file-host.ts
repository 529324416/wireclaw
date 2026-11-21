import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";

import { IndexedDbFileHost } from "../src/file/indexeddb";
import { AttachmentFileManager } from "../src/session/attachment-manager";

const dbName = `wireclaw-idb-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const host = new IndexedDbFileHost({ dbName, indexedDB });

const sourceFiles = new Map<string, Uint8Array>();
const readSourcePath = async (path: string): Promise<Uint8Array | undefined> => {
    const bytes = sourceFiles.get(path);
    return bytes === undefined ? undefined : new Uint8Array(bytes);
};

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
console.log("PASS IndexedDB 写入 / 读取 / 去重名称 / 路径合并");

/* ---------------------------------------------------------------------------
 * 模拟内容记录被删除、元数据仍保留
 * ------------------------------------------------------------------------- */
async function deleteContentOnly(contentHash: string): Promise<void> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("contents", "readwrite");
        tx.objectStore("contents").delete(contentHash);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
    db.close();
}

await deleteContentOnly(first.contentHash);

const recoveryManager = new AttachmentFileManager(host, { readSourcePath });
const recovered = await recoveryManager.get(first.contentHash);
assert.ok(recovered !== undefined, "应从原始路径恢复附件");
assert.deepEqual([...recovered.content], [...bytes]);
assert.ok(await host.read(first.contentHash) !== undefined, "恢复后应写回 IndexedDB");

// 原始路径也不可用时，视为数据损坏
const lostBytes = new Uint8Array([9, 9, 9]);
const lostPath = "/source/lost.bin";
sourceFiles.set(lostPath, lostBytes);
const lost = await manager.put("lost.bin", lostBytes, undefined, [lostPath]);
await deleteContentOnly(lost.contentHash);
sourceFiles.delete(lostPath);

const lostManager = new AttachmentFileManager(host, { readSourcePath });
assert.equal(await lostManager.get(lost.contentHash), undefined);
assert.ok(await host.readMeta(lost.contentHash) !== undefined, "元数据应保留用于诊断");
const listedAfterLoss = await host.list();
assert.ok(listedAfterLoss.some((meta) => meta.contentHash === lost.contentHash));
console.log("PASS IndexedDB 路径恢复 / 恢复失败 / 元数据保留");

assert.equal(await host.delete(first.contentHash), true);
assert.equal(await host.read(first.contentHash), undefined);
assert.equal(await host.readMeta(first.contentHash), undefined);
console.log("PASS IndexedDB 删除");

await host.close();
console.log("\nAll IndexedDB host checks passed.");
