import assert from "node:assert/strict";

import {
    Edge,
    Graph,
    HarnessBuiltinNodeType,
    createBuiltinNodeRegistry,
    describeNodeType,
    isHarnessValue,
    isHarnessValueCompatible,
} from "../src/harness";
import type { NodeContext } from "../src/harness";

function section(title: string): void{
    console.log(`\n=== ${title} ===`);
}

const registry = createBuiltinNodeRegistry();
const context = {} as NodeContext;

section("Provider 节点输出 provider 引用");
const providerDefinition = registry.require(HarnessBuiltinNodeType.Provider);
const providerEntry = describeNodeType(
    registry,
    HarnessBuiltinNodeType.Provider,
);
const providerNode = providerDefinition.create(
    "provider",
    { providerId: "deepseek-main" },
    {},
    undefined,
);
const providerOutput = await providerNode.execute(context, {});
assert.deepEqual(providerOutput.provider, {
    type: "provider",
    provider: { providerId: "deepseek-main" },
});
assert.equal(providerEntry.inputs.length, 0);
assert.equal(providerEntry.outputs[0]?.type, "provider");

section("Model 节点消费 provider 输入并优先于 config");
const modelDefinition = registry.require(HarnessBuiltinNodeType.Model);
const modelEntry = describeNodeType(registry, HarnessBuiltinNodeType.Model);
const modelNode = modelDefinition.create(
    "model",
    { providerId: "config-provider", modelId: "deepseek-chat" },
    {},
    undefined,
);
const modelOutput = await modelNode.execute(context, {
    provider: providerOutput.provider!,
});
assert.deepEqual(modelOutput.model, {
    type: "model",
    model: { providerId: "deepseek-main", modelId: "deepseek-chat" },
});
assert.equal(modelEntry.inputs[0]?.name, "provider");
assert.equal(modelEntry.inputs[0]?.required ?? false, false);

section("Model 节点无 provider 连接时回退 config");
const fallbackNode = modelDefinition.create(
    "model-fallback",
    { providerId: "from-config", modelId: "qwen-plus" },
    {},
    undefined,
);
const fallbackOutput = await fallbackNode.execute(context, {});
assert.deepEqual(fallbackOutput.model, {
    type: "model",
    model: { providerId: "from-config", modelId: "qwen-plus" },
});

section("Provider -> Model 连线通过图校验");
const connectedGraph = new Graph(
    [
        providerDefinition.create(
            "provider",
            { providerId: "deepseek-main" },
            {},
            undefined,
        ),
        modelDefinition.create(
            "model",
            { modelId: "deepseek-chat" },
            {},
            undefined,
        ),
    ],
    [
        new Edge(
            { nodeId: "provider", port: "provider" },
            { nodeId: "model", port: "provider" },
        ),
    ],
);
assert.deepEqual(connectedGraph.validate(), []);

section("provider 值类型校验与端口兼容");
const providerValue = {
    type: "provider" as const,
    provider: { providerId: "p" },
};
assert.equal(isHarnessValue(providerValue), true);
assert.equal(isHarnessValueCompatible("provider", providerValue), true);
assert.equal(isHarnessValueCompatible("model", providerValue), false);

section("编辑器目录包含 Provider，Model 只要求 modelId");
assert.equal(providerEntry.title, "Provider");
assert.equal(providerEntry.outputs[0]?.type, "provider");

assert.deepEqual(modelEntry.requirements, []);
const required = modelEntry.configSchema?.required;
assert.deepEqual(required, ["modelId"]);

console.log("\nAll provider binding checks passed.");
