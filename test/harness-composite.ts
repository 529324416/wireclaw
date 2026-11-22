import assert from "node:assert/strict";

import {
    Edge,
    Graph,
    GraphNode,
    HarnessBuiltinNodeType,
    createBuiltinNodeRegistry,
    describeNodeType,
} from "../src/harness";
import type {
    GraphEvent,
    InputPortSpec,
    NodeContext,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "../src/harness";

function section(title: string): void{
    console.log(`\n=== ${title} ===`);
}

class UpperAnyNode extends GraphNode{

    override readonly type = "test.upperAny";

    override get inputs(): readonly InputPortSpec[]{
        return [{ name: "value", type: "any", required: true }];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{ name: "out", type: "text" }];
    }

    override async execute(
        _ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const value = inputs.value;
        if (value?.type === "text"){
            return { out: { type: "text", text: value.text.toUpperCase() } };
        }
        if (value?.type === "json" && typeof value.value === "string"){
            return { out: { type: "text", text: value.value.toUpperCase() } };
        }
        throw new Error("expected text or json string");
    }
}

class IncrementNode extends GraphNode{

    override readonly type = "test.increment";

    override get inputs(): readonly InputPortSpec[]{
        return [{ name: "state", type: "any", required: true }];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{ name: "out", type: "json" }];
    }

    override async execute(
        _ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const state = inputs.state;
        if (state?.type !== "json" || typeof state.value !== "number"){
            throw new Error("expected numeric state");
        }

        const next = state.value + 1;
        return {
            out: {
                type: "json",
                value: {
                    state: next,
                    done: next >= 3,
                },
            },
        };
    }
}

function createRegistry() {
    const registry = createBuiltinNodeRegistry();
    registry.register({
        type: "test.upperAny",
        version: 1,
        create: (id, config, inputs, ui) => new UpperAnyNode(id, config, inputs, ui),
    });
    registry.register({
        type: "test.increment",
        version: 1,
        create: (id, config, inputs, ui) => new IncrementNode(id, config, inputs, ui),
    });
    return registry;
}

function createForEachInnerGraph(registry: ReturnType<typeof createRegistry>): Graph{
    const item = registry.createNode({
        id: "item",
        type: HarnessBuiltinNodeType.Value,
        typeVersion: 1,
        config: { name: "item" },
    });
    const upper = registry.createNode({
        id: "upper",
        type: "test.upperAny",
        typeVersion: 1,
    });
    const output = registry.createNode({
        id: "output",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });

    return new Graph([item, upper, output], [
        new Edge({ nodeId: "item", port: "value" }, { nodeId: "upper", port: "value" }),
        new Edge({ nodeId: "upper", port: "out" }, { nodeId: "output", port: "text" }),
    ], { id: "foreach-inner" });
}

function createLoopInnerGraph(registry: ReturnType<typeof createRegistry>): Graph{
    const state = registry.createNode({
        id: "state",
        type: HarnessBuiltinNodeType.Value,
        typeVersion: 1,
        config: { name: "state" },
    });
    const increment = registry.createNode({
        id: "increment",
        type: "test.increment",
        typeVersion: 1,
    });
    const output = registry.createNode({
        id: "output",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });

    return new Graph([state, increment, output], [
        new Edge({ nodeId: "state", port: "value" }, { nodeId: "increment", port: "state" }),
        new Edge({ nodeId: "increment", port: "out" }, { nodeId: "output", port: "json" }),
    ], { id: "loop-inner" });
}

section("ForEach 数组遍历");
{
    const registry = createRegistry();
    const innerDocument = createForEachInnerGraph(registry).toJSON();
    const items = registry.createNode({
        id: "items",
        type: HarnessBuiltinNodeType.Constant,
        typeVersion: 1,
        config: { value: { type: "json", value: ["a", "b", "c"] } },
    });
    const forEach = registry.createNode({
        id: "forEach",
        type: HarnessBuiltinNodeType.ForEach,
        typeVersion: 1,
        config: { graph: innerDocument, resultPort: "text" } as never,
    });
    const output = registry.createNode({
        id: "output",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });

    const graph = new Graph([items, forEach, output], [
        new Edge({ nodeId: "items", port: "value" }, { nodeId: "forEach", port: "items" }),
        new Edge({ nodeId: "forEach", port: "results" }, { nodeId: "output", port: "json" }),
    ], { id: "foreach-outer" });

    const events: GraphEvent[] = [];
    const result = await graph.run({
        host: { resolveProvider: () => undefined },
        listener: (event) => events.push(event),
    }).done;

    assert.equal(result.status, "completed");
    assert.equal(
        events.filter((event) => event.type === "custom"
            && event.name === "forEach.forEach.iteration").length,
        3,
    );
    const results = result.outputs.json;
    assert.equal(results?.type, "json");
    if (results?.type === "json"){
        assert.deepEqual(results.value, [
            { type: "text", text: "A" },
            { type: "text", text: "B" },
            { type: "text", text: "C" },
        ]);
    }
    console.log("PASS ForEach 逐项运行子图并按顺序收集结果");
}

section("Loop 有界循环");
{
    const registry = createRegistry();
    const innerDocument = createLoopInnerGraph(registry).toJSON();
    const initial = registry.createNode({
        id: "initial",
        type: HarnessBuiltinNodeType.Constant,
        typeVersion: 1,
        config: { value: { type: "json", value: 0 } },
    });
    const loop = registry.createNode({
        id: "loop",
        type: HarnessBuiltinNodeType.Loop,
        typeVersion: 1,
        config: { graph: innerDocument, maxIterations: 5 } as never,
    });
    const output = registry.createNode({
        id: "output",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });

    const graph = new Graph([initial, loop, output], [
        new Edge({ nodeId: "initial", port: "value" }, { nodeId: "loop", port: "initial" }),
        new Edge({ nodeId: "loop", port: "value" }, { nodeId: "output", port: "json" }),
    ], { id: "loop-outer" });

    const events: GraphEvent[] = [];
    const result = await graph.run({
        host: { resolveProvider: () => undefined },
        listener: (event) => events.push(event),
    }).done;

    assert.equal(result.status, "completed");
    assert.equal(
        events.filter((event) => event.type === "custom"
            && event.name === "loop.loop.iteration").length,
        3,
    );
    const value = result.outputs.json;
    assert.equal(value?.type, "json");
    if (value?.type === "json"){
        assert.equal(value.value, 3);
    }
    console.log("PASS Loop 通过内层 done 提前结束");
}

section("ForEach / Loop 序列化与编辑器目录");
{
    const registry = createRegistry();
    const innerDocument = createForEachInnerGraph(registry).toJSON();
    const items = registry.createNode({
        id: "items",
        type: HarnessBuiltinNodeType.Constant,
        typeVersion: 1,
        config: { value: { type: "json", value: [] } },
    });
    const forEach = registry.createNode({
        id: "forEach",
        type: HarnessBuiltinNodeType.ForEach,
        typeVersion: 1,
        config: { graph: innerDocument } as never,
    });
    const output = registry.createNode({
        id: "output",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });
    const graph = new Graph([items, forEach, output], [
        new Edge({ nodeId: "items", port: "value" }, { nodeId: "forEach", port: "items" }),
        new Edge({ nodeId: "forEach", port: "results" }, { nodeId: "output", port: "json" }),
    ], { id: "foreach-serialize" });

    const loaded = Graph.fromJSON(graph.toJSON(), { registry });
    assert.ok(loaded.getNode("forEach")?.config !== undefined);

    const forEachEntry = describeNodeType(registry, HarnessBuiltinNodeType.ForEach);
    assert.ok(forEachEntry.inputs.some((port) => port.name === "items"));
    assert.ok(forEachEntry.outputs.some((port) => port.name === "results"));

    const loopEntry = describeNodeType(registry, HarnessBuiltinNodeType.Loop);
    assert.ok(loopEntry.inputs.some((port) => port.name === "initial"));
    assert.ok(loopEntry.outputs.some((port) => port.name === "iterations"));
    console.log("PASS ForEach/Loop 随图序列化，编辑器目录可预览");
}

console.log("\nAll harness composite checks passed.");
