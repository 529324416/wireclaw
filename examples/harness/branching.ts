import {
    Edge,
    Graph,
    GraphNode,
    HarnessBuiltinNodeType,
    createBuiltinNodeRegistry,
} from "../../src/harness";
import type {
    GraphRunResult,
    InputPortSpec,
    NodeContext,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "../../src/harness";

class TagNode extends GraphNode{

    override readonly type = "example.tag";

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
        if (value?.type !== "text"){
            throw new Error("TagNode expects text");
        }

        const suffix = typeof this.config === "object"
            && this.config !== null
            && !Array.isArray(this.config)
            ? String(this.config.suffix ?? "")
            : "";

        return { out: { type: "text", text: value.text + suffix } };
    }
}

export function createBranchRegistry() {
    const registry = createBuiltinNodeRegistry();
    registry.register({
        type: "example.tag",
        version: 1,
        title: "Tag",
        create: (id, config, inputs, ui) => new TagNode(id, config, inputs, ui),
    });
    return registry;
}

function branchNodes(
    condition: boolean,
    withMerge: boolean,
): Graph{
    const registry = createBranchRegistry();
    const value = registry.createNode({
        id: "value",
        type: HarnessBuiltinNodeType.Constant,
        typeVersion: 1,
        config: { value: { type: "text", text: "hello" } },
    });
    const conditionNode = registry.createNode({
        id: "condition",
        type: HarnessBuiltinNodeType.Constant,
        typeVersion: 1,
        config: { value: { type: "json", value: condition } },
    });
    const branch = registry.createNode({
        id: "branch",
        type: HarnessBuiltinNodeType.Branch,
        typeVersion: 1,
    });
    const truePath = registry.createNode({
        id: "truePath",
        type: "example.tag",
        typeVersion: 1,
        config: { suffix: "-A" },
    });
    const falsePath = registry.createNode({
        id: "falsePath",
        type: "example.tag",
        typeVersion: 1,
        config: { suffix: "-B" },
    });
    const output = registry.createNode({
        id: "output",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });

    const nodes = [value, conditionNode, branch, truePath, falsePath];
    const edges = [
        new Edge({ nodeId: "value", port: "value" }, { nodeId: "branch", port: "value" }),
        new Edge({ nodeId: "condition", port: "value" }, { nodeId: "branch", port: "condition" }),
        new Edge({ nodeId: "branch", port: "true" }, { nodeId: "truePath", port: "in" }),
        new Edge({ nodeId: "branch", port: "false" }, { nodeId: "falsePath", port: "in" }),
    ];

    if (withMerge){
        const merge = registry.createNode({
            id: "merge",
            type: HarnessBuiltinNodeType.Filter,
            typeVersion: 1,
        });
        nodes.push(merge, output);
        edges.push(
            new Edge({ nodeId: "truePath", port: "out" }, { nodeId: "merge", port: "a" }),
            new Edge({ nodeId: "falsePath", port: "out" }, { nodeId: "merge", port: "b" }),
            new Edge({ nodeId: "merge", port: "value" }, { nodeId: "output", port: "text" }),
        );
    } else {
        nodes.push(output);
        // 普通图：两条分支直接进入同一个 input，由运行时做 exclusive join
        edges.push(
            new Edge({ nodeId: "truePath", port: "out" }, { nodeId: "output", port: "text" }),
            new Edge({ nodeId: "falsePath", port: "out" }, { nodeId: "output", port: "text" }),
        );
    }

    return new Graph(nodes, edges, {
        id: `landing-b-${withMerge ? "merge" : "auto"}-${String(condition)}`,
        title: withMerge ? "Landing B explicit merge" : "Landing B implicit join",
    });
}

/** 普通 Branch 图：不手动放 Filter 节点，系统用 exclusive join 汇合 */
export function createAutoJoinBranchGraph(condition: boolean): Graph{
    return branchNodes(condition, false);
}

/** 对照：显式 Filter 节点 */
export function createExplicitMergeBranchGraph(condition: boolean): Graph{
    return branchNodes(condition, true);
}

/** 两个并发来源直接进入同一输入，用于展示 AmbiguousJoin */
export function createAmbiguousBranchGraph(): Graph{
    const registry = createBranchRegistry();
    const a = registry.createNode({
        id: "a",
        type: HarnessBuiltinNodeType.Constant,
        typeVersion: 1,
        config: { value: { type: "text", text: "A" } },
    });
    const b = registry.createNode({
        id: "b",
        type: HarnessBuiltinNodeType.Constant,
        typeVersion: 1,
        config: { value: { type: "text", text: "B" } },
    });
    const output = registry.createNode({
        id: "output",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });

    return new Graph([a, b, output], [
        new Edge({ nodeId: "a", port: "value" }, { nodeId: "output", port: "text" }),
        new Edge({ nodeId: "b", port: "value" }, { nodeId: "output", port: "text" }),
    ], {
        id: "landing-b-ambiguous",
        title: "Landing B ambiguous join",
    });
}

export type BranchLandingDemo = {
    autoTrue: GraphRunResult;
    autoFalse: GraphRunResult;
    ambiguous: GraphRunResult;
    explicitMerge: GraphRunResult;
};

export async function runBranchLandingExample(): Promise<BranchLandingDemo>{
    const host = { resolveProvider: () => undefined };
    const input = { text: "ignored" };

    const autoTrue = await createAutoJoinBranchGraph(true).run({ host, input }).done;
    const autoFalse = await createAutoJoinBranchGraph(false).run({ host, input }).done;
    const ambiguous = await createAmbiguousBranchGraph().run({ host, input }).done;
    const explicitMerge = await createExplicitMergeBranchGraph(true).run({ host, input }).done;

    return { autoTrue, autoFalse, ambiguous, explicitMerge };
}
