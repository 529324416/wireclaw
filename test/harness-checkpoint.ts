import assert from "node:assert/strict";

import {
    Edge,
    Graph,
    GraphNode,
    HarnessBuiltinNodeType,
    HarnessError,
    HarnessErrorCode,
    createBuiltinNodeRegistry,
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

class DelayNode extends GraphNode{

    static executions = 0;

    override readonly type = "test.checkpointDelay";

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
        DelayNode.executions += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (ctx.signal.aborted) throw new Error("aborted");

        const value = inputs.in;
        if (value?.type !== "text") throw new Error("expected text");
        return {
            out: {
                type: "text",
                text: this.id === "first" ? value.text : `${value.text}!`,
            },
        };
    }
}

function createRegistry() {
    const registry = createBuiltinNodeRegistry();
    registry.register({
        type: "test.checkpointDelay",
        version: 1,
        create: (id, config, inputs, ui) => new DelayNode(id, config, inputs, ui),
    });
    return registry;
}

function createGraph(): Graph{
    const registry = createRegistry();
    const source = registry.createNode({
        id: "source",
        type: HarnessBuiltinNodeType.Constant,
        typeVersion: 1,
        config: { value: { type: "text", text: "x" } },
    });
    const first = registry.createNode({
        id: "first",
        type: "test.checkpointDelay",
        typeVersion: 1,
    });
    const second = registry.createNode({
        id: "second",
        type: "test.checkpointDelay",
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
    ], { id: "checkpoint-graph" });
}

section("pause -> checkpoint -> resume");
{
    DelayNode.executions = 0;
    const graph = createGraph();
    const host = { resolveProvider: () => undefined };

    const run = graph.run({ host });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const checkpoint = await run.pause();

    assert.equal(run.status, "paused");
    assert.equal(checkpoint.version, 1);
    assert.equal(checkpoint.graphId, graph.id);
    assert.ok(checkpoint.records.some((record) => record.nodeId === "first"));
    assert.ok(!checkpoint.records.some((record) => record.nodeId === "second"));
    assert.equal(DelayNode.executions, 1);

    const serialized = JSON.parse(JSON.stringify(checkpoint)) as typeof checkpoint;
    run.cancel();
    const cancelled = await run.done;
    assert.equal(cancelled.status, "cancelled");

    const resumed = graph.resume(serialized, {
        host: { resolveProvider: () => undefined },
    });
    const result = await resumed.done;

    assert.equal(result.status, "completed");
    const text = result.outputs.text;
    assert.equal(text?.type, "text");
    if (text?.type === "text") assert.equal(text.text, "x!");
    assert.equal(DelayNode.executions, 2);
    assert.ok(result.records.some((record) => record.nodeId === "second"));
    console.log("PASS pause 生成可序列化 checkpoint，resume 只执行剩余节点");
}

section("同 run resume 与非法 checkpoint");
{
    DelayNode.executions = 0;
    const graph = createGraph();
    const run = graph.run({ host: { resolveProvider: () => undefined } });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const checkpoint = await run.pause();
    assert.equal(run.resume(), true);
    const result = await run.done;

    assert.equal(result.status, "completed");
    assert.equal(DelayNode.executions, 2);

    assert.throws(
        () => graph.resume({
            ...checkpoint,
            graphId: "another-graph",
        }, {
            host: { resolveProvider: () => undefined },
        }),
        (error: unknown) => error instanceof HarnessError
            && error.code === HarnessErrorCode.InvalidCheckpoint,
    );
    console.log("PASS 同一 run 恢复，非法 graphId 被拒绝");
}

console.log("\nAll harness checkpoint checks passed.");
