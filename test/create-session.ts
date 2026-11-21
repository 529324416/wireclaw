import assert from "node:assert/strict";

import { createNewSession } from "../src/create";
import { AttachmentFileManager } from "../src/session/attachment-manager";
import { assistant } from "../src/session/message";
import { AIProvider, ProtocolAdapter } from "../src/session/protocol";
import { RunStatus } from "../src/session/session";
import { ChatStopReason } from "../src/session/type";
import type { ChatOptions, ChatResult, SessionRuntimeOptions } from "../src/session/type";
import type { AssistantMessage, Message } from "../src/session/message";
import { MemoryFileHost } from "../src/file/memory";

class FakeAdapter extends ProtocolAdapter {
    toAssistantMessage(_payload: unknown): AssistantMessage {
        throw new Error("not used");
    }

    toPayload(msg: Message) {
        return { role: msg.role, content: msg.content };
    }

    parseStreamChunk(_raw: unknown) {
        return [];
    }
}

class FakeLLM extends AIProvider {
    readonly adapter = new FakeAdapter();
    readonly models: Array<string | undefined> = [];
    defaultModelCalls = 0;

    constructor(private readonly _defaultModel?: string) {
        super();
    }

    override get modelProvider(): null {
        return null;
    }

    get protocolAdapter(): ProtocolAdapter {
        return this.adapter;
    }

    get title(): string {
        return "fake";
    }

    override async resolveDefaultModel(): Promise<string | undefined> {
        this.defaultModelCalls += 1;
        return this._defaultModel;
    }

    async chat(
        _messages: readonly Message[],
        options: SessionRuntimeOptions,
        _turn?: ChatOptions,
    ): Promise<ChatResult> {
        this.models.push(options.model);
        return {
            message: assistant("ok", undefined, undefined, undefined, ChatStopReason.Stop),
        };
    }
}

{
    const llm = new FakeLLM("auto-model");
    const session = createNewSession(llm);

    assert.ok(session.history !== undefined);
    assert.equal(session.history.isEmpty, true);
    assert.equal(session.attachmentManager, undefined);

    const run = await session.run("hello");
    assert.equal(run.status, RunStatus.Completed);
    assert.equal(llm.models[0], "auto-model");
    assert.equal(llm.defaultModelCalls, 1);
    assert.equal(session.history?.messages.length, 2);
    console.log("PASS createNewSession 默认新历�?+ 自动模型");
}

{
    const llm = new FakeLLM("auto-model");
    const session = createNewSession(llm, undefined, { model: "manual-model", think: true });

    await session.run("hello");
    assert.equal(llm.models[0], "manual-model");
    assert.equal(llm.defaultModelCalls, 0);
    console.log("PASS 显式 runtimeOptions 优先，不触发默认模型");
}

{
    const llm = new FakeLLM("auto-model");
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const session = createNewSession(llm, manager);

    assert.equal(session.attachmentManager, manager);

    const other = createNewSession(llm, manager);
    assert.notEqual(session.history?.id, other.history?.id);
    assert.equal(other.history?.isEmpty, true);
console.log("PASS attachment manager injection + independent new session");
}

console.log("\nAll session factory checks passed.");
