import {
    Edge,
    Graph,
    GraphNode,
    HarnessBuiltinNodeType,
    createBuiltinNodeRegistry,
} from "../../src/harness";
import type {
    GraphEventListener,
    GraphRunResult,
    InputPortSpec,
    NodeContext,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "../../src/harness";

/**
 * 最小自定义节点：text 输入 -> 大写 text 输出。
 *
 * 同时演示 value 输出与一次 stream emit；没有流消费者时，
 * stream emit 只会产生 node:stream 事件，不会污染最终值。
 */
export class UppercaseNode extends GraphNode{

    override readonly type = "example.uppercase";

    override get inputs(): readonly InputPortSpec[]{
        return [{ name: "text", type: "text", required: true }];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{
            name: "text",
            type: "text",
            supportedModes: ["value", "stream"],
            defaultMode: "value",
        }];
    }

    override async execute(
        ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const value = inputs.text;
        if (value?.type !== "text"){
            throw new Error("UppercaseNode expects a text input");
        }

        const text = value.text.toUpperCase();
        ctx.emit("text", { type: "text", text });
        return { text: { type: "text", text } };
    }
}

/** 代码创建 Graph 并完成连线 */
export function createMinimalGraph(): Graph{
    const registry = createBuiltinNodeRegistry();
    registry.register({
        type: "example.uppercase",
        version: 1,
        title: "Uppercase",
        description: "把 text 转为大写",
        create: (id, config, inputs, ui) => new UppercaseNode(id, config, inputs, ui),
    });

    const input = registry.createNode({
        id: "input",
        type: HarnessBuiltinNodeType.Input,
        typeVersion: 1,
    });
    const uppercase = registry.createNode({
        id: "uppercase",
        type: "example.uppercase",
        typeVersion: 1,
    });
    const output = registry.createNode({
        id: "output",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });

    return new Graph(
        [input, uppercase, output],
        [
            new Edge(
                { nodeId: "input", port: "text" },
                { nodeId: "uppercase", port: "text" },
            ),
            new Edge(
                { nodeId: "uppercase", port: "text" },
                { nodeId: "output", port: "text" },
            ),
        ],
        {
            id: "minimal-graph",
            title: "Minimal Harness Graph",
            description: "Landing 0：Input -> Uppercase -> Output",
        },
    );
}

/** 运行最小图；不需要 Provider，完全离线 */
export function runMinimalGraph(
    listener?: GraphEventListener,
): Promise<GraphRunResult>{
    const graph = createMinimalGraph();
    return graph.run({
        host: {
            resolveProvider: () => undefined,
        },
        input: { text: "hello harness" },
        listener,
    }).done;
}
