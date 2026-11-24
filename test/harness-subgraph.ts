import assert from "node:assert/strict";

import {
    Edge,
    Graph,
    GraphNode,
    HarnessBuiltinNodeType,
    HarnessError,
    HarnessErrorCode,
    createBuiltinNodeRegistry,
    describeNodeType,
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

class UpperNode extends GraphNode{

    override readonly type = "test.subgraphUpper";

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

function createRegistry() {
    const registry = createBuiltinNodeRegistry();
    registry.register({
        type: "test.subgraphUpper",
        version: 1,
        create: (id, config, inputs, ui) => new UpperNode(id, config, inputs, ui),
    });
    return registry;
}

function createInnerGraph(registry: ReturnType<typeof createRegistry>): Graph{
    const input = registry.createNode({
        id: "innerInput",
        type: HarnessBuiltinNodeType.Input,
        typeVersion: 1,
    });
    const upper = registry.createNode({
        id: "innerUpper",
        type: "test.subgraphUpper",
        typeVersion: 1,
    });
    const output = registry.createNode({
        id: "innerOutput",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });

    return new Graph([input, upper, output], [
        new Edge({ nodeId: "innerInput", port: "text" }, { nodeId: "innerUpper", port: "in" }),
        new Edge({ nodeId: "innerUpper", port: "out" }, { nodeId: "innerOutput", port: "text" }),
    ], { id: "inner-graph" });
}

function createOuterGraph(
    registry: ReturnType<typeof createRegistry>,
    innerDocument: unknown,
): Graph{
    const input = registry.createNode({
        id: "outerInput",
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
        id: "outerOutput",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });

    return new Graph([input, subgraph, output], [
        new Edge({ nodeId: "outerInput", port: "text" }, { nodeId: "subgraph", port: "input" }),
        new Edge({ nodeId: "subgraph", port: "text" }, { nodeId: "outerOutput", port: "text" }),
    ], { id: "outer-graph" });
}

section("Subgraph 输入输出映射");
{
    const registry = createRegistry();
    const innerDocument = createInnerGraph(registry).toJSON();
    const outer = createOuterGraph(registry, innerDocument);

    const result = await outer.run({
        host: { resolveProvider: () => undefined },
        input: { text: "hello" },
    }).done;

    assert.equal(result.status, "completed");
    const text = result.outputs.text;
    assert.equal(text?.type, "text");
    if (text?.type === "text") assert.equal(text.text, "HELLO");
    console.log("PASS Subgraph 外层 input -> 内层 Graph -> 外层 text");
}

section("Subgraph 序列化往返");
{
    const registry = createRegistry();
    const innerDocument = createInnerGraph(registry).toJSON();
    const outer = createOuterGraph(registry, innerDocument);
    const document = outer.toJSON();

    const loaded = Graph.fromJSON(document, { registry });
    const result = await loaded.run({
        host: { resolveProvider: () => undefined },
        input: { text: "again" },
    }).done;

    assert.equal(result.status, "completed");
    const text = result.outputs.text;
    assert.equal(text?.type, "text");
    if (text?.type === "text") assert.equal(text.text, "AGAIN");
    console.log("PASS 内嵌 GraphDocument 随外层 Graph JSON 往返");
}

section("Subgraph 配置错误");
{
    const registry = createRegistry();
    const outer = createOuterGraph(registry, {
        version: 999,
        id: "broken",
        nodes: [],
        edges: [],
    });

    const result = await outer.run({
        host: { resolveProvider: () => undefined },
        input: { text: "hello" },
    }).done;

    assert.equal(result.status, "failed");
    assert.ok(result.error instanceof HarnessError);
    // 递归校验在 run 启动前就拦下非法内嵌图，并带回 graphPath。
    assert.equal(result.error?.code, HarnessErrorCode.InvalidGraph);
    assert.ok(
        result.error?.issues?.some(
            (issue) => issue.graphPath === "subgraph.subgraph",
        ),
        "expected the invalid embedded graph to be located",
    );
    console.log("PASS 内层 GraphDocument 非法时在启动前失败并定位 graphPath");
}

section("Subgraph 编辑器目录");
{
    const registry = createRegistry();
    const entry = describeNodeType(registry, HarnessBuiltinNodeType.Subgraph);
    assert.ok(entry.inputs.some((port) => port.name === "input"));
    assert.ok(entry.inputs.some((port) => port.name === "attachments"));
    assert.ok(entry.outputs.some((port) => port.name === "text"));
    assert.equal(entry.error, undefined);
    console.log("PASS Subgraph 节点目录包含 input/output 映射端口");
}

console.log("\nAll harness subgraph checks passed.");
