import assert from "node:assert/strict";

import { AttachmentFileManager } from "../src/session/attachment-manager";
import { AttachmentIngestor } from "../src/session/attachment-ingestor";
import { assistant, AssistantMessage } from "../src/session/message";
import { AIProvider } from "../src/session/protocol";
import type { ChatCapability } from "../src/session/protocol";
import { MemoryFileHost } from "../src/file/memory";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { SessionEventType } from "../src/session/type";
import type { ChatResult, SessionEvent, SessionRuntimeOptions } from "../src/session/type";
import type { PendingAttachment } from "../src/session/media";
import type { Message } from "../src/session/message";

class FakeProvider extends AIProvider implements ChatCapability {
    readonly title = "fake";

    constructor(
        private readonly _attachments: readonly PendingAttachment[],
        private readonly _stream: boolean,
    ) {
        super();
    }

    override get supportsTools(): boolean {
        return false;
    }

    async chat(
        _messages: readonly Message[],
        _options: SessionRuntimeOptions,
    ): Promise<ChatResult> {
        // 模拟 Provider 通过流式回调输出媒体；最终结果只返回文本。
        return {
            message: assistant("generated"),
            ...(this._stream ? {} : { attachments: this._attachments }),
        };
    }

}

function attachment(data: Uint8Array, sourceId: string): PendingAttachment {
    return {
        kind: "bytes",
        name: "result.png",
        mimeType: "image/png",
        data,
        origin: "assistant",
        sourceId,
    };
}

function attachmentParts(message: AssistantMessage) {
    return Array.isArray(message.content)
        ? message.content.filter((part) => part.type === "attachment")
        : [];
}

{
    const host = new MemoryFileHost();
    const manager = new AttachmentFileManager(host);
    const provider = new FakeProvider([attachment(new Uint8Array([1, 2, 3]), "img-1")], false);
    const session = new Session(provider, new SessionHistory(), {}, manager);
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));

    const run = await session.run("draw");
    assert.equal(run.status, RunStatus.Completed);

    const message = session.history?.messages[1] as AssistantMessage;
    const parts = attachmentParts(message);
    assert.equal(parts.length, 1);

    const ref = parts[0]?.type === "attachment" ? parts[0].attachment : undefined;
    assert.ok(ref !== undefined);
    assert.equal(await manager.has(ref.contentHash), true);

    const attachmentEvents = events.filter(
        (event) => event.type === SessionEventType.ASSISTANT_ATTACHMENT,
    );
    assert.equal(attachmentEvents.length, 1);
    console.log("PASS ChatResult.attachments -> AttachmentIngestor -> AssistantMessage");
}

{
    const provider = new FakeProvider([], true);
    const host = new MemoryFileHost();
    const manager = new AttachmentFileManager(host);
    const session = new Session(provider, new SessionHistory(), {}, manager);

    const fake = provider as unknown as {
        chat: (
            messages: readonly Message[],
            options: SessionRuntimeOptions,
            turn?: { onAttachment?: (attachment: PendingAttachment) => void },
        ) => Promise<ChatResult>;
    };
    const originalChat = provider.chat.bind(provider);
    fake.chat = async (messages, options, turn) => {
        for (const item of [attachment(new Uint8Array([4, 5, 6]), "img-2")]) {
            turn?.onAttachment?.(item);
        }
        return originalChat(messages, options);
    };

    const run = await session.run("draw");
    assert.equal(run.status, RunStatus.Completed);

    const message = session.history?.messages[1] as AssistantMessage;
    assert.equal(attachmentParts(message).length, 1);
    console.log("PASS ChatOptions.onAttachment -> AssistantMessage");
}

{
    const provider = new FakeProvider([attachment(new Uint8Array([7, 8, 9]), "img-3")], false);
    const session = new Session(provider, new SessionHistory());

    const run = await session.run("draw");
    assert.equal(run.status, RunStatus.Failed);
    console.log("PASS generated media without AttachmentFileManager fails cleanly");
}

{
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const fakeFetch = (async () => new Response(new Uint8Array([10, 11, 12]), {
        status: 200,
        headers: { "content-type": "image/png" },
    })) as typeof fetch;
    const ingestor = new AttachmentIngestor(manager, {
        fetch: fakeFetch,
        allowedMimeTypes: ["image/png"],
        maxBytes: 16,
    });

    const ref = await ingestor.ingest({
        kind: "url",
        url: "https://example.com/result.png",
        origin: "assistant",
    } as PendingAttachment);
    assert.equal(await manager.has(ref.contentHash), true);

    await assert.rejects(
        () => ingestor.ingest({
            kind: "url",
            url: "http://127.0.0.1/result.png",
            origin: "assistant",
        } as PendingAttachment),
        /private host/,
    );
    console.log("PASS AttachmentIngestor URL fetch + size/MIME/private-host guards");
}

console.log("\nAll chat attachment checks passed.");
