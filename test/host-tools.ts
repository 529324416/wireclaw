import assert from "node:assert/strict";

import { createNewSession } from "../src/create";
import { ASK_USER_TOOL_NAME, VIEW_MEDIA_TOOL_NAME } from "../src/session/host-tool";
import { assistant } from "../src/session/message";
import type { Message } from "../src/session/message";
import { AIProvider, ModelProvider } from "../src/session/protocol";
import type {
    ChatCapability,
    ModelCapabilities,
    ModelInfo,
} from "../src/session/protocol";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import type { SessionHostOptions } from "../src/session/session";
import { ChatStopReason } from "../src/session/type";
import type {
    ChatOptions,
    ChatResult,
    SessionRuntimeOptions,
} from "../src/session/type";

function section(title: string): void {
    console.log(`\n=== ${title} ===`);
}

const capabilities: ModelCapabilities = {
    chat: {
        input: ["text", "image"],
        output: ["text", "image"],
        streaming: true,
        tools: true,
    },
};

function modelInfo(): ModelInfo {
    return {
        id: "fake",
        name: "fake",
        description: "fake",
        size: 0,
        supportCompletion: true,
        supportToolCall: true,
        supportThink: false,
        isVisionModel: true,
        isEmbeddingModel: false,
        capabilities,
    };
}

class FakeModelProvider extends ModelProvider {
    async validateNetwork(): Promise<void> {
        // no-op
    }

    protected async fetchModels(): Promise<ModelInfo[]> {
        return [modelInfo()];
    }
}

class RecordingChatProvider extends AIProvider implements ChatCapability {
    readonly advertised: string[][] = [];

    private readonly _modelProvider = new FakeModelProvider();

    get title(): string {
        return "recording";
    }

    override get modelProvider(): FakeModelProvider {
        return this._modelProvider;
    }

    override get supportsTools(): boolean {
        return true;
    }

    async chat(
        _messages: readonly Message[],
        _options: SessionRuntimeOptions,
        turn?: ChatOptions,
    ): Promise<ChatResult> {
        this.advertised.push((turn?.tools ?? []).map((tool) => tool.name));
        return {
            message: assistant("ok", undefined, undefined, undefined, ChatStopReason.Stop),
        };
    }
}

async function advertisedTools(
    hostOptions?: SessionHostOptions,
    runOptions?: { enableUserInput?: boolean },
    useFactory = false,
): Promise<string[]> {
    const provider = new RecordingChatProvider();
    const session = useFactory
        ? createNewSession(provider, undefined, { model: "fake" }, hostOptions)
        : new Session(
            provider,
            new SessionHistory(),
            { model: "fake" },
            undefined,
            hostOptions,
        );

    const run = await session.run("hello", runOptions);
    assert.equal(run.status, RunStatus.Completed);
    return provider.advertised.at(-1) ?? [];
}

section("默认行为");
{
    const tools = await advertisedTools();
    assert.ok(tools.includes(ASK_USER_TOOL_NAME), `missing ask_user: ${tools.join(", ")}`);
    assert.ok(tools.includes(VIEW_MEDIA_TOOL_NAME), `missing view_media: ${tools.join(", ")}`);
    console.log("PASS 默认注册 ask_user 与 view_media");
}

section("整体关闭");
{
    const tools = await advertisedTools({ hostTools: false });
    assert.deepEqual(tools, []);
    console.log("PASS hostTools: false 不注册任何 host 工具");
}

section("单独关闭");
{
    const noAsk = await advertisedTools({ hostTools: { askUser: false } });
    assert.ok(!noAsk.includes(ASK_USER_TOOL_NAME));
    assert.ok(noAsk.includes(VIEW_MEDIA_TOOL_NAME));

    const noView = await advertisedTools({ hostTools: { viewMedia: false } });
    assert.ok(noView.includes(ASK_USER_TOOL_NAME));
    assert.ok(!noView.includes(VIEW_MEDIA_TOOL_NAME));
    console.log("PASS askUser / viewMedia 可独立关闭");
}

section("run 级开关叠加");
{
    const tools = await advertisedTools(undefined, { enableUserInput: false });
    assert.ok(!tools.includes(ASK_USER_TOOL_NAME));
    assert.ok(tools.includes(VIEW_MEDIA_TOOL_NAME));

    const disabled = await advertisedTools({ hostTools: false }, { enableUserInput: true });
    assert.deepEqual(disabled, []);
    console.log("PASS run 级 enableUserInput 只能进一步关闭，不能越过会话总开关");
}

section("工厂入口与非法配置");
{
    const tools = await advertisedTools({ hostTools: false }, undefined, true);
    assert.deepEqual(tools, []);

    const provider = new RecordingChatProvider();
    assert.throws(
        () => new Session(
            provider,
            new SessionHistory(),
            { model: "fake" },
            undefined,
            { hostTools: "yes" as never },
        ),
        /hostTools must be a boolean or an object/,
    );
    console.log("PASS createNewSession 支持 hostOptions；非法配置在构造期报错");
}

console.log("\nAll host tool registration checks passed.");
