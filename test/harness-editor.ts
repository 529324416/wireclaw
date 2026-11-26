import assert from "node:assert/strict";

import {
    GraphNode,
    HarnessBuiltinNodeType,
    NodePresetLibrary,
    createBuiltinNodeRegistry,
    createEditorCatalog,
    describeNodeType,
    describeNodeTypes,
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

class DynamicNode extends GraphNode{

    override readonly type: string = "test.dynamic";

    override get inputs(): readonly InputPortSpec[]{
        const count = typeof this.config === "object"
            && this.config !== null
            && !Array.isArray(this.config)
            ? Number(this.config.count ?? 0)
            : 0;
        return Array.from({ length: count }, (_value, index) => ({
            name: `in${String(index)}`,
            type: "text",
            required: true,
        }));
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

class RequiresNode extends DynamicNode{

    override readonly type = "test.requires";
}

section("内建节点目录");
{
    const registry = createBuiltinNodeRegistry();
    const catalog = createEditorCatalog(registry);

    assert.equal(catalog.version, 2);
    assert.equal(catalog.presets.length, 0);

    const call = catalog.nodeTypes.find(
        (entry) => entry.type === HarnessBuiltinNodeType.ModelCall,
    );
    assert.ok(call !== undefined);
    assert.ok(call.inputs.some((port) => port.name === "model"));
    assert.ok(call.inputs.some((port) => port.name === "prompt"));
    assert.ok(call.outputs.some((port) => port.name === "text"));
    assert.equal(call.error, undefined);
    assert.equal(call.category, "model");
    assert.ok(call.configSchema !== undefined);
    assert.ok(call.keywords?.includes("模型调用") === true);
    assert.deepEqual(call.defaultConfig, { mode: "chat" });

    const input = catalog.nodeTypes.find(
        (entry) => entry.type === HarnessBuiltinNodeType.Input,
    );
    assert.ok(input !== undefined);
    assert.equal(input.inputs.length, 0);
    assert.ok(input.outputs.some((port) => port.name === "text"));
    assert.equal(input.configSchema, undefined);
    assert.equal(input.category, "io");

    assert.ok(catalog.nodeTypes.some((entry) => entry.type === HarnessBuiltinNodeType.ToolSet));
    assert.ok(catalog.nodeTypes.some((entry) => entry.type === HarnessBuiltinNodeType.EventTrigger));

    const withSchema = catalog.nodeTypes.filter((entry) => entry.configSchema !== undefined);
    assert.equal(withSchema.length, 12);
    assert.ok(catalog.nodeTypes.some((entry) => entry.type === HarnessBuiltinNodeType.Provider));
    assert.ok(catalog.nodeTypes.every((entry) => entry.category !== undefined));
    const constant = catalog.nodeTypes.find(
        (entry) => entry.type === HarnessBuiltinNodeType.Constant,
    );
    assert.deepEqual(constant?.defaultConfig, {
        value: { type: "text", text: "" },
    });
    console.log("PASS 内建节点目录包含端口、configSchema、默认 config 与分类");
}

section("动态端口与错误隔离");
{
    const registry = createBuiltinNodeRegistry();
    registry.register({
        type: "test.dynamic",
        version: 1,
        title: "Dynamic",
        create: (id, config, inputs, ui) => new DynamicNode(id, config, inputs, ui),
    });
    registry.register({
        type: "test.bad",
        version: 1,
        title: "Bad",
        create: () =>{
            throw new Error("cannot create with default config");
        },
    });

    const dynamic = describeNodeType(registry, "test.dynamic", {
        config: { count: 3 },
    });
    assert.equal(dynamic.inputs.length, 3);
    assert.equal(dynamic.outputs.length, 1);

    const catalog = createEditorCatalog(registry, {
        configs: { "test.dynamic": { count: 2 } },
    });
    const dynamicEntry = catalog.nodeTypes.find((entry) => entry.type === "test.dynamic");
    assert.equal(dynamicEntry?.inputs.length, 2);

    const bad = catalog.nodeTypes.find((entry) => entry.type === "test.bad");
    assert.ok(bad?.error?.includes("cannot create"));
    assert.deepEqual(bad?.inputs, []);

    assert.throws(() => describeNodeType(registry, "test.bad"), /cannot create/);

    registry.register({
        type: "test.requires",
        version: 1,
        title: "Requires",
        requirements: [{ kind: "provider", providerId: "deepseek" }],
        create: (id, config, inputs, ui) => new RequiresNode(id, config, inputs, ui),
    });
    const requires = describeNodeType(registry, "test.requires");
    assert.deepEqual(requires.requirements, [
        { kind: "provider", providerId: "deepseek" },
    ]);
    console.log("PASS 动态端口按 config 生成，坏类型不阻断整个目录，静态依赖不丢失");
}

section("预设进入编辑器目录");
{
    const registry = createBuiltinNodeRegistry();
    const library = new NodePresetLibrary();
    library.add({
        version: 1,
        presetId: "editor-preset",
        name: "Editor Preset",
        type: HarnessBuiltinNodeType.Constant,
        typeVersion: 1,
        config: { value: { type: "text", text: "editor" } },
    });

    const catalog = createEditorCatalog(registry, { presets: library });
    assert.equal(catalog.presets.length, 1);
    assert.equal(catalog.presets[0]?.presetId, "editor-preset");

    const entries = describeNodeTypes(registry);
    assert.equal(entries.length, registry.list().length);
    console.log("PASS 预设列表与节点类型目录可同时提供给 GraphEditor");
}

console.log("\nAll harness editor catalog checks passed.");
