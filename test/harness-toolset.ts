import assert from "node:assert/strict";

import {
    Edge,
    Graph,
    HarnessBuiltinNodeType,
    HarnessError,
    HarnessErrorCode,
    ToolSet,
    createBuiltinNodeRegistry,
} from "../src/harness";
import { assistant } from "../src/session/message";
import type { Message } from "../src/session/message";
import { AIProvider } from "../src/session/protocol";
import { ToolErrorType } from "../src/session/error";
import { ToolRegistry } from "../src/session/tool";
import type { ToolProvider } from "../src/session/tool";
import { ChatStopReason } from "../src/session/type";
import type {
    ChatOptions,
    ChatResult,
    ChatUsage,
    SessionRuntimeOptions,
    ToolCall,
    ToolCallResult,
    ToolDefinition,
} from "../src/session/type";

function section(title: string): void{
    console.log(`\n=== ${title} ===`);
}

function usage(): ChatUsage{
    return { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
}

class TwoToolProvider implements ToolProvider{

    readonly id = "tools";
    readonly name = "tools";
    readonly description = "two tools";

    async fetchTools(): Promise<ToolDefinition[]>{
        return [
            {
                name: "echo",
                description: "echo",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true },
            },
            {
                name: "write",
                description: "write",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true },
            },
        ];
    }

    async call(call: ToolCall): Promise<ToolCallResult>{
        return {
            content: `called:${call.name}`,
            status: { isSuccess: true, duration: 0 },
        };
    }
}

class CapturingChatProvider extends AIProvider{

    readonly advertised: string[][] = [];

    get title(): string{
        return "capture";
    }

    override get supportsTools(): boolean{
        return true;
    }

    async chat(
        _messages: readonly Message[],
        _options: SessionRuntimeOptions,
        turn?: ChatOptions,
    ): Promise<ChatResult>{
        this.advertised.push((turn?.tools ?? []).map((tool) => tool.name));
        return {
            message: assistant("final", undefined, usage(), undefined, ChatStopReason.Stop),
        };
    }
}

function createRegistry() {
    return createBuiltinNodeRegistry();
}

function node(
    registry: ReturnType<typeof createRegistry>,
    id: string,
    type: string,
    config?: unknown,
) {
    return registry.createNode({
        id,
        type,
        typeVersion: 1,
        config: config as never,
    });
}

section("ToolSet 过滤、收窄与 host 策略");
{
    const registry = new ToolRegistry();
    registry.registerProvider(new TwoToolProvider());

    const scoped = new ToolSet(registry, [{
        include: ["tools__*"],
        exclude: ["tools__write"],
    }]);
    const tools = await scoped.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["tools__echo"]);

    const hidden = await scoped.invoke({
        id: "call-write",
        name: "tools__write",
        params: {},
    });
    assert.equal(hidden.status.isSuccess, false);
    assert.equal(hidden.status.error?.type, ToolErrorType.NotFound);

    const narrowed = scoped.narrow({ include: ["tools__write"] });
    assert.deepEqual((await narrowed.listTools()).map((tool) => tool.name), []);

    const host = new ToolSet(registry, [
        { hostTools: { askUser: false } },
        { hostTools: { viewMedia: false } },
    ]);
    assert.deepEqual(host.hostTools, { askUser: false, viewMedia: false });
    console.log("PASS include/exclude、narrow 交集与 host 工具 AND 合并");
}

section("Graph 级 ToolSet 序列化");
{
    const registry = createRegistry();
    const graph = new Graph([], [], {
        id: "toolset-graph",
        toolSet: {
            include: ["tools__*"],
            exclude: ["tools__write"],
            hostTools: { askUser: false },
        },
    });

    const document = graph.toJSON();
    assert.deepEqual(document.toolSet, graph.toolSet);
    const loaded = Graph.fromJSON(document, { registry });
    assert.deepEqual(loaded.toolSet, graph.toolSet);

    assert.throws(
        () => Graph.fromJSON({
            ...document,
            toolSet: { include: [1] },
        }, { registry }),
        (error: unknown) => error instanceof HarnessError
            && error.code === HarnessErrorCode.InvalidDocument,
    );
    console.log("PASS Graph.toolSet 往返与非法 spec 拒绝");
}

section("B 节点按 ToolSet 收窄工具范围");
{
    const registry = createRegistry();
    const tools = new ToolRegistry();
    tools.registerProvider(new TwoToolProvider());
    const provider = new CapturingChatProvider();

    const input = node(registry, "input", HarnessBuiltinNodeType.Input);
    const model = node(registry, "model", HarnessBuiltinNodeType.Model, {
        providerId: "fake",
        modelId: "capture-model",
    });
    const toolset = node(registry, "toolset", HarnessBuiltinNodeType.ToolSet, {
        include: ["tools__echo"],
    });
    const agent = node(registry, "agent", HarnessBuiltinNodeType.AgentRun, {
        permission: "readonly",
        maxSteps: 1,
    });
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const graph = new Graph([input, model, toolset, agent, output], [
        new Edge({ nodeId: "input", port: "text" }, { nodeId: "agent", port: "input" }),
        new Edge({ nodeId: "model", port: "model" }, { nodeId: "agent", port: "model" }),
        new Edge({ nodeId: "toolset", port: "toolset" }, { nodeId: "agent", port: "toolset" }),
        new Edge({ nodeId: "agent", port: "text" }, { nodeId: "output", port: "text" }),
    ], {
        id: "toolset-b-graph",
        toolSet: {
            include: ["tools__*"],
            hostTools: { askUser: false, viewMedia: false },
        },
    });

    const result = await graph.run({
        host: {
            resolveProvider: (id) => id === "fake" ? provider : undefined,
            tools,
        },
        input: { text: "hello" },
    }).done;

    assert.equal(result.status, "completed");
    assert.deepEqual(provider.advertised.at(-1), ["tools__echo"]);
    console.log("PASS Graph ToolSet 与节点 ToolSet 叠加后只广告 tools__echo");
}

section("ChoiceNode 值选择");
{
    const registry = createRegistry();
    const condition = node(registry, "condition", HarnessBuiltinNodeType.Constant, {
        value: { type: "json", value: true },
    });
    const whenTrue = node(registry, "true", HarnessBuiltinNodeType.Constant, {
        value: { type: "text", text: "yes" },
    });
    const whenFalse = node(registry, "false", HarnessBuiltinNodeType.Constant, {
        value: { type: "text", text: "no" },
    });
    const choice = node(registry, "choice", HarnessBuiltinNodeType.Choice);
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const graph = new Graph([condition, whenTrue, whenFalse, choice, output], [
        new Edge({ nodeId: "condition", port: "value" }, { nodeId: "choice", port: "condition" }),
        new Edge({ nodeId: "true", port: "value" }, { nodeId: "choice", port: "whenTrue" }),
        new Edge({ nodeId: "false", port: "value" }, { nodeId: "choice", port: "whenFalse" }),
        new Edge({ nodeId: "choice", port: "value" }, { nodeId: "output", port: "text" }),
    ], { id: "choice-graph" });

    const result = await graph.run({
        host: { resolveProvider: () => undefined },
    }).done;

    assert.equal(result.status, "completed");
    const text = result.outputs.text;
    assert.equal(text?.type, "text");
    if (text?.type === "text") assert.equal(text.text, "yes");
    console.log("PASS ChoiceNode 按 boolean 条件选择 whenTrue");
}

console.log("\nAll harness toolset and choice checks passed.");
