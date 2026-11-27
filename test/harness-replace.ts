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

function constant(
    registry: ReturnType<typeof createBuiltinNodeRegistry>,
    id: string,
    text: string,
) {
    return node(registry, id, HarnessBuiltinNodeType.Constant, {
        value: { type: "text", text },
    });
}

function textOf(result: Awaited<ReturnType<typeof run>>, port = "text"): string{
    const value = result.outputs[port];
    assert.equal(value?.type, "text", `${port} should be text`);
    return value?.type === "text" ? value.text : "";
}

section("Replace 使用本地 config 替换全部");
{
    const registry = createBuiltinNodeRegistry();
    const replace = node(registry, "replace", HarnessBuiltinNodeType.Replace, {
        rawText: "old old old",
        keyword: "old",
        replacement: "new",
    });
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const result = await run(
        [replace, output],
        [new Edge({ nodeId: "replace", port: "text" }, { nodeId: "output", port: "text" })],
        "replace-config",
    );

    assert.equal(result.status, "completed");
    assert.equal(textOf(result), "new new new");
    console.log("PASS Replace 默认替换全部");
}

section("Replace 端口覆盖 config 并遵守 count");
{
    const registry = createBuiltinNodeRegistry();
    const raw = constant(registry, "raw", "a-b-a");
    const keyword = constant(registry, "keyword", "a");
    const replacement = constant(registry, "replacement", "X");
    const replace = node(registry, "replace", HarnessBuiltinNodeType.Replace, {
        rawText: "ignored",
        keyword: "ignored",
        replacement: "ignored",
        count: 1,
    });
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const result = await run(
        [raw, keyword, replacement, replace, output],
        [
            new Edge({ nodeId: "raw", port: "value" }, { nodeId: "replace", port: "raw_text" }),
            new Edge({ nodeId: "keyword", port: "value" }, { nodeId: "replace", port: "keyword" }),
            new Edge(
                { nodeId: "replacement", port: "value" },
                { nodeId: "replace", port: "replacement" },
            ),
            new Edge({ nodeId: "replace", port: "text" }, { nodeId: "output", port: "text" }),
        ],
        "replace-ports",
    );

    assert.equal(result.status, "completed");
    assert.equal(textOf(result), "X-b-a");
    console.log("PASS Replace 使用端口覆盖 config 且 count=1");
}

section("Replace count=0 不替换");
{
    const registry = createBuiltinNodeRegistry();
    const replace = node(registry, "replace", HarnessBuiltinNodeType.Replace, {
        rawText: "old",
        keyword: "old",
        replacement: "new",
        count: 0,
    });
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const result = await run(
        [replace, output],
        [new Edge({ nodeId: "replace", port: "text" }, { nodeId: "output", port: "text" })],
        "replace-zero",
    );

    assert.equal(result.status, "completed");
    assert.equal(textOf(result), "old");
    console.log("PASS Replace count=0 原样返回");
}

section("Replace 空 keyword 原样返回");
{
    const registry = createBuiltinNodeRegistry();
    const replace = node(registry, "replace", HarnessBuiltinNodeType.Replace, {
        rawText: "old",
        keyword: "",
        replacement: "new",
    });
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const result = await run(
        [replace, output],
        [new Edge({ nodeId: "replace", port: "text" }, { nodeId: "output", port: "text" })],
        "replace-empty-keyword",
    );

    assert.equal(result.status, "completed");
    assert.equal(textOf(result), "old");
    console.log("PASS Replace 空 keyword 不做替换");
}

section("Replace 缺少 keyword 时执行期报错");
{
    const registry = createBuiltinNodeRegistry();
    const replace = node(registry, "replace", HarnessBuiltinNodeType.Replace, {
        rawText: "old",
    });
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const result = await run(
        [replace, output],
        [new Edge({ nodeId: "replace", port: "text" }, { nodeId: "output", port: "text" })],
        "replace-missing-keyword",
    );

    assert.equal(result.status, "failed");
    assert.ok(result.error instanceof HarnessError);
    assert.equal(result.error?.code, HarnessErrorCode.MissingValue);
    console.log("PASS Replace 缺少 keyword 时抛出 MissingValue");
}

section("Replace 缺少 raw_text 时执行期报错");
{
    const registry = createBuiltinNodeRegistry();
    const replace = node(registry, "replace", HarnessBuiltinNodeType.Replace, {
        keyword: "old",
        replacement: "new",
    });
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const result = await run(
        [replace, output],
        [new Edge({ nodeId: "replace", port: "text" }, { nodeId: "output", port: "text" })],
        "replace-missing-raw",
    );

    assert.equal(result.status, "failed");
    assert.ok(result.error instanceof HarnessError);
    assert.equal(result.error?.code, HarnessErrorCode.MissingValue);
    console.log("PASS Replace 缺少 raw_text 时抛出 MissingValue");
}
