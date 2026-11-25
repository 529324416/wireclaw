import assert from "node:assert/strict";

import {
    Edge,
    Graph,
    GraphNode,
    HarnessBuiltinNodeType,
    createBuiltinNodeRegistry,
    createRunResult,
    collectRunResultAttachmentHashes,
    RunResultSerializer,
} from "../src/harness";
import type {
    InputPortSpec,
    NodeContext,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "../src/harness";
import { assistant } from "../src/session/message";
import type { Message } from "../src/session/message";
import { AIProvider } from "../src/session/protocol";
import type {
    ChatOptions,
    ChatResult,
    ChatUsage,
    SessionRuntimeOptions,
} from "../src/session/type";
import { ChatStopReason } from "../src/session/type";
import type {
    GenerationCapability,
    GenerationOptions,
    GenerationRequest,
    GenerationTask,
} from "../src/session/protocol";
import type { GeneratedMedia } from "../src/session/media";
import { MemoryFileHost } from "../src/file/memory";
import { AttachmentFileManager } from "../src/session/attachment-manager";

function section(title: string): void{
    console.log(`\n=== ${title} ===`);
}

function usage(): ChatUsage{
    return { promptTokens: 2, completionTokens: 3, totalTokens: 5 };
}

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
            message: assistant(
                "reply text",
                "thinking text",
                usage(),
                undefined,
                ChatStopReason.Stop,
            ),
        };
    }
}

class FailingChatProvider extends AIProvider{

    get title(): string{
        return "failing";
    }

    override get supportsTools(): boolean{
        return false;
    }

    async chat(
        _messages: readonly Message[],
        _options: SessionRuntimeOptions,
        _turn?: ChatOptions,
    ): Promise<ChatResult>{
        throw new Error("provider down");
    }
}

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

class CollectProbeNode extends GraphNode{

    override readonly type = "test.collectProbe";

    override get inputs(): readonly InputPortSpec[]{
        return [];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{ name: "out", type: "text" }];
    }

    override async execute(
        ctx: NodeContext,
        _inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        ctx.collect({
            kind: "model-call",
            providerId: "probe",
            modelId: "probe",
            mode: "chat",
            status: "completed",
            startedAt: 1,
            endedAt: 2,
            input: { prompt: "probe" },
            output: { text: "probe" },
        });
        return { out: { type: "text", text: `path=${ctx.graphPath.join("/")}` } };
    }
}

const registry = createBuiltinNodeRegistry();
registry.register({
    type: "test.collectProbe",
    version: 1,
    create: (id, config, inputs, ui) => new CollectProbeNode(id, config, inputs, ui),
});

function node(id: string, type: string, config?: unknown){
    return registry.createNode({
        id,
        type,
        typeVersion: 1,
        config: config as never,
    });
}

function createModelCallGraph(): Graph{
    const input = node("input", HarnessBuiltinNodeType.Input);
    const model = node("model", HarnessBuiltinNodeType.Model, {
        providerId: "fake",
        modelId: "echo-model",
    });
    const call = node("call", HarnessBuiltinNodeType.ModelCall, {
        mode: "chat",
        system: "be brief",
    });
    const output = node("output", HarnessBuiltinNodeType.Output);

    return new Graph([input, model, call, output], [
        new Edge({ nodeId: "input", port: "text" }, { nodeId: "call", port: "prompt" }),
        new Edge({ nodeId: "model", port: "model" }, { nodeId: "call", port: "model" }),
        new Edge({ nodeId: "call", port: "text" }, { nodeId: "output", port: "text" }),
    ], { id: "a-graph" });
}

section("ModelCall 采集 model-call entry");
{
    const graph = createModelCallGraph();
    const result = await graph.run({
        host: { resolveProvider: () => new EchoChatProvider() },
        input: { text: "hello" },
    }).done;

    assert.equal(result.status, "completed");
    assert.equal(result.graphId, "a-graph");
    assert.equal(result.entries.length, 1);

    const entry = result.entries[0];
    assert.equal(entry.kind, "model-call");
    if (entry.kind === "model-call"){
        assert.equal(entry.nodeId, "call");
        assert.equal(entry.nodeType, HarnessBuiltinNodeType.ModelCall);
        assert.equal(entry.providerId, "fake");
        assert.equal(entry.modelId, "echo-model");
        assert.equal(entry.mode, "chat");
        assert.equal(entry.status, "completed");
        assert.equal(entry.graphPath, undefined);
        assert.equal(entry.input.prompt, "hello");
        assert.equal(entry.input.system, "be brief");
        assert.equal(entry.output?.text, "reply text");
        assert.equal(entry.output?.thinking, "thinking text");
        assert.equal(entry.output?.stopReason, ChatStopReason.Stop);
        assert.equal(entry.output?.usage?.totalTokens, 5);
    }

    const runResult = createRunResult(result, { text: "hello" });
    assert.equal(runResult.version, 1);
    assert.equal(runResult.runId, result.runId);
    assert.equal(runResult.graphId, "a-graph");
    assert.equal(runResult.entries.length, 1);

    const serialized = RunResultSerializer.serialize(runResult);
    assert.deepEqual(serialized, runResult);

    const deserialized = RunResultSerializer.deserialize(
        JSON.parse(JSON.stringify(serialized)),
    );
    assert.deepEqual(deserialized, serialized);
    assert.equal(RunResultSerializer.isRunResult(serialized), true);
    assert.equal(RunResultSerializer.isRunResult({ version: 2 }), false);

    console.log("PASS model-call entry + RunResult 序列化往返");
}

section("ModelCall 失败时采集 failed entry");
{
    const graph = createModelCallGraph();
    const result = await graph.run({
        host: { resolveProvider: () => new FailingChatProvider() },
        input: { text: "hello" },
    }).done;

    assert.equal(result.status, "failed");
    assert.equal(result.entries.length, 1);

    const entry = result.entries[0];
    assert.equal(entry.kind, "model-call");
    if (entry.kind === "model-call"){
        assert.equal(entry.status, "failed");
        assert.ok(entry.error?.includes("provider down"));
        assert.equal(entry.output, undefined);
    }

    const runResult = createRunResult(result, { text: "hello" });
    assert.ok(runResult.error?.includes("provider down"));
    console.log("PASS 模型调用失败仍留下 failed entry");
}

section("Subgraph 的 entries 带 graphPath 冒泡");
{
    const innerInput = node("innerInput", HarnessBuiltinNodeType.Input);
    const innerModel = node("innerModel", HarnessBuiltinNodeType.Model, {
        providerId: "fake",
        modelId: "echo-model",
    });
    const innerCall = node("innerCall", HarnessBuiltinNodeType.ModelCall, {
        mode: "chat",
    });
    const innerOutput = node("innerOutput", HarnessBuiltinNodeType.Output);
    const inner = new Graph([innerInput, innerModel, innerCall, innerOutput], [
        new Edge({ nodeId: "innerInput", port: "text" }, { nodeId: "innerCall", port: "prompt" }),
        new Edge({ nodeId: "innerModel", port: "model" }, { nodeId: "innerCall", port: "model" }),
        new Edge({ nodeId: "innerCall", port: "text" }, { nodeId: "innerOutput", port: "text" }),
    ], { id: "inner-graph" });

    const input = node("input", HarnessBuiltinNodeType.Input);
    const subgraph = node("sg", HarnessBuiltinNodeType.Subgraph, {
        graph: inner.toJSON(),
    });
    const output = node("output", HarnessBuiltinNodeType.Output);
    const outer = new Graph([input, subgraph, output], [
        new Edge({ nodeId: "input", port: "text" }, { nodeId: "sg", port: "input" }),
        new Edge({ nodeId: "sg", port: "text" }, { nodeId: "output", port: "text" }),
    ], { id: "outer-graph" });

    const result = await outer.run({
        host: { resolveProvider: () => new EchoChatProvider() },
        input: { text: "nested" },
    }).done;

    assert.equal(result.status, "completed");
    assert.equal(result.entries.length, 1);
    const entry = result.entries[0];
    assert.equal(entry.kind, "model-call");
    if (entry.kind === "model-call"){
        assert.deepEqual(entry.graphPath, ["subgraph.sg"]);
        assert.equal(entry.input.prompt, "nested");
    }
    console.log("PASS 嵌套 entry 携带 graphPath");
}

section("嵌套图内自定义节点采集 path");
{
    const innerProbe = node("probe", "test.collectProbe");
    const innerOutput = node("innerOutput", HarnessBuiltinNodeType.Output);
    const inner = new Graph([innerProbe, innerOutput], [
        new Edge({ nodeId: "probe", port: "out" }, { nodeId: "innerOutput", port: "text" }),
    ], { id: "probe-inner" });

    const input = node("input", HarnessBuiltinNodeType.Input);
    const subgraph = node("sg", HarnessBuiltinNodeType.Subgraph, {
        graph: inner.toJSON(),
    });
    const output = node("output", HarnessBuiltinNodeType.Output);
    const outer = new Graph([input, subgraph, output], [
        new Edge({ nodeId: "input", port: "text" }, { nodeId: "sg", port: "input" }),
        new Edge({ nodeId: "sg", port: "text" }, { nodeId: "output", port: "text" }),
    ], { id: "probe-outer" });

    const result = await outer.run({
        host: { resolveProvider: () => undefined },
        input: { text: "x" },
    }).done;

    assert.equal(
        result.status,
        "completed",
        result.error instanceof Error ? result.error.message : String(result.error),
    );
    assert.equal(result.entries.length, 1);
    assert.deepEqual(result.entries[0]?.graphPath, ["subgraph.sg"]);
    console.log("PASS 自定义节点在嵌套图中的 graphPath");
}

section("RunResult 附件指纹汇总");
{
    const manager = new AttachmentFileManager(new MemoryFileHost());

    const input = node("input", HarnessBuiltinNodeType.Input);
    const model = node("model", HarnessBuiltinNodeType.Model, {
        providerId: "fake",
        modelId: "generation-model",
    });
    const call = node("call", HarnessBuiltinNodeType.ModelCall, {
        mode: "generate",
        modality: "image",
    });
    const output = node("output", HarnessBuiltinNodeType.Output);
    const graph = new Graph([input, model, call, output], [
        new Edge({ nodeId: "input", port: "text" }, { nodeId: "call", port: "prompt" }),
        new Edge({ nodeId: "model", port: "model" }, { nodeId: "call", port: "model" }),
        new Edge({ nodeId: "call", port: "attachments" }, { nodeId: "output", port: "attachments" }),
    ], { id: "generate-graph" });

    const result = await graph.run({
        host: {
            resolveProvider: () => new FakeGenerationProvider(),
            attachments: manager,
        },
        input: { text: "draw a cat" },
    }).done;

    assert.equal(result.status, "completed");
    const runResult = createRunResult(result, { text: "draw a cat" });
    const entry = runResult.entries[0];
    assert.equal(entry?.kind, "model-call");
    const hashes = collectRunResultAttachmentHashes(runResult);
    assert.equal(hashes.length, 1);
    if (entry?.kind === "model-call"){
        assert.deepEqual(hashes, [entry.output?.attachments?.[0]?.contentHash]);
    }
    console.log("PASS RunResult 派生附件指纹");
}

section("RunResult 拒绝非法结构");
{
    const graph = createModelCallGraph();
    const result = await graph.run({
        host: { resolveProvider: () => new EchoChatProvider() },
        input: { text: "hello" },
    }).done;
    const runResult = createRunResult(result, { text: "hello" });

    assert.throws(() =>
        RunResultSerializer.deserialize({ ...runResult, version: 2 }));
    assert.throws(() =>
        RunResultSerializer.deserialize({ ...runResult, entries: [{ kind: "model-call" }] }));
    assert.throws(() =>
        RunResultSerializer.deserialize({
            ...runResult,
            entries: [{
                ...runResult.entries[0],
                kind: "session",
                session: { id: "", messages: "nope", isArchived: false },
            }],
        }));
    console.log("PASS 非法 RunResult 被拒绝");
}
