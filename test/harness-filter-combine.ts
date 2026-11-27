import assert from "node:assert/strict";

import {
    Edge,
    Graph,
    HarnessBuiltinNodeType,
    HarnessError,
    HarnessErrorCode,
    createBuiltinNodeRegistry,
} from "../src/harness";

function section(title: string): void{
    console.log(`\n=== ${title} ===`);
}

function node(
    registry: ReturnType<typeof createBuiltinNodeRegistry>,
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

async function run(
    nodes: ReturnType<typeof node>[],
    edges: Edge[],
    id: string,
) {
    const graph = new Graph(nodes, edges, { id });
    return graph.run({ host: { resolveProvider: () => undefined } }).done;
}

function constant(registry: ReturnType<typeof createBuiltinNodeRegistry>, id: string, text: string) {
    return node(registry, id, HarnessBuiltinNodeType.Constant, {
        value: { type: "text", text },
    });
}

function textOf(result: Awaited<ReturnType<typeof run>>, port = "text"): string{
    const value = result.outputs[port];
    assert.equal(value?.type, "text", `${port} should be text`);
    return value?.type === "text" ? value.text : "";
}

section("Filter 两路都有值时取 a");
{
    const registry = createBuiltinNodeRegistry();
    const a = constant(registry, "a", "left");
    const b = constant(registry, "b", "right");
    const filter = node(registry, "filter", HarnessBuiltinNodeType.Filter);
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const result = await run(
        [a, b, filter, output],
        [
            new Edge({ nodeId: "a", port: "value" }, { nodeId: "filter", port: "a" }),
            new Edge({ nodeId: "b", port: "value" }, { nodeId: "filter", port: "b" }),
            new Edge({ nodeId: "filter", port: "value" }, { nodeId: "output", port: "text" }),
        ],
        "filter-a",
    );

    assert.equal(result.status, "completed");
    assert.equal(textOf(result), "left");
    console.log("PASS Filter 默认取 a");
}

section("Filter 只连接 b 时透传 b");
{
    const registry = createBuiltinNodeRegistry();
    const b = constant(registry, "b", "right");
    const filter = node(registry, "filter", HarnessBuiltinNodeType.Filter);
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const result = await run(
        [b, filter, output],
        [
            new Edge({ nodeId: "b", port: "value" }, { nodeId: "filter", port: "b" }),
            new Edge({ nodeId: "filter", port: "value" }, { nodeId: "output", port: "text" }),
        ],
        "filter-b",
    );

    assert.equal(result.status, "completed");
    assert.equal(textOf(result), "right");
    console.log("PASS Filter 在只有 b 时输出 b");
}

section("Combine 按分隔符合并两段文本");
{
    const registry = createBuiltinNodeRegistry();
    const a = constant(registry, "a", "hello");
    const b = constant(registry, "b", "world");
    const combine = node(registry, "combine", HarnessBuiltinNodeType.Combine, {
        separator: " + ",
    });
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const result = await run(
        [a, b, combine, output],
        [
            new Edge({ nodeId: "a", port: "value" }, { nodeId: "combine", port: "a" }),
            new Edge({ nodeId: "b", port: "value" }, { nodeId: "combine", port: "b" }),
            new Edge({ nodeId: "combine", port: "text" }, { nodeId: "output", port: "text" }),
        ],
        "combine-both",
    );

    assert.equal(result.status, "completed");
    assert.equal(textOf(result), "hello + world");
    console.log("PASS Combine 合并两段文本并使用分隔符");
}

section("Combine 只连接一路时直接输出");
{
    const registry = createBuiltinNodeRegistry();
    const a = constant(registry, "a", "solo");
    const combine = node(registry, "combine", HarnessBuiltinNodeType.Combine);
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const result = await run(
        [a, combine, output],
        [
            new Edge({ nodeId: "a", port: "value" }, { nodeId: "combine", port: "a" }),
            new Edge({ nodeId: "combine", port: "text" }, { nodeId: "output", port: "text" }),
        ],
        "combine-single",
    );

    assert.equal(result.status, "completed");
    assert.equal(textOf(result), "solo");
    console.log("PASS Combine 单路输入直接透传");
}

section("Combine 两路都缺失时执行期报错");
{
    const registry = createBuiltinNodeRegistry();
    const combine = node(registry, "combine", HarnessBuiltinNodeType.Combine);
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const result = await run(
        [combine, output],
        [new Edge({ nodeId: "combine", port: "text" }, { nodeId: "output", port: "text" })],
        "combine-empty",
    );

    assert.equal(result.status, "failed");
    assert.ok(result.error instanceof HarnessError);
    assert.equal(result.error?.code, HarnessErrorCode.MissingValue);
    console.log("PASS Combine 无输入时抛出 MissingValue");
}

section("旧 Merge 节点保持兼容");
{
    const registry = createBuiltinNodeRegistry();
    const a = constant(registry, "a", "old-a");
    const merge = node(registry, "merge", HarnessBuiltinNodeType.Merge);
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const result = await run(
        [a, merge, output],
        [
            new Edge({ nodeId: "a", port: "value" }, { nodeId: "merge", port: "a" }),
            new Edge({ nodeId: "merge", port: "value" }, { nodeId: "output", port: "text" }),
        ],
        "legacy-merge",
    );

    assert.equal(result.status, "completed");
    assert.equal(textOf(result), "old-a");
    console.log("PASS core.merge 仍可运行（别名兼容）");
}
