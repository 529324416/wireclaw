import assert from "node:assert/strict";

import {
    Edge,
    Graph,
    GraphNode,
    HarnessError,
    HarnessErrorCode,
    NodeTypeRegistry,
} from "../src/harness";
import type {
    InputPortSpec,
    NodeContext,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "../src/harness";

function section(title: string): void{
    console.log(`\n=== ${title} ===`);
}

class TextSourceNode extends GraphNode{

    override readonly type = "test.source";

    override get inputs(): readonly InputPortSpec[]{
        return [];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{
            name: "out",
            type: "text",
            supportedModes: ["value", "stream"],
            defaultMode: "value",
        }];
    }

    override async execute(
        _ctx: NodeContext,
        _inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        return { out: { type: "text", text: "source" } };
    }
}

class PassNode extends GraphNode{

    override readonly type = "test.pass";

    override get inputs(): readonly InputPortSpec[]{
        return [{ name: "in", type: "text", required: true }];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{
            name: "out",
            type: "text",
            supportedModes: ["value", "stream"],
            defaultMode: "value",
        }];
    }

    override async execute(
        _ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        return { out: inputs.in };
    }
}

class ModelSinkNode extends GraphNode{

    override readonly type = "test.modelSink";

    override get inputs(): readonly InputPortSpec[]{
        return [{ name: "model", type: "model", required: true }];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [];
    }

    override async execute(
        _ctx: NodeContext,
        _inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        return {};
    }
}

class FanInNode extends GraphNode{

    override readonly type = "test.fanIn";

    override get inputs(): readonly InputPortSpec[]{
        return [{ name: "items", type: "text", required: true, multiple: true }];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [];
    }

    override async execute(
        _ctx: NodeContext,
        _inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        return {};
    }
}

function createRegistry(): NodeTypeRegistry{
    const registry = new NodeTypeRegistry();
    registry.register({
        type: "test.source",
        version: 1,
        title: "Source",
        builtIn: false,
        create: (id, config, inputs, ui) => new TextSourceNode(id, config, inputs, ui),
    });
    registry.register({
        type: "test.pass",
        version: 1,
        title: "Pass",
        builtIn: false,
        create: (id, config, inputs, ui) => new PassNode(id, config, inputs, ui),
    });
    registry.register({
        type: "test.modelSink",
        version: 1,
        title: "Model sink",
        builtIn: false,
        create: (id, config, inputs, ui) => new ModelSinkNode(id, config, inputs, ui),
    });
    registry.register({
        type: "test.fanIn",
        version: 1,
        title: "Fan-in",
        builtIn: false,
        create: (id, config, inputs, ui) => new FanInNode(id, config, inputs, ui),
    });
    return registry;
}

function buildGraph(): Graph{
    const source = new TextSourceNode("source", undefined, undefined, { x: 1, y: 2 });
    const pass = new PassNode("pass", { prompt: "hello" }, undefined, { x: 3, y: 4 });

    return new Graph(
        [source, pass],
        [new Edge(
            { nodeId: "source", port: "out" },
            { nodeId: "pass", port: "in" },
        )],
        {
            id: "graph-1",
            title: "Demo",
            description: "graph round trip",
            metadata: { owner: "test" },
            ui: { zoom: 1 },
            parameters: [{ name: "topic", type: "string", required: true }],
            events: [{ name: "thinking.log", payload: "text" }],
        },
    );
}

function issuesOf(graph: Graph): readonly string[]{
    return graph.validate().map((issue) => issue.code);
}

function expectHarnessError(
    operation: () => unknown,
    code: HarnessErrorCode,
): void{
    assert.throws(operation, (error: unknown) =>
        error instanceof HarnessError && error.code === code);
}

section("序列化往返");
{
    const graph = buildGraph();
    graph.assertValid();

    const document = graph.toJSON();
    const registry = createRegistry();
    const loaded = Graph.fromJSON(document, { registry });

    assert.equal(loaded.id, graph.id);
    assert.equal(loaded.title, graph.title);
    assert.equal(loaded.description, graph.description);
    assert.equal(loaded.nodes.length, 2);
    assert.equal(loaded.edges.length, 1);
    assert.deepEqual(loaded.toJSON(), document);
    assert.deepEqual(loaded.getNode("pass")?.config, { prompt: "hello" });
    assert.deepEqual(loaded.getNode("pass")?.ui, { x: 3, y: 4 });
    console.log("PASS Graph -> JSON -> Graph，节点 config/inputs/ui、参数与事件声明保持");
}

section("输入默认值与校验");
{
    const pass = new PassNode("pass", undefined, {
        in: { type: "text", text: "default" },
    }, { x: 0, y: 0 });
    const graph = new Graph([pass], [], { id: "default-input" });
    graph.assertValid();

    const document = graph.toJSON();
    const loaded = Graph.fromJSON(document, { registry: createRegistry() });
    assert.deepEqual(loaded.getNode("pass")?.inputDefaults, {
        in: { type: "text", text: "default" },
    });

    const missing = new Graph([new PassNode("lonely")], [], { id: "missing" });
    assert.ok(issuesOf(missing).includes(HarnessErrorCode.MissingInput));

    const badDefault = new PassNode("bad", undefined, {
        in: { type: "json", value: 1 },
    });
    const bad = new Graph([badDefault], [], { id: "bad-default" });
    assert.ok(issuesOf(bad).includes(HarnessErrorCode.PortTypeMismatch));
    console.log("PASS 输入默认值可序列化，缺失必填输入与类型错误可定位");
}

section("边、端口和环");
{
    const source = new TextSourceNode("source");
    const sink = new ModelSinkNode("sink");
    const mismatch = new Graph([source, sink], [
        new Edge({ nodeId: "source", port: "out" }, { nodeId: "sink", port: "model" }),
    ], { id: "mismatch" });
    assert.ok(issuesOf(mismatch).includes(HarnessErrorCode.PortTypeMismatch));

    const pass = new PassNode("pass");
    const unknownPort = new Graph([source, pass], [
        new Edge({ nodeId: "source", port: "out" }, { nodeId: "pass", port: "nope" }),
    ], { id: "unknown-port" });
    assert.ok(issuesOf(unknownPort).includes(HarnessErrorCode.UnknownPort));

    const a = new PassNode("a");
    const b = new PassNode("b");
    const cycle = new Graph([a, b], [
        new Edge({ nodeId: "a", port: "out" }, { nodeId: "b", port: "in" }),
        new Edge({ nodeId: "b", port: "out" }, { nodeId: "a", port: "in" }),
    ], { id: "cycle" });
    assert.ok(issuesOf(cycle).includes(HarnessErrorCode.CycleDetected));

    const duplicateEdge = new Graph([source, pass], [
        new Edge({ nodeId: "source", port: "out" }, { nodeId: "pass", port: "in" }),
        new Edge({ nodeId: "source", port: "out" }, { nodeId: "pass", port: "in" }),
    ], { id: "duplicate-edge" });
    assert.ok(issuesOf(duplicateEdge).includes(HarnessErrorCode.DuplicateEdge));
    assert.ok(issuesOf(duplicateEdge).includes(HarnessErrorCode.MultipleInputEdges));
    console.log("PASS 类型不兼容、未知端口、环、重复边均被识别");
}

section("扇入与重复节点");
{
    const s1 = new TextSourceNode("s1");
    const s2 = new TextSourceNode("s2");
    const fanIn = new FanInNode("fan-in");
    const allowed = new Graph([s1, s2, fanIn], [
        new Edge({ nodeId: "s1", port: "out" }, { nodeId: "fan-in", port: "items" }),
        new Edge({ nodeId: "s2", port: "out" }, { nodeId: "fan-in", port: "items" }),
    ], { id: "fan-in" });
    assert.ok(!issuesOf(allowed).includes(HarnessErrorCode.MultipleInputEdges));

    const pass = new PassNode("pass");
    const duplicateInput = new Graph([s1, s2, pass], [
        new Edge({ nodeId: "s1", port: "out" }, { nodeId: "pass", port: "in" }),
        new Edge({ nodeId: "s2", port: "out" }, { nodeId: "pass", port: "in" }),
    ], { id: "single-input" });
    assert.ok(issuesOf(duplicateInput).includes(HarnessErrorCode.MultipleInputEdges));

    const duplicateNode = new Graph([
        new TextSourceNode("same"),
        new TextSourceNode("same"),
    ], [], { id: "duplicate-node" });
    assert.ok(issuesOf(duplicateNode).includes(HarnessErrorCode.DuplicateNodeId));
    console.log("PASS multiple 端口允许扇入，单输入端口拒绝重复连边，重复节点 ID 被识别");
}

section("反序列化与注册表");
{
    const registry = createRegistry();
    const document = buildGraph().toJSON();

    expectHarnessError(
        () => Graph.fromJSON({ ...document, version: 99 }, { registry }),
        HarnessErrorCode.UnsupportedDocumentVersion,
    );

    const unknown = buildGraph().toJSON();
    unknown.nodes[0].type = "test.unknown";
    expectHarnessError(
        () => Graph.fromJSON(unknown, { registry }),
        HarnessErrorCode.UnknownNodeType,
    );

    const badVersion = buildGraph().toJSON();
    badVersion.nodes[0].typeVersion = 2;
    expectHarnessError(
        () => Graph.fromJSON(badVersion, { registry }),
        HarnessErrorCode.UnsupportedNodeTypeVersion,
    );

    const draft = new Graph([new PassNode("draft")], [], { id: "draft" }).toJSON();
    const loadedDraft = Graph.fromJSON(draft, { registry, validate: false });
    assert.equal(loadedDraft.nodes.length, 1);
    expectHarnessError(
        () => Graph.fromJSON(draft, { registry }),
        HarnessErrorCode.InvalidGraph,
    );

    expectHarnessError(
        () => createRegistry().register({
            type: "test.pass",
            version: 1,
            create: (id) => new PassNode(id),
        }),
        HarnessErrorCode.NodeTypeConflict,
    );
    console.log("PASS 文档版本、未知节点、类型版本、草稿模式与重复注册均被覆盖");
}

console.log("\nAll harness graph checks passed.");
