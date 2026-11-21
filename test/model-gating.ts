import assert from "node:assert/strict";

import { DeepSeekProvider } from "../src/platform/deepseek";
import {
    SessionError,
    SessionErrorType,
    ToolError,
    ToolErrorType,
    isSessionError,
    toSessionError,
} from "../src/session/error";
import { UserMessage, assistant } from "../src/session/message";
import type { Message } from "../src/session/message";
import { AIProvider, ModelProvider } from "../src/session/protocol";
import type { ChatCapability, ModelInfo } from "../src/session/protocol";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { ToolRegistry } from "../src/session/tool";
import type { ToolProvider } from "../src/session/tool";
import type { ToolDefinition } from "../src/session/type";
import { ChatStopReason } from "../src/session/type";
import type {
    ChatOptions,
    ChatResult,
    SessionRuntimeOptions,
} from "../src/session/type";

class TestModelProvider extends ModelProvider {

    private readonly _models: readonly ModelInfo[];

    constructor(models: readonly ModelInfo[]) {
        super();
        this._models = models;
    }

    async validateNetwork(): Promise<void> {
        // no-op
    }

    protected async fetchModels(): Promise<ModelInfo[]> {
        return [...this._models];
    }
}

type RecordedRequest = {
    options: SessionRuntimeOptions;
    tools?: readonly ToolDefinition[];
};

class GatedProvider extends AIProvider implements ChatCapability {

    readonly requests: RecordedRequest[] = [];
    private readonly _modelProvider: TestModelProvider;

    constructor(models: readonly ModelInfo[]) {
        super();
        this._modelProvider = new TestModelProvider(models);
    }

    get title(): string {
        return "gated";
    }

    override get modelProvider(): TestModelProvider {
        return this._modelProvider;
    }

    override get supportsTools(): boolean {
        return true;
    }

    async chat(
        _messages: readonly Message[],
        options: SessionRuntimeOptions,
        turn?: ChatOptions,
    ): Promise<ChatResult> {
        this.requests.push({ options: { ...options }, tools: turn?.tools });
        return {
            message: assistant("ok", undefined, undefined, undefined, ChatStopReason.Stop),
        };
    }
}

function modelInfo(capabilities: { tools: boolean; thinking: boolean }): ModelInfo {
    return {
        id: "gated",
        name: "gated",
        description: "gated model",
        size: 0,
        supportCompletion: true,
        supportToolCall: capabilities.tools,
        supportThink: capabilities.thinking,
        isVisionModel: false,
        isEmbeddingModel: false,
        capabilities: {
            chat: {
                input: ["text"],
                output: ["text"],
                streaming: true,
                tools: capabilities.tools,
                thinking: capabilities.thinking,
            },
        },
    };
}

function makeRegistry(
    providerId: string = "fake",
    toolName: string = "ping",
): ToolRegistry {
    const provider: ToolProvider = {
        id: providerId,
        name: providerId,
        description: providerId,
        async fetchTools(): Promise<ToolDefinition[]> {
            return [{
                name: toolName,
                description: toolName,
                inputSchema: { type: "object" },
            }];
        },
        async call() {
            return {
                content: "ok",
                status: { isSuccess: true, duration: 0 },
            };
        },
    };

    const registry = new ToolRegistry();
    registry.registerProvider(provider);
    return registry;
}

/* ---------------------------------------------------------------------------
 * 1. 模型声明 tools:false / thinking:false 时不广告工具、不传思考参数
 * ------------------------------------------------------------------------- */
{
    const provider = new GatedProvider([modelInfo({ tools: false, thinking: false })]);
    const session = new Session(
        provider,
        new SessionHistory(),
        { model: "gated", think: true, thinkingLv: "high" },
    );

    const run = await session.run("hello", { tools: makeRegistry() });

    assert.equal(run.status, RunStatus.Completed);
    const request = provider.requests[0];
    assert.ok(request !== undefined);
    assert.equal(request.tools, undefined, "model tools:false must not advertise tools");
    assert.equal(request.options.think, undefined, "model thinking:false must strip think");
    assert.equal(
        request.options.thinkingLv,
        undefined,
        "model thinking:false must strip thinkingLv",
    );
    console.log("PASS model tools/thinking gate strips unsupported options");
}

/* ---------------------------------------------------------------------------
 * 2. 模型声明支持时不误伤工具与思考参数
 * ------------------------------------------------------------------------- */
{
    const provider = new GatedProvider([modelInfo({ tools: true, thinking: true })]);
    const session = new Session(
        provider,
        new SessionHistory(),
        { model: "gated", think: true, thinkingLv: "high" },
    );

    const run = await session.run("hello", { tools: makeRegistry() });

    assert.equal(run.status, RunStatus.Completed);
    const request = provider.requests[0];
    assert.ok(request !== undefined);
    assert.deepEqual(
        request.tools?.map((tool) => tool.name).sort(),
        ["fake__ping", "host__ask_user"],
    );
    assert.equal(request.options.think, true);
    assert.equal(request.options.thinkingLv, "high");
    console.log("PASS model tools/thinking gate preserves supported options");
}

/* ---------------------------------------------------------------------------
 * 3. host 工具注入去重：Provider 已提供同名工具时只保留一份
 * ------------------------------------------------------------------------- */
{
    const provider = new GatedProvider([modelInfo({ tools: true, thinking: true })]);
    const session = new Session(
        provider,
        new SessionHistory(),
        { model: "gated" },
    );

    await session.run("hello", { tools: makeRegistry("host", "ask_user") });

    const names = provider.requests[0]?.tools?.map((tool) => tool.name) ?? [];
    assert.equal(
        names.filter((name) => name === "host__ask_user").length,
        1,
        "host__ask_user must be injected only once",
    );
    console.log("PASS host tool injection is deduplicated");
}

/* ---------------------------------------------------------------------------
 * 4. Provider 级思考门禁：DeepSeek 只在模型声明 thinking 时发送参数
 * ------------------------------------------------------------------------- */
{
    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (
        _input: string | URL | Request,
        init?: RequestInit,
    ): Promise<Response> => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response("data: [DONE]\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
        });
    }) as typeof fetch;

    const provider = new DeepSeekProvider({ apiKey: "test-key", fetch: fetchImpl });

    provider.overwrite("deepseek-v4-pro", {
        capabilities: {
            chat: {
                input: ["text"],
                output: ["text"],
                streaming: true,
                tools: true,
                thinking: false,
            },
        },
    });

    await provider.chat(
        [new UserMessage("hello")],
        { model: "deepseek-v4-pro", think: true, thinkingLv: "high" },
        { signal: new AbortController().signal },
    );

    assert.ok(body !== undefined);
    assert.equal(body.thinking, undefined);
    assert.equal(body.reasoning_effort, undefined);

    provider.overwrite("deepseek-flash", {
        capabilities: {
            chat: {
                input: ["text"],
                output: ["text"],
                streaming: true,
                tools: true,
                thinking: true,
            },
        },
    });

    await provider.chat(
        [new UserMessage("hello")],
        { model: "deepseek-flash", think: true, thinkingLv: "high" },
        { signal: new AbortController().signal },
    );

    assert.ok(body !== undefined);
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.equal(body.reasoning_effort, "high");
    console.log("PASS DeepSeek thinking parameters follow model capabilities");
}

/* ---------------------------------------------------------------------------
 * 5. ModelProvider.fetchCount 每次真实拉取只计数一次
 * ------------------------------------------------------------------------- */
{
    const modelProvider = new TestModelProvider([modelInfo({ tools: true, thinking: true })]);
    assert.equal(modelProvider.fetchCount, 0);

    await modelProvider.initModels();
    assert.equal(modelProvider.fetchCount, 1);

    await modelProvider.initModels();
    assert.equal(modelProvider.fetchCount, 1);
    console.log("PASS ModelProvider.fetchCount is not double counted");
}

/* ---------------------------------------------------------------------------
 * 6. isSessionError 不应把 ToolError 当成 SessionError
 * ------------------------------------------------------------------------- */
{
    const toolError = new ToolError(ToolErrorType.InvalidParams, false, "bad params");
    assert.equal(isSessionError(toolError), false);

    const sessionError = new SessionError(SessionErrorType.InvalidRequest, "bad request");
    assert.equal(isSessionError(sessionError), true);
    assert.equal(toSessionError(sessionError), sessionError);

    const converted = toSessionError(toolError);
    assert.ok(converted instanceof SessionError);
    assert.notEqual(converted, toolError);
    assert.equal(converted.type, SessionErrorType.Unknown);
    console.log("PASS error classification distinguishes ToolError and SessionError");
}

console.log("\nAll model gating checks passed.");
