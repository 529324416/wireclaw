import assert from "node:assert/strict";

import { MemoryFileHost } from "../src/file/memory";
import { AttachmentFile, AttachmentFileError, AttachmentFileErrorCode } from "../src/session/attachment";
import type { AttachmentFile as AttachmentFileType } from "../src/session/attachment";
import { AttachmentFileManager } from "../src/session/attachment-manager";
import { AIProvider, CloudFileManager } from "../src/session/protocol";
import type { RemoteFileRef } from "../src/session/type";
import { UserMessage, assistant } from "../src/session/message";
import type { Message } from "../src/session/message";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { ChatStopReason } from "../src/session/type";
import type { ChatOptions, ChatResult, SessionRuntimeOptions } from "../src/session/type";

const missingHash = "0".repeat(64);
const bytesA = new Uint8Array([1, 2, 3, 4]);
const bytesB = new Uint8Array([5, 6, 7]);

/* ---------------------------------------------------------------------------
 * 1. 可用性检查、统计、删除与孤儿清理
 * ------------------------------------------------------------------------- */
{
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const a = await manager.put("a.bin", bytesA, "application/octet-stream", ["/tmp/a.bin"]);
    const b = await manager.put("b.bin", bytesB, "application/octet-stream");

    const stats = await manager.stats();
    assert.equal(stats.count, 2);
    assert.equal(stats.totalBytes, bytesA.byteLength + bytesB.byteLength);

    const availability = await manager.inspect([a.contentHash, missingHash]);
    assert.equal(availability[0]?.status, "present");
    assert.equal(availability[1]?.status, "missing");

    await assert.rejects(
        () => manager.require(missingHash),
        (error: unknown) => error instanceof AttachmentFileError
            && error.code === AttachmentFileErrorCode.Missing,
    );

    const dryRun = await manager.gc([a.contentHash], { dryRun: true });
    assert.equal(dryRun.dryRun, true);
    assert.deepEqual(dryRun.deleted, [b.contentHash]);
    assert.equal((await manager.get(b.contentHash))?.contentHash, b.contentHash);

    const applied = await manager.gc([a.contentHash], { dryRun: false });
    assert.deepEqual(applied.deleted, [b.contentHash]);
    assert.equal(await manager.get(b.contentHash), undefined);

    assert.equal(await manager.delete(a.contentHash), true);
    assert.equal((await manager.stats()).count, 0);
    console.log("PASS attachment inspect/stats/delete/gc");
}

/* ---------------------------------------------------------------------------
 * 2. 元数据清单补充 sourcePaths 后可恢复缺失字节
 * ------------------------------------------------------------------------- */
{
    const sourcePath = "C:\\virtual\\template.png";
    const sourceBytes = new Uint8Array([9, 8, 7, 6, 5]);
    const original = await AttachmentFile.create("template.png", sourceBytes, "image/png", [sourcePath]);
    const manager = new AttachmentFileManager(new MemoryFileHost(), {
        readSourcePath: async (path) => path === sourcePath ? sourceBytes : undefined,
    });

    manager.registerRecoveryMeta({
        contentHash: original.contentHash,
        name: original.name,
        mimeType: original.mimeType,
        size: original.size,
        sourcePaths: [sourcePath],
    });

    const recovered = await manager.get(original.contentHash);
    assert.ok(recovered !== undefined);
    assert.equal(recovered.contentHash, original.contentHash);
    assert.deepEqual([...recovered.content], [...sourceBytes]);
    assert.deepEqual((await manager.getMeta(original.contentHash))?.sourcePaths, [sourcePath]);
    console.log("PASS attachment recovery metadata restores missing bytes");
}

/* ---------------------------------------------------------------------------
 * 3. 历史附件缺失只降级，不阻塞当前轮对话
 * ------------------------------------------------------------------------- */
{
    class NoopCloudFileManager extends CloudFileManager {
        calls = 0;
        async ensureFile(_file: AttachmentFileType): Promise<RemoteFileRef> {
            this.calls += 1;
            throw new Error("must not upload a missing historical attachment");
        }
    }

    class HistoryProvider extends AIProvider {
        readonly cloud = new NoopCloudFileManager();
        lastMessages: readonly Message[] | undefined;

        get title(): string {
            return "history";
        }

        override get cloudFileManager(): NoopCloudFileManager {
            return this.cloud;
        }

        async chat(
            messages: readonly Message[],
            _options: SessionRuntimeOptions,
            _turn?: ChatOptions,
        ): Promise<ChatResult> {
            this.lastMessages = messages;
            return {
                message: assistant("ok", undefined, undefined, undefined, ChatStopReason.Stop),
            };
        }
    }

    const manager = new AttachmentFileManager(new MemoryFileHost());
    const provider = new HistoryProvider();
    const history = new SessionHistory("history-session", [
        new UserMessage([
            { type: "text", text: "old message" },
            { type: "attachment", attachment: { contentHash: missingHash } },
        ]),
    ]);
    const session = new Session(provider, history, { model: "history" }, manager);

    const run = await session.run("continue");
    assert.equal(run.status, RunStatus.Completed);
    assert.equal(provider.cloud.calls, 0, "missing historical attachment must not be uploaded");

    const sent = provider.lastMessages ?? [];
    const old = sent.find((message): message is UserMessage =>
        message instanceof UserMessage
        && Array.isArray(message.content)
        && message.content.some((part) => part.type === "text" && part.text === "old message"));
    assert.ok(old !== undefined);
    assert.ok(Array.isArray(old.content));
    assert.ok(old.content.some((part) => part.type === "text"
        && part.text === `[attachment unavailable: ${missingHash}]`));
    assert.equal(
        old.content.some((part) => part.type === "attachment"),
        false,
        "missing historical attachment must not be sent as an attachment",
    );
    console.log("PASS missing historical attachment degrades to text");
}

console.log("\nAll attachment lifecycle checks passed.");
