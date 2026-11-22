import assert from "node:assert/strict";

import {
    Edge,
    Graph,
    GraphNode,
    HarnessBuiltinNodeType,
    createBuiltinNodeRegistry,
} from "../src/harness";
import type {
    GraphEvent,
    InputPortSpec,
    NodeContext,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "../src/harness";
import type { ToolCall, ToolCallResult, ToolDefinition } from "../src/session/type";
import type { ToolProvider } from "../src/session/tool";
import { ToolRegistry } from "../src/session/tool";
import { assistant } from "../src/session/message";
import type { Message } from "../src/session/message";
import { AIProvider } from "../src/session/protocol";
import type {
    GenerationCapability,
    GenerationOptions,
    GenerationRequest,
    GenerationTask,
} from "../src/session/protocol";
import { ChatStopReason } from "../src/session/type";
import type {
    ChatOptions,
    ChatResult,
    ChatUsage,
    SessionRuntimeOptions,
} from "../src/session/type";
import type { GeneratedMedia } from "../src/session/media";
import { MemoryFileHost } from "../src/file/memory";
import { AttachmentFileManager } from "../src/session/attachment-manager";

function section(title: string): void{
    console.log(`\n=== ${title} ===`);
}

function usage(): ChatUsage{
    return { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
}

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class FakeGenerationProvider extends AIProvider implements GenerationCapability{

    get title(): string{
        return "generation";
    }

    async generate(
        request: GenerationRequest,
        _options?: GenerationOptions,
    ): Promise<GenerationTask>{
        assert.equal(request.modality, "image");
        const result: readonly GeneratedMedia[] = [{
            kind: "bytes",
            data: pngBytes,
            mimeType: "image/png",
        }];

        return {
            id: "task-1",
            status: "succeeded",
            result,
            cancel: async () =>{
                // no-op
            },
            wait: async () => result,
        };
    }
}

class EchoChatProvider extends AIProvider{

    get title(): string{
        return "echo";
    }

    override get supportsTools(): boolean{
        return false;
    }

    async chat(
        _messages: readonly Message[],
        _options: SessionRuntimeOptions,
        _turn?: ChatOptions,
    ): Promise<ChatResult>{
        return {
            message: assistant("reply", undefined, usage(), undefined, ChatStopReason.Stop),
        };
    }
}

class ToolChatProvider extends AIProvider{

    private _step = 0;

    get title(): string{
        return "tool";
    }

    override get supportsTools(): boolean{
        return true;
    }

    async chat(
        _messages: readonly Message[],
        _options: SessionRuntimeOptions,
        _turn?: ChatOptions,
    ): Promise<ChatResult>{
        if (this._step === 0){
            this._step += 1;
            return {
                message: assistant("", undefined, usage(), [{
                    id: "call-echo",
                    name: "tools__echo",
                    params: { text: "hello" },
                }], ChatStopReason.ToolCall),
            };
        }

        this._step += 1;
        return {
            message: assistant("final", undefined, usage(), undefined, ChatStopReason.Stop),
        };
    }
}

class EchoToolProvider implements ToolProvider{

    readonly id = "tools";
    readonly name = "tools";
    readonly description = "test tools";

    calls = 0;

    async fetchTools(): Promise<ToolDefinition[]>{
        return [{
            name: "echo",
            description: "echo text",
            inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
            },
            annotations: { readOnlyHint: true, requiresApproval: true },
        }];
    }

    async call(call: ToolCall): Promise<ToolCallResult>{
        this.calls += 1;
        return {
            content: `echo:${String(call.params.text)}`,
            status: { isSuccess: true, duration: 0 },
        };
    }
}

class DelayNode extends GraphNode{

    static active = 0;
    static maxActive = 0;

    override readonly type = "test.delay";

    override get inputs(): readonly InputPortSpec[]{
        return [{ name: "in", type: "text", required: true }];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{ name: "out", type: "text" }];
    }

    override async execute(
        _ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        DelayNode.active += 1;
        DelayNode.maxActive = Math.max(DelayNode.maxActive, DelayNode.active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        DelayNode.active -= 1;

        const value = inputs.in;
        if (value === undefined || value.type !== "text"){
            throw new Error("expected text");
        }
        const suffix = typeof this.config === "object" && this.config !== null
            && !Array.isArray(this.config)
            ? String(this.config.suffix ?? "")
            : "";
        return { out: { type: "text", text: value.text + suffix } };
    }
}

class JoinNode extends GraphNode{

    override readonly type = "test.join";

    override get inputs(): readonly InputPortSpec[]{
        return [
            { name: "left", type: "text", required: true },
            { name: "right", type: "text", required: true },
        ];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{ name: "out", type: "text" }];
    }

    override async execute(
        _ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const left = inputs.left;
        const right = inputs.right;
        if (left?.type !== "text" || right?.type !== "text"){
            throw new Error("expected text inputs");
        }
        return { out: { type: "text", text: left.text + right.text } };
    }
}

class FailNode extends GraphNode{

    override readonly type = "test.fail";

    override get inputs(): readonly InputPortSpec[]{
        return [];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{ name: "out", type: "text" }];
    }

    override async execute(): Promise<NodeOutputValues>{
        throw new Error("boom");
    }
}

class HangNode extends GraphNode{

    override readonly type = "test.hang";

    override get inputs(): readonly InputPortSpec[]{
        return [];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{ name: "out", type: "text" }];
    }

    override async execute(ctx: NodeContext): Promise<NodeOutputValues>{
        if (ctx.signal.aborted) throw new Error("aborted");
        await new Promise<void>((_resolve, reject) =>{
            ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
            });
        });
        return { out: { type: "text", text: "never" } };
    }
}

function createRegistry() {
    const registry = createBuiltinNodeRegistry();
    registry.register({
        type: "test.delay",
        version: 1,
        create: (id, config, inputs, ui) => new DelayNode(id, config, inputs, ui),
    });
    registry.register({
        type: "test.join",
        version: 1,
        create: (id, config, inputs, ui) => new JoinNode(id, config, inputs, ui),
    });
    registry.register({
        type: "test.fail",
        version: 1,
        create: (id, config, inputs, ui) => new FailNode(id, config, inputs, ui),
    });
    registry.register({
        type: "test.hang",
        version: 1,
        create: (id, config, inputs, ui) => new HangNode(id, config, inputs, ui),
    });
    return registry;
}

function node(
    registry: ReturnType<typeof createRegistry>,
    id: string,
    type: string,
    config?: unknown,
){
    return registry.createNode({
        id,
        type,
        typeVersion: 1,
        config: config as never,
    });
}

section("A 类节点端到端");
{
    const registry = createRegistry();
    const input = node(registry, "input", HarnessBuiltinNodeType.Input);
    const model = node(registry, "model", HarnessBuiltinNodeType.Model, {
        providerId: "fake",
        modelId: "echo-model",
    });
    const call = node(registry, "call", HarnessBuiltinNodeType.ModelCall, {
        mode: "chat",
        system: "be brief",
    });
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const graph = new Graph([input, model, call, output], [
        new Edge({ nodeId: "input", port: "text" }, { nodeId: "call", port: "prompt" }),
        new Edge({ nodeId: "model", port: "model" }, { nodeId: "call", port: "model" }),
        new Edge({ nodeId: "call", port: "text" }, { nodeId: "output", port: "text" }),
    ], { id: "a-graph" });

    const events: GraphEvent[] = [];
    const run = graph.run({
        host: { resolveProvider: () => new EchoChatProvider() },
        input: { text: "hello" },
        listener: (event) => events.push(event),
    });
    const result = await run.done;

    assert.equal(result.status, "completed");
    const text = result.outputs.text;
    assert.equal(text?.type, "text");
    if (text?.type === "text") assert.equal(text.text, "reply");
    assert.ok(events.some((event) => event.type === "node:end" && event.nodeId === "call"));
    assert.ok(events.some((event) => event.type === "run:end" && event.status === "completed"));
    console.log("PASS input -> model -> A -> output，生命周期事件完整");
}

section("A 类生图节点");
{
    const registry = createRegistry();
    const manager = new AttachmentFileManager(new MemoryFileHost());
    const provider = new FakeGenerationProvider();

    const input = node(registry, "input", HarnessBuiltinNodeType.Input);
    const model = node(registry, "model", HarnessBuiltinNodeType.Model, {
        providerId: "fake",
        modelId: "generation-model",
    });
    const call = node(registry, "call", HarnessBuiltinNodeType.ModelCall, {
        mode: "generate",
        modality: "image",
        parameters: { size: "1024x1024" },
    });
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const graph = new Graph([input, model, call, output], [
        new Edge({ nodeId: "input", port: "text" }, { nodeId: "call", port: "prompt" }),
        new Edge({ nodeId: "model", port: "model" }, { nodeId: "call", port: "model" }),
        new Edge({ nodeId: "call", port: "attachments" }, { nodeId: "output", port: "attachments" }),
    ], { id: "generate-graph" });

    const result = await graph.run({
        host: {
            resolveProvider: () => provider,
            attachments: manager,
        },
        input: { text: "draw a cat" },
    }).done;

    assert.equal(result.status, "completed");
    const attachments = result.outputs.attachments;
    assert.equal(attachments?.type, "attachments");
    if (attachments?.type === "attachments"){
        assert.equal(attachments.attachments.length, 1);
    }
    assert.equal((await manager.stats()).count, 1);
    console.log("PASS A 类 generate 模式落盘媒体并输出 AttachmentRef");
}

section("双线路异步汇流");
{
    const registry = createRegistry();
    const input = node(registry, "input", HarnessBuiltinNodeType.Input);
    const left = node(registry, "left", "test.delay", { suffix: "L" });
    const right = node(registry, "right", "test.delay", { suffix: "R" });
    const join = node(registry, "join", "test.join");
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const graph = new Graph([input, left, right, join, output], [
        new Edge({ nodeId: "input", port: "text" }, { nodeId: "left", port: "in" }),
        new Edge({ nodeId: "input", port: "text" }, { nodeId: "right", port: "in" }),
        new Edge({ nodeId: "left", port: "out" }, { nodeId: "join", port: "left" }),
        new Edge({ nodeId: "right", port: "out" }, { nodeId: "join", port: "right" }),
        new Edge({ nodeId: "join", port: "out" }, { nodeId: "output", port: "text" }),
    ], { id: "join-graph" });

    DelayNode.active = 0;
    DelayNode.maxActive = 0;
    const result = await graph.run({
        host: { resolveProvider: () => undefined },
        input: { text: "x" },
    }).done;

    assert.equal(result.status, "completed");
    const text = result.outputs.text;
    assert.equal(text?.type, "text");
    if (text?.type === "text") assert.equal(text.text, "xLxR");
    assert.ok(DelayNode.maxActive >= 2, "两条线路应并行执行");
    console.log("PASS 两条分支并行，汇流节点等待全部输入");
}

section("B 类节点工具调用");
{
    const registry = createRegistry();
    const provider = new ToolChatProvider();
    const tools = new ToolRegistry();
    const echo = new EchoToolProvider();
    tools.registerProvider(echo);

    const input = node(registry, "input", HarnessBuiltinNodeType.Input);
    const model = node(registry, "model", HarnessBuiltinNodeType.Model, {
        providerId: "fake",
        modelId: "tool-model",
    });
    const agent = node(registry, "agent", HarnessBuiltinNodeType.AgentRun, {
        permission: "full",
        maxSteps: 3,
    });
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const graph = new Graph([input, model, agent, output], [
        new Edge({ nodeId: "input", port: "text" }, { nodeId: "agent", port: "input" }),
        new Edge({ nodeId: "model", port: "model" }, { nodeId: "agent", port: "model" }),
        new Edge({ nodeId: "agent", port: "text" }, { nodeId: "output", port: "text" }),
    ], { id: "b-graph" });

    const result = await graph.run({
        host: {
            resolveProvider: (id) => id === "fake" ? provider : undefined,
            tools,
        },
        input: { text: "use a tool" },
    }).done;

    assert.equal(result.status, "completed");
    assert.equal(echo.calls, 1);
    const text = result.outputs.text;
    assert.equal(text?.type, "text");
    if (text?.type === "text") assert.equal(text.text, "final");
    console.log("PASS B 节点通过 Session 执行工具调用并回收最终文本");
}

section("B 类节点审批桥接");
{
    const registry = createRegistry();
    const provider = new ToolChatProvider();
    const tools = new ToolRegistry();
    const echo = new EchoToolProvider();
    tools.registerProvider(echo);

    const input = node(registry, "input", HarnessBuiltinNodeType.Input);
    const model = node(registry, "model", HarnessBuiltinNodeType.Model, {
        providerId: "fake",
        modelId: "tool-model",
    });
    const agent = node(registry, "agent", HarnessBuiltinNodeType.AgentRun, {
        permission: "approval",
        maxSteps: 3,
    });
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const graph = new Graph([input, model, agent, output], [
        new Edge({ nodeId: "input", port: "text" }, { nodeId: "agent", port: "input" }),
        new Edge({ nodeId: "model", port: "model" }, { nodeId: "agent", port: "model" }),
        new Edge({ nodeId: "agent", port: "text" }, { nodeId: "output", port: "text" }),
    ], { id: "approval-graph" });

    let approvals = 0;
    const result = await graph.run({
        host: {
            resolveProvider: (id) => id === "fake" ? provider : undefined,
            tools,
            onToolApproval: (request, nodeId) =>{
                approvals += 1;
                assert.equal(nodeId, "agent");
                assert.equal(request.call.name, "tools__echo");
                return "approve";
            },
        },
        input: { text: "use a tool" },
    }).done;

    assert.equal(result.status, "completed");
    assert.equal(approvals, 1);
    assert.equal(echo.calls, 1);
    console.log("PASS B 节点审批事件转发到宿主回调并恢复运行");
}

section("失败与取消");
{
    const registry = createRegistry();
    const fail = node(registry, "fail", "test.fail");
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);
    const failedGraph = new Graph([fail, output], [
        new Edge({ nodeId: "fail", port: "out" }, { nodeId: "output", port: "text" }),
    ], { id: "fail-graph" });

    const failed = await failedGraph.run({
        host: { resolveProvider: () => undefined },
    }).done;
    assert.equal(failed.status, "failed");
    assert.ok(failed.records.some((record) =>
        record.nodeId === "fail" && record.status === "failed"));
    console.log("PASS 节点失败终止 Graph 并记录失败节点");
}

{
    const registry = createRegistry();
    const hang = node(registry, "hang", "test.hang");
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);
    const graph = new Graph([hang, output], [
        new Edge({ nodeId: "hang", port: "out" }, { nodeId: "output", port: "text" }),
    ], { id: "cancel-graph" });

    const run = graph.run({ host: { resolveProvider: () => undefined } });
    setTimeout(() => run.cancel(), 5);
    const result = await run.done;

    assert.equal(result.status, "cancelled");
    assert.ok(result.records.some((record) =>
        record.nodeId === "hang" && record.status === "cancelled"));
    console.log("PASS 取消会中止活跃节点并标记 cancelled");
}

console.log("\nAll harness runtime checks passed.");
