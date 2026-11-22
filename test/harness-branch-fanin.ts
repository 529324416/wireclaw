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

class UpperNode extends GraphNode{

    override readonly type = "test.upper";

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
        const value = inputs.in;
        if (value?.type !== "text") throw new Error("expected text");
        return { out: { type: "text", text: value.text.toUpperCase() } };
    }
}

class ArrayJoinNode extends GraphNode{

    override readonly type = "test.arrayJoin";

    override get inputs(): readonly InputPortSpec[]{
        return [{ name: "items", type: "json", required: true, multiple: true }];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{ name: "out", type: "text" }];
    }

    override async execute(
        _ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const value = inputs.items;
        if (value?.type !== "json" || !Array.isArray(value.value)){
            throw new Error("expected a json array");
        }
        const parts = value.value.map((item) =>{
            if (typeof item !== "object" || item === null || Array.isArray(item)
                || item.type !== "text" || typeof item.text !== "string"){
                throw new Error("expected text fan-in items");
            }
            return item.text;
        });
        return { out: { type: "text", text: parts.join(",") } };
    }
}

class StreamSourceNode extends GraphNode{

    override readonly type = "test.streamSource";

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
        ctx: NodeContext,
    ): Promise<NodeOutputValues>{
        const prefix = typeof this.config === "object"
            && this.config !== null
            && !Array.isArray(this.config)
            ? String(this.config.prefix ?? "")
            : "";
        ctx.emit("out", { type: "text", text: `${prefix}1` });
        ctx.emit("out", { type: "text", text: `${prefix}2` });
        return { out: { type: "text", text: `${prefix}1${prefix}2` } };
    }
}

class CollectStreamNode extends GraphNode{

    override readonly type = "test.collectStream";

    override get inputs(): readonly InputPortSpec[]{
        return [{
            name: "signal",
            type: "text",
            mode: "stream",
            required: true,
            multiple: true,
            join: "all",
        }];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{ name: "out", type: "text" }];
    }

    override async execute(
        ctx: NodeContext,
    ): Promise<NodeOutputValues>{
        const values: string[] = [];
        for await (const chunk of ctx.stream("signal")){
            if (chunk.type === "text") values.push(chunk.text);
        }
        return { out: { type: "text", text: values.sort().join(",") } };
    }
}

function createRegistry() {
    const registry = createBuiltinNodeRegistry();
    registry.register({
        type: "test.upper",
        version: 1,
        create: (id, config, inputs, ui) => new UpperNode(id, config, inputs, ui),
    });
    registry.register({
        type: "test.arrayJoin",
        version: 1,
        create: (id, config, inputs, ui) => new ArrayJoinNode(id, config, inputs, ui),
    });
    registry.register({
        type: "test.streamSource",
        version: 1,
        create: (id, config, inputs, ui) => new StreamSourceNode(id, config, inputs, ui),
    });
    registry.register({
        type: "test.collectStream",
        version: 1,
        create: (id, config, inputs, ui) => new CollectStreamNode(id, config, inputs, ui),
    });
    return registry;
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

function branchGraph(
    condition: boolean,
    registry = createRegistry(),
): Graph{
    const value = node(registry, "value", HarnessBuiltinNodeType.Constant, {
        value: { type: "text", text: "hello" },
    });
    const conditionNode = node(registry, "condition", HarnessBuiltinNodeType.Constant, {
        value: { type: "json", value: condition },
    });
    const branch = node(registry, "branch", HarnessBuiltinNodeType.Branch);
    const upperTrue = node(registry, "upperTrue", "test.upper");
    const upperFalse = node(registry, "upperFalse", "test.upper");
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    return new Graph([value, conditionNode, branch, upperTrue, upperFalse, output], [
        new Edge({ nodeId: "value", port: "value" }, { nodeId: "branch", port: "value" }),
        new Edge({ nodeId: "condition", port: "value" }, { nodeId: "branch", port: "condition" }),
        new Edge({ nodeId: "branch", port: "true" }, { nodeId: "upperTrue", port: "in" }),
        new Edge({ nodeId: "branch", port: "false" }, { nodeId: "upperFalse", port: "in" }),
        new Edge({ nodeId: "upperTrue", port: "out" }, { nodeId: "output", port: "text" }),
        new Edge({ nodeId: "upperFalse", port: "out" }, { nodeId: "output", port: "text" }),
    ], { id: `branch-${String(condition)}` });
}

section("BranchNode 分支与 skipped 传播");
{
    for (const condition of [true, false]){
        const events: GraphEvent[] = [];
        const result = await branchGraph(condition).run({
            host: { resolveProvider: () => undefined },
            listener: (event) => events.push(event),
        }).done;

        assert.equal(result.status, "completed");
        const text = result.outputs.text;
        assert.equal(text?.type, "text");
        if (text?.type === "text") assert.equal(text.text, "HELLO");

        const skippedId = condition ? "upperFalse" : "upperTrue";
        assert.ok(result.records.some((record) =>
            record.nodeId === skippedId && record.status === "skipped"));
        assert.ok(events.some((event) =>
            event.type === "node:skipped" && event.nodeId === skippedId));
    }
    console.log("PASS 条件 true/false 只执行对应分支，另一侧记录 skipped");
}

section("B3 分支图序列化与隐式 exclusive join");
{
    const registry = createRegistry();
    const graph = branchGraph(true, registry);
    assert.deepEqual(graph.validate(), []);

    const loaded = Graph.fromJSON(graph.toJSON(), { registry });
    const result = await loaded.run({
        host: { resolveProvider: () => undefined },
    }).done;

    assert.equal(result.status, "completed");
    const text = result.outputs.text;
    assert.equal(text?.type, "text");
    if (text?.type === "text") assert.equal(text.text, "HELLO");
    assert.ok(result.records.some((record) =>
        record.nodeId === "upperFalse" && record.status === "skipped"));
    console.log("PASS Branch 图 JSON 往返，单输入多来源自动 exclusive join");
}

section("隐式 join 的并发歧义");
{
    const registry = createRegistry();
    const a = node(registry, "a", HarnessBuiltinNodeType.Constant, {
        value: { type: "text", text: "a" },
    });
    const b = node(registry, "b", HarnessBuiltinNodeType.Constant, {
        value: { type: "text", text: "b" },
    });
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const graph = new Graph([a, b, output], [
        new Edge({ nodeId: "a", port: "value" }, { nodeId: "output", port: "text" }),
        new Edge({ nodeId: "b", port: "value" }, { nodeId: "output", port: "text" }),
    ], { id: "ambiguous-join" });

    assert.deepEqual(graph.validate(), []);
    const result = await graph.run({
        host: { resolveProvider: () => undefined },
    }).done;

    assert.equal(result.status, "failed");
    assert.ok(result.error instanceof HarnessError);
    assert.equal(result.error?.code, HarnessErrorCode.AmbiguousJoin);
    console.log("PASS 两个并发来源触发 AmbiguousJoin，而不是静默丢值");
}

section("显式 MergeNode 仍可用");
{
    const registry = createRegistry();
    const a = node(registry, "a", HarnessBuiltinNodeType.Constant, {
        value: { type: "text", text: "a" },
    });
    const b = node(registry, "b", HarnessBuiltinNodeType.Constant, {
        value: { type: "text", text: "b" },
    });
    const merge = node(registry, "merge", HarnessBuiltinNodeType.Merge);
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const graph = new Graph([a, b, merge, output], [
        new Edge({ nodeId: "a", port: "value" }, { nodeId: "merge", port: "a" }),
        new Edge({ nodeId: "b", port: "value" }, { nodeId: "merge", port: "b" }),
        new Edge({ nodeId: "merge", port: "value" }, { nodeId: "output", port: "text" }),
    ], { id: "explicit-merge" });

    const result = await graph.run({
        host: { resolveProvider: () => undefined },
    }).done;
    assert.equal(result.status, "completed");
    const text = result.outputs.text;
    assert.equal(text?.type, "text");
    if (text?.type === "text") assert.equal(text.text, "a");
    console.log("PASS 显式 MergeNode 保留，默认取 a");
}

section("multiple value fan-in");
{
    const registry = createRegistry();
    const a = node(registry, "a", HarnessBuiltinNodeType.Constant, {
        value: { type: "text", text: "a" },
    });
    const b = node(registry, "b", HarnessBuiltinNodeType.Constant, {
        value: { type: "text", text: "b" },
    });
    const join = node(registry, "join", "test.arrayJoin");
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const graph = new Graph([a, b, join, output], [
        new Edge({ nodeId: "a", port: "value" }, { nodeId: "join", port: "items" }),
        new Edge({ nodeId: "b", port: "value" }, { nodeId: "join", port: "items" }),
        new Edge({ nodeId: "join", port: "out" }, { nodeId: "output", port: "text" }),
    ], { id: "value-fanin" });

    const result = await graph.run({
        host: { resolveProvider: () => undefined },
    }).done;
    assert.equal(result.status, "completed");
    const text = result.outputs.text;
    assert.equal(text?.type, "text");
    if (text?.type === "text") assert.equal(text.text, "a,b");
    console.log("PASS multiple json 输入聚合为 HarnessValue 数组");
}

section("multiple stream join(all)");
{
    const registry = createRegistry();
    const left = node(registry, "left", "test.streamSource", { prefix: "L" });
    const right = node(registry, "right", "test.streamSource", { prefix: "R" });
    const collect = node(registry, "collect", "test.collectStream");
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const graph = new Graph([left, right, collect, output], [
        new Edge({ nodeId: "left", port: "out" }, { nodeId: "collect", port: "signal" }),
        new Edge({ nodeId: "right", port: "out" }, { nodeId: "collect", port: "signal" }),
        new Edge({ nodeId: "collect", port: "out" }, { nodeId: "output", port: "text" }),
    ], { id: "stream-fanin" });

    const result = await graph.run({
        host: { resolveProvider: () => undefined },
    }).done;
    assert.equal(result.status, "completed");
    const text = result.outputs.text;
    assert.equal(text?.type, "text");
    if (text?.type === "text"){
        assert.equal(text.text, "L1,L2,R1,R2");
    }
    console.log("PASS 多个 stream 源按 all 汇合后关闭");
}

console.log("\nAll harness branch/fan-in checks passed.");
