import {
    Edge,
    Graph,
    GraphNode,
    HarnessBuiltinNodeType,
    createBuiltinNodeRegistry,
} from "../../src/harness";
import type {
    GraphCheckpoint,
    GraphRunResult,
    InputPortSpec,
    NodeContext,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "../../src/harness";

class UpperNode extends GraphNode{

    override readonly type = "example.compositeUpper";

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

    override readonly type = "example.compositeIncrement";

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

class DelayNode extends GraphNode{

    override readonly type = "example.compositeDelay";

    override get inputs(): readonly InputPortSpec[]{
        return [{ name: "in", type: "text", required: true }];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{ name: "out", type: "text" }];
    }

    override async execute(
        ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (ctx.signal.aborted) throw new Error("aborted");

        const value = inputs.in;
        if (value?.type !== "text") throw new Error("expected text");
        return { out: { type: "text", text: `${value.text}!` } };
    }
}

function createRegistry() {
    const registry = createBuiltinNodeRegistry();
    registry.register({
        type: "example.compositeUpper",
        version: 1,
        create: (id, config, inputs, ui) => new UpperNode(id, config, inputs, ui),
    });
    registry.register({
        type: "example.compositeIncrement",
        version: 1,
        create: (id, config, inputs, ui) => new IncrementNode(id, config, inputs, ui),
    });
    registry.register({
        type: "example.compositeDelay",
        version: 1,
        create: (id, config, inputs, ui) => new DelayNode(id, config, inputs, ui),
    });
    return registry;
}

function createUpperInnerGraph(registry: ReturnType<typeof createRegistry>): Graph{
    const input = registry.createNode({
        id: "innerInput",
        type: HarnessBuiltinNodeType.Input,
        typeVersion: 1,
    });
    const upper = registry.createNode({
        id: "innerUpper",
        type: "example.compositeUpper",
        typeVersion: 1,
    });
    const output = registry.createNode({
        id: "innerOutput",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });

    return new Graph([input, upper, output], [
        new Edge({ nodeId: "innerInput", port: "text" }, { nodeId: "innerUpper", port: "value" }),
        new Edge({ nodeId: "innerUpper", port: "out" }, { nodeId: "innerOutput", port: "text" }),
    ], { id: "composite-upper-inner" });
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
        type: "example.compositeUpper",
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
    ], { id: "composite-foreach-inner" });
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
        type: "example.compositeIncrement",
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
    ], { id: "composite-loop-inner" });
}

function createSubgraphShowcase(): Graph{
    const registry = createRegistry();
    const innerDocument = createUpperInnerGraph(registry).toJSON();

    const input = registry.createNode({
        id: "input",
        type: HarnessBuiltinNodeType.Input,
        typeVersion: 1,
    });
    const subgraph = registry.createNode({
        id: "subgraph",
        type: HarnessBuiltinNodeType.Subgraph,
        typeVersion: 1,
        config: { graph: innerDocument } as never,
    });
    const output = registry.createNode({
        id: "output",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });

    return new Graph([input, subgraph, output], [
        new Edge({ nodeId: "input", port: "text" }, { nodeId: "subgraph", port: "input" }),
        new Edge({ nodeId: "subgraph", port: "text" }, { nodeId: "output", port: "text" }),
    ], { id: "landing-c-subgraph" });
}

function createForEachShowcase(): Graph{
    const registry = createRegistry();
    const innerDocument = createForEachInnerGraph(registry).toJSON();

    const items = registry.createNode({
        id: "items",
        type: HarnessBuiltinNodeType.Constant,
        typeVersion: 1,
        config: { value: { type: "json", value: ["alpha", "beta", "gamma"] } },
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

    return new Graph([items, forEach, output], [
        new Edge({ nodeId: "items", port: "value" }, { nodeId: "forEach", port: "items" }),
        new Edge({ nodeId: "forEach", port: "results" }, { nodeId: "output", port: "json" }),
    ], { id: "landing-c-foreach" });
}

function createLoopShowcase(): Graph{
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

    return new Graph([initial, loop, output], [
        new Edge({ nodeId: "initial", port: "value" }, { nodeId: "loop", port: "initial" }),
        new Edge({ nodeId: "loop", port: "value" }, { nodeId: "output", port: "json" }),
    ], { id: "landing-c-loop" });
}

function createCheckpointShowcase(): Graph{
    const registry = createRegistry();
    const source = registry.createNode({
        id: "source",
        type: HarnessBuiltinNodeType.Constant,
        typeVersion: 1,
        config: { value: { type: "text", text: "x" } },
    });
    const first = registry.createNode({
        id: "first",
        type: "example.compositeDelay",
        typeVersion: 1,
    });
    const second = registry.createNode({
        id: "second",
        type: "example.compositeDelay",
        typeVersion: 1,
    });
    const output = registry.createNode({
        id: "output",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });

    return new Graph([source, first, second, output], [
        new Edge({ nodeId: "source", port: "value" }, { nodeId: "first", port: "in" }),
        new Edge({ nodeId: "first", port: "out" }, { nodeId: "second", port: "in" }),
        new Edge({ nodeId: "second", port: "out" }, { nodeId: "output", port: "text" }),
    ], { id: "landing-c-checkpoint" });
}

export type CompositeLandingDemo = {
    subgraph: GraphRunResult;
    forEach: GraphRunResult;
    loop: GraphRunResult;
    checkpoint: GraphCheckpoint;
    resumed: GraphRunResult;
};

export async function runCompositeLandingExample(): Promise<CompositeLandingDemo>{
    const host = { resolveProvider: () => undefined };

    const subgraph = await createSubgraphShowcase().run({
        host,
        input: { text: "hello" },
    }).done;

    const forEach = await createForEachShowcase().run({ host }).done;
    const loop = await createLoopShowcase().run({ host }).done;

    const checkpointGraph = createCheckpointShowcase();
    const checkpointRun = checkpointGraph.run({ host });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const checkpoint = await checkpointRun.pause();
    checkpointRun.resume();
    const resumed = await checkpointRun.done;

    return { subgraph, forEach, loop, checkpoint, resumed };
}
