import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import { sanitizePathInput, toBase64 } from "../src/base";
import { detectImageMimeType, normalizeImageMimeType } from "../src/file";
import { LocalFileHost, readLocalSourcePath } from "../src/file/local";
import { AttachmentFileManager } from "../src/session/attachment-manager";

/* ---------------------------------------------------------------------------
 * 1. base64 / 图片头识别
 * ------------------------------------------------------------------------- */
assert.equal(toBase64(new TextEncoder().encode("hello")), "aGVsbG8=");
assert.equal(normalizeImageMimeType("image/jpg"), "image/jpeg");
assert.equal(detectImageMimeType(new Uint8Array([0xff, 0xd8, 0xff])), "image/jpeg");
assert.equal(
    detectImageMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "image/png",
);
assert.equal(
    detectImageMimeType(new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    ])),
    "image/webp",
);
assert.equal(detectImageMimeType(new TextEncoder().encode("not an image")), undefined);
assert.equal(
    sanitizePathInput("\u202AF:\\images\\a b.jpg"),
    "F:\\images\\a b.jpg",
    "should strip bidi control characters from copied paths",
);
assert.equal(
    win32.resolve("D:\\cwd", sanitizePathInput("\u202AF:\\images\\a b.jpg")),
    "F:\\images\\a b.jpg",
    "a sanitized drive path should stay absolute",
);
assert.equal(sanitizePathInput('"F:\\images\\a b.jpg"'), "F:\\images\\a b.jpg");
console.log("PASS base64 / 图片类型识别 / 路径不可见字符清理");

/* ---------------------------------------------------------------------------
 * 2. LocalFileHost + AttachmentFileManager：内容寻址、去重、首次名称、路径合并
 * ------------------------------------------------------------------------- */
const root = await mkdtemp(join(tmpdir(), "wireclaw-file-host-"));
const sourceRoot = await mkdtemp(join(tmpdir(), "wireclaw-source-"));

try {
    const host = new LocalFileHost(root);
    const manager = new AttachmentFileManager(host, { readSourcePath: readLocalSourcePath });
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const firstPath = join(sourceRoot, "first.bin");
    await writeFile(firstPath, bytes);

    const first = await manager.put("first.bin", bytes, "application/octet-stream", [firstPath]);
    assert.equal(first.contentHash.length, 64);
    assert.equal(first.name, "first.bin");
    assert.equal(first.mimeType, "application/octet-stream");
    assert.deepEqual([...first.sourcePaths], [firstPath]);

    const got = await manager.get(first.contentHash);
    assert.ok(got !== undefined);
    assert.equal(got.contentHash, first.contentHash);
    assert.equal(got.name, "first.bin");
    assert.equal(got.mimeType, "application/octet-stream");
    assert.deepEqual([...got.content], [...bytes]);
    assert.deepEqual([...got.sourcePaths], [firstPath]);

    // 相同内容从另一个路径写入：名称保持首次值，路径组合并
    const secondPath = join(sourceRoot, "second.bin");
    await writeFile(secondPath, bytes);
    const second = await manager.put("second.bin", bytes, "application/octet-stream", [secondPath]);
    assert.equal(second.contentHash, first.contentHash);
    assert.equal(second.name, "first.bin");
    assert.deepEqual([...second.sourcePaths], [firstPath, secondPath]);

    const merged = await manager.get(first.contentHash);
    assert.deepEqual([...merged!.sourcePaths], [firstPath, secondPath]);

    assert.equal(await manager.get("0".repeat(64)), undefined);
    assert.equal(await manager.get("../escape"), undefined);

    // 原始宿主元数据也保留路径组
    const meta = await host.readMeta(first.contentHash);
    assert.ok(meta !== undefined);
    assert.deepEqual([...meta.sourcePaths], [firstPath, secondPath]);
    assert.equal((await host.list()).length, 1);
    console.log("PASS LocalFileHost 内容寻址 / 去重 / 首次名称 / 路径合并");

    /* -----------------------------------------------------------------------
     * 3. 宿主字节丢失后，从原始路径恢复
     * ----------------------------------------------------------------------- */
    await rm(join(root, first.contentHash));

    const recoveryManager = new AttachmentFileManager(host, {
        readSourcePath: readLocalSourcePath,
    });
    const recovered = await recoveryManager.get(first.contentHash);
    assert.ok(recovered !== undefined, "应从原始路径恢复附件");
    assert.deepEqual([...recovered.content], [...bytes]);
    assert.ok(await host.read(first.contentHash) !== undefined, "恢复后应写回宿主");

    // 原始路径也找不到时，视为数据损坏
    const lostBytes = new Uint8Array([9, 9, 9]);
    const lostPath = join(sourceRoot, "lost.bin");
    await writeFile(lostPath, lostBytes);
    const lost = await manager.put("lost.bin", lostBytes, undefined, [lostPath]);

    await rm(join(root, lost.contentHash));
    await rm(lostPath);

    const lostManager = new AttachmentFileManager(host, {
        readSourcePath: readLocalSourcePath,
    });
    assert.equal(await lostManager.get(lost.contentHash), undefined);
    assert.ok(await host.readMeta(lost.contentHash) !== undefined, "元数据应保留用于诊断");

    // 重建索引时包含字节已丢失、但元数据仍在的记录
    const rebuilt = new AttachmentFileManager(host);
    await rebuilt.rebuild();
    assert.ok(rebuilt.size >= 2);
    console.log("PASS 路径恢复 / 恢复失败 / 索引重建");
} finally {
    await rm(root, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
}

console.log("\nAll local file host checks passed.");
