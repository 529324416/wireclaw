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

class RequiredNode extends GraphNode{

    override readonly type = "test.nestedRequired";

    override get inputs(): readonly InputPortSpec[]{
        return [{ name: "in", type: "text" }];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{ name: "out", type: "text" }];
    }

    override async execute(
        _ctx: NodeContext,
        _inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        return { out: { type: "text", text: "ok" } };
    }
}

function createRegistry(){
    const registry = createBuiltinNodeRegistry();
    registry.register({
        type: "test.nestedRequired",
        version: 1,
        requirements: [{ kind: "provider", providerId: "deepseek" }],
        create: (id, config, inputs, ui) => new RequiredNode(id, config, inputs, ui),
    });
    return registry;
}

type Registry = ReturnType<typeof createRegistry>;

function innerGraph(registry: Registry, options: { brokenEdge?: boolean } = {}): Graph{
    const input = registry.createNode({
        id: "innerInput",
        type: HarnessBuiltinNodeType.Input,
        typeVersion: 1,
    });
    const required = registry.createNode({
        id: "innerRequired",
        type: "test.nestedRequired",
        typeVersion: 1,
    });
    const output = registry.createNode({
        id: "innerOutput",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });

    const edges = [
        new Edge(
            { nodeId: "innerInput", port: "text" },
            { nodeId: "innerRequired", port: "in" },
        ),
        new Edge(
            { nodeId: "innerRequired", port: "out" },
            { nodeId: "innerOutput", port: "text" },
        ),
    ];

    if (options.brokenEdge === true){
        edges.push(new Edge(
            { nodeId: "innerInput", port: "text" },
            { nodeId: "innerOutput", port: "missing" },
        ));
    }

    return new Graph([input, required, output], edges, { id: "inner-graph" });
}

function containerGraph(
    registry: Registry,
    type: string,
    config: Record<string, unknown>,
    id = "container",
): Graph{
    return new Graph([
        registry.createNode({
            id,
            type,
            typeVersion: 1,
            config: config as never,
        }),
    ], [], { id: "outer-graph" });
}

section("Subgraph 内层图问题递归定位");
{
    const registry = createRegistry();
    const outer = containerGraph(registry, HarnessBuiltinNodeType.Subgraph, {
        graph: innerGraph(registry, { brokenEdge: true }).toJSON(),
    });

    const issues = outer.validate();
    const broken = issues.find((issue) => issue.code === HarnessErrorCode.UnknownPort);

    assert.ok(broken, "expected an unknown-port issue from the embedded graph");
    assert.equal(broken.nodeId, "container");
    assert.equal(broken.graphPath, "subgraph.container");
    assert.equal(broken.nestedNodeId, "innerOutput");
    assert.equal(broken.nestedPort, "missing");
    assert.equal(broken.nestedEdgeIndex, 2);
    console.log("PASS Subgraph 内层 edge 问题回填到容器节点与 graphPath");
}

section("Subgraph 内层 requirements 校验与定位");
{
    const registry = createRegistry();
    const document = innerGraph(registry).toJSON();
    const outer = containerGraph(registry, HarnessBuiltinNodeType.Subgraph, {
        graph: document,
    });

    const missing = outer.validate({ requirements: { providers: [] } });
    const issue = missing.find(
        (candidate) => candidate.code === HarnessErrorCode.MissingProviderDependency,
    );

    assert.ok(issue, "expected the nested provider requirement to be reported");
    assert.equal(issue.nodeId, "container");
    assert.equal(issue.graphPath, "subgraph.container");
    assert.equal(issue.nestedNodeId, "innerRequired");

    const satisfied = outer.validate({ requirements: { providers: ["deepseek"] } });
    assert.equal(
        satisfied.some(
            (candidate) =>
                candidate.code === HarnessErrorCode.MissingProviderDependency,
        ),
        false,
    );
    console.log("PASS 内层 requirements 随 catalog 递归校验，并可定位到容器节点");
}

section("容器节点传播内层 requirements");
{
    const registry = createRegistry();
    const document = innerGraph(registry).toJSON();
    const container = registry.createNode({
        id: "container",
        type: HarnessBuiltinNodeType.Subgraph,
        typeVersion: 1,
        config: { graph: document } as never,
    });

    assert.deepEqual(container.collectRequirements(), [
        { kind: "provider", providerId: "deepseek" },
    ]);

    const input = registry.createNode({
        id: "outerInput",
        type: HarnessBuiltinNodeType.Input,
        typeVersion: 1,
    });
    const output = registry.createNode({
        id: "outerOutput",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });
    const outer = new Graph([input, container, output], [
        new Edge(
            { nodeId: "outerInput", port: "text" },
            { nodeId: "container", port: "input" },
        ),
        new Edge(
            { nodeId: "container", port: "text" },
            { nodeId: "outerOutput", port: "text" },
        ),
    ], { id: "outer-graph" });

    const result = await outer.run({
        host: { resolveProvider: () => undefined },
        input: { text: "hello" },
    }).done;

    assert.equal(result.status, "failed");
    assert.ok(result.error instanceof HarnessError);
    assert.equal(result.error?.code, HarnessErrorCode.MissingProviderDependency);
    assert.equal(result.error?.nodeId, "container");
    console.log("PASS 内层 requirements 传播到容器节点并在 run 预检中失败");
}

section("Loop / ForEach 内层图递归定位");
{
    const registry = createRegistry();

    for (const [type, path] of [
        [HarnessBuiltinNodeType.Loop, "loop.container"],
        [HarnessBuiltinNodeType.ForEach, "forEach.container"],
    ] as const){
        const outer = containerGraph(registry, type, {
            graph: { version: 999, id: "broken", nodes: [], edges: [] },
            ...(type === HarnessBuiltinNodeType.Loop ? { maxIterations: 3 } : {}),
        });

        const issue = outer.validate().find(
            (candidate) => candidate.code === HarnessErrorCode.InvalidGraph,
        );

        assert.ok(issue, `expected ${type} to report its invalid embedded graph`);
        assert.equal(issue.nodeId, "container");
        assert.equal(issue.graphPath, path);
        assert.match(issue.message, /Embedded graph/);
    }
    console.log("PASS Loop / ForEach 的非法内嵌图定位到各自 graphPath");
}

section("多层嵌套路径拼接");
{
    const registry = createRegistry();
    const inner = containerGraph(registry, HarnessBuiltinNodeType.Loop, {
        graph: innerGraph(registry, { brokenEdge: true }).toJSON(),
        maxIterations: 3,
    }, "inner");
    const outer = containerGraph(registry, HarnessBuiltinNodeType.Subgraph, {
        graph: inner.toJSON(),
    }, "outer");

    const issue = outer.validate().find(
        (candidate) => candidate.code === HarnessErrorCode.UnknownPort,
    );

    assert.ok(issue);
    assert.equal(issue.nodeId, "outer");
    assert.equal(issue.graphPath, "subgraph.outer/loop.inner");
    assert.equal(issue.nestedNodeId, "innerOutput");
    console.log("PASS 嵌套路径按 subgraph/loop 逐级拼接");
}

section("非法 config.graph 被定位");
{
    const registry = createRegistry();
    const outer = containerGraph(registry, HarnessBuiltinNodeType.Subgraph, {
        graph: "not-a-graph",
    });

    const issue = outer.validate().find(
        (candidate) => candidate.code === HarnessErrorCode.InvalidGraph,
    );

    assert.ok(issue);
    assert.equal(issue.nodeId, "container");
    assert.equal(issue.graphPath, "subgraph.container");
    console.log("PASS config.graph 非对象时由容器节点报告");
}

console.log("\nAll harness nested validation checks passed.");
