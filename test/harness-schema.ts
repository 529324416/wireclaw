import assert from "node:assert/strict";

import {
    HarnessBuiltinNodeType,
    createBuiltinNodeRegistry,
    createEditorCatalog,
    defaultConfigFromSchema,
    describeNodeType,
    validateNodeConfig,
} from "../src/harness";
import type { JsonValue } from "../src/harness";

function section(title: string): void{
    console.log(`\n=== ${title} ===`);
}

const registry = createBuiltinNodeRegistry();

function issuesOf(type: string, config: unknown){
    const entry = describeNodeType(registry, type);
    assert.ok(entry.configSchema !== undefined, `${type} should have a config schema`);
    return validateNodeConfig(entry.configSchema, config as JsonValue);
}

section("默认 config 通过自身 schema");
{
    const catalog = createEditorCatalog(registry);
    for (const entry of catalog.nodeTypes){
        if (entry.configSchema === undefined){
            continue;
        }
        const result = validateNodeConfig(entry.configSchema, entry.defaultConfig);
        assert.deepEqual(
            result.issues,
            [],
            `${entry.type} 的默认 config 不符合自己的 schema`,
        );
    }
    console.log("PASS 11 个带 schema 的内建节点默认 config 均通过校验");
}

section("必填、类型与枚举");
{
    const constant = issuesOf(HarnessBuiltinNodeType.Constant, {});
    assert.ok(constant.issues.some((issue) => issue.path === "value" && issue.message === "必填"));

    const constantType = issuesOf(HarnessBuiltinNodeType.Constant, { value: "text" });
    assert.ok(constantType.issues.some((issue) => issue.path === "value"));

    const call = issuesOf(HarnessBuiltinNodeType.ModelCall, {
        mode: "stream",
        temperature: 9,
    });
    assert.ok(call.issues.some((issue) => issue.path === "mode"));
    assert.ok(call.issues.some((issue) => issue.path === "temperature"));

    const agent = issuesOf(HarnessBuiltinNodeType.AgentRun, {
        permission: "root",
        maxSteps: 0,
    });
    assert.ok(agent.issues.some((issue) => issue.path === "permission"));
    assert.ok(agent.issues.some((issue) => issue.path === "maxSteps"));

    const loop = issuesOf(HarnessBuiltinNodeType.Loop, { maxIterations: 1.5 });
    assert.ok(loop.issues.some((issue) => issue.path === "graph"));
    assert.ok(loop.issues.some((issue) => issue.path === "maxIterations"));

    console.log("PASS 必填、枚举、数值范围与整数约束生效");
}

section("数组与嵌套对象");
{
    const toolset = issuesOf(HarnessBuiltinNodeType.ToolSet, {
        include: ["search"],
        exclude: "shell",
    });
    assert.ok(toolset.issues.some((issue) => issue.path === "exclude"));

    const items = issuesOf(HarnessBuiltinNodeType.ToolSet, {
        include: ["search", 1],
    });
    assert.ok(items.issues.some((issue) => issue.path === "include[1]"));

    const model = issuesOf(HarnessBuiltinNodeType.Model, {
        providerId: "deepseek",
        modelId: "",
    });
    assert.deepEqual(model.issues, []);
    console.log("PASS 数组 items 与对象属性校验生效");
}

section("schema 默认值收集");
{
    const defaults = defaultConfigFromSchema({
        type: "object",
        properties: {
            mode: { type: "string", default: "chat" },
            nested: {
                type: "object",
                properties: {
                    level: { type: "string", default: "info" },
                },
            },
            optional: { type: "string" },
        },
    });
    assert.deepEqual(defaults, { mode: "chat", nested: { level: "info" } });

    assert.equal(defaultConfigFromSchema({ type: "object", properties: {} }), undefined);
    assert.equal(defaultConfigFromSchema({ type: "string" }), undefined);
    console.log("PASS 可从 schema 收集嵌套默认值");
}

section("无法表达的 schema 放行");
{
    const result = validateNodeConfig({
        type: "object",
        properties: {
            payload: { oneOf: [{ type: "string" }, { type: "number" }] },
        },
    }, { payload: true });
    assert.deepEqual(result.issues, []);
    assert.equal(result.ok, true);
    console.log("PASS 未支持的 schema 关键字不误报");
}

console.log("\nAll harness schema checks passed.");
