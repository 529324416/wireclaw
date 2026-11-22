import assert from "node:assert/strict";

import {
    Edge,
    Graph,
    HarnessBuiltinNodeType,
    HarnessError,
    HarnessErrorCode,
    NodePresetLibrary,
    createBuiltinNodeRegistry,
    instantiateNodePreset,
} from "../src/harness";
import type { NodePresetDocument } from "../src/harness";
import { ToolRegistry } from "../src/session/tool";
import type { ToolProvider } from "../src/session/tool";
import type { ToolCall, ToolCallResult, ToolDefinition } from "../src/session/type";

function section(title: string): void{
    console.log(`\n=== ${title} ===`);
}

class EchoToolProvider implements ToolProvider{

    readonly id = "tools";
    readonly name = "tools";
    readonly description = "echo tool";

    async fetchTools(): Promise<ToolDefinition[]>{
        return [{
            name: "echo",
            description: "echo",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
        }];
    }

    async call(call: ToolCall): Promise<ToolCallResult>{
        return {
            content: `echo:${call.name}`,
            status: { isSuccess: true, duration: 0 },
        };
    }
}

function echoRegistry(): ToolRegistry{
    const registry = new ToolRegistry();
    registry.registerProvider(new EchoToolProvider());
    return registry;
}

const preset: NodePresetDocument = {
    version: 1,
    presetId: "const-echo",
    name: "Const Echo",
    description: "constant with a tool dependency",
    type: HarnessBuiltinNodeType.Constant,
    typeVersion: 1,
    config: {
        value: { type: "text", text: "preset" },
        options: { limit: 1 },
    },
    parameters: [
        {
            name: "value",
            path: "value",
            required: true,
            default: { type: "text", text: "preset" },
        },
        {
            name: "limit",
            path: "options.limit",
            default: 1,
        },
    ],
    requires: [{ kind: "tool", name: "tools__echo" }],
    tags: ["test"],
};

function expectHarnessError(
    operation: () => unknown,
    code: HarnessErrorCode,
): HarnessError{
    try{
        operation();
    }catch(error){
        assert.ok(error instanceof HarnessError, "expected HarnessError");
        assert.equal(error.code, code);
        return error;
    }
    assert.fail(`expected ${code}`);
}

section("预设实例化与参数覆盖");
{
    const registry = createBuiltinNodeRegistry();
    const node = instantiateNodePreset(preset, {
        registry,
        id: "const-node",
        parameters: { value: { type: "text", text: "override" }, limit: 5 },
    });

    assert.equal(node.id, "const-node");
    assert.deepEqual(node.config, {
        value: { type: "text", text: "override" },
        options: { limit: 5 },
    });
    assert.deepEqual(node.requirements, [{ kind: "tool", name: "tools__echo" }]);

    expectHarnessError(
        () => instantiateNodePreset({
            ...preset,
            parameters: [{ name: "value", path: "value", required: true }],
        }, { registry, id: "missing-param" }),
        HarnessErrorCode.MissingParameterDependency,
    );
    expectHarnessError(
        () => instantiateNodePreset(preset, {
            registry,
            id: "unknown-param",
            parameters: { unknown: 1 },
        }),
        HarnessErrorCode.InvalidPreset,
    );
    console.log("PASS config 参数按点路径覆盖，缺失/未知参数报错");
}

section("实例化阶段的工具依赖");
{
    const registry = createBuiltinNodeRegistry();
    const ok = instantiateNodePreset(preset, {
        registry,
        id: "with-tool",
        available: { tools: ["tools__echo"] },
    });
    assert.deepEqual(ok.requirements, [{ kind: "tool", name: "tools__echo" }]);

    const error = expectHarnessError(
        () => instantiateNodePreset(preset, {
            registry,
            id: "without-tool",
            available: { tools: [] },
        }),
        HarnessErrorCode.MissingToolDependency,
    );
    assert.equal(error.nodeId, "without-tool");
    console.log("PASS 工具缺失在 instantiate 阶段失败并带 nodeId");
}

section("节点库");
{
    const registry = createBuiltinNodeRegistry();
    const library = new NodePresetLibrary();
    const added = library.add(preset);
    assert.equal(added.presetId, "const-echo");
    assert.deepEqual(library.list().map((item) => item.presetId), ["const-echo"]);
    assert.deepEqual(library.get("const-echo"), preset);

    const node = library.instantiate("const-echo", {
        registry,
        id: "library-node",
        available: { tools: ["tools__echo"] },
    });
    assert.equal(node.id, "library-node");

    expectHarnessError(() => library.add(preset), HarnessErrorCode.InvalidPreset);
    expectHarnessError(
        () => library.instantiate("missing", { registry, id: "missing" }),
        HarnessErrorCode.InvalidPreset,
    );
    assert.equal(library.remove("const-echo"), true);
    assert.equal(library.get("const-echo"), undefined);
    console.log("PASS 节点库 add/get/list/instantiate/remove 与重复报错");
}

section("Graph 校验、序列化与运行前检查");
{
    const registry = createBuiltinNodeRegistry();
    const constNode = instantiateNodePreset(preset, {
        registry,
        id: "const",
        available: { tools: ["tools__echo"] },
    });
    const output = registry.createNode({
        id: "output",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });
    const graph = new Graph([constNode, output], [
        new Edge({ nodeId: "const", port: "value" }, { nodeId: "output", port: "text" }),
    ], { id: "preset-graph" });

    assert.equal(
        graph.validate({ requirements: { tools: ["tools__echo"] } }).length,
        0,
    );
    const issues = graph.validate({ requirements: { tools: [] } });
    assert.ok(issues.some((issue) =>
        issue.code === HarnessErrorCode.MissingToolDependency
        && issue.nodeId === "const"));

    const document = graph.toJSON();
    assert.deepEqual(document.nodes.find((node) => node.id === "const")?.requires, [
        { kind: "tool", name: "tools__echo" },
    ]);

    const loaded = Graph.fromJSON(document, {
        registry,
        requirements: { tools: ["tools__echo"] },
    });
    assert.deepEqual(loaded.getNode("const")?.requirements, [
        { kind: "tool", name: "tools__echo" },
    ]);

    const missing = expectHarnessError(
        () => Graph.fromJSON(document, {
            registry,
            requirements: { tools: [] },
        }),
        HarnessErrorCode.InvalidGraph,
    );
    assert.equal(missing.issues?.[0]?.code, HarnessErrorCode.MissingToolDependency);

    const run = await graph.run({
        host: {
            resolveProvider: () => undefined,
            tools: echoRegistry(),
        },
    }).done;
    assert.equal(run.status, "completed");
    const text = run.outputs.text;
    assert.equal(text?.type, "text");
    if (text?.type === "text") assert.equal(text.text, "preset");

    const failed = await graph.run({
        host: {
            resolveProvider: () => undefined,
            tools: new ToolRegistry(),
        },
    }).done;
    assert.equal(failed.status, "failed");
    assert.ok(failed.error instanceof HarnessError);
    assert.equal(failed.error.code, HarnessErrorCode.MissingToolDependency);
    console.log("PASS Graph.validate / JSON requires / run 启动前工具检查");
}

section("Provider 与 Parameter 依赖");
{
    const registry = createBuiltinNodeRegistry();
    const providerPreset: NodePresetDocument = {
        ...preset,
        presetId: "provider-preset",
        requires: [{ kind: "provider", providerId: "missing-provider" }],
    };
    const node = instantiateNodePreset(providerPreset, { registry, id: "provider-node" });
    const output = registry.createNode({
        id: "output",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });
    const graph = new Graph([node, output], [
        new Edge({ nodeId: "provider-node", port: "value" }, { nodeId: "output", port: "text" }),
    ], { id: "provider-graph" });

    const failed = await graph.run({
        host: { resolveProvider: () => undefined },
    }).done;
    assert.equal(failed.status, "failed");
    assert.ok(failed.error instanceof HarnessError);
    assert.equal(failed.error.code, HarnessErrorCode.MissingProviderDependency);

    const parameterPreset: NodePresetDocument = {
        ...preset,
        presetId: "parameter-preset",
        requires: [{ kind: "parameter", name: "apiKey" }],
    };
    const parameterNode = instantiateNodePreset(parameterPreset, {
        registry,
        id: "parameter-node",
    });
    const parameterGraph = new Graph([parameterNode, output], [
        new Edge({ nodeId: "parameter-node", port: "value" }, { nodeId: "output", port: "text" }),
    ], { id: "parameter-graph" });

    const parameterFailed = await parameterGraph.run({
        host: { resolveProvider: () => undefined },
    }).done;
    assert.equal(parameterFailed.status, "failed");
    assert.ok(parameterFailed.error instanceof HarnessError);
    assert.equal(parameterFailed.error.code, HarnessErrorCode.MissingParameterDependency);
    console.log("PASS provider / parameter 依赖在 run 启动前失败");
}

console.log("\nAll harness preset checks passed.");
