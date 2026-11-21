import assert from "node:assert/strict";

import { AIProvider, ModelProvider } from "../src/session/protocol";
import type { ModelInfo } from "../src/session/protocol";
import {
    applyModelOverwrites,
    mergeModelInfo,
    parseModelOverwrite,
} from "../tools/model-overwrite";

const baseModel: ModelInfo = {
    id: "qwen4-max",
    name: "qwen4-max",
    description: "text only by default",
    size: 0,
    supportCompletion: true,
    supportToolCall: true,
    supportThink: false,
    isVisionModel: false,
    isEmbeddingModel: false,
    capabilities: {
        chat: {
            input: ["text"],
            output: ["text"],
            streaming: true,
            tools: true,
            thinking: false,
        },
    },
};

class FakeModelProvider extends ModelProvider {
    async validateNetwork(): Promise<void> {}

    protected async fetchModels(): Promise<ModelInfo[]> {
        return [baseModel];
    }
}

class FakeProvider extends AIProvider {
    private readonly _modelProvider = new FakeModelProvider();

    override get modelProvider(): FakeModelProvider {
        return this._modelProvider;
    }

    get title(): string {
        return "fake";
    }
}

/* ---------------------------------------------------------------------------
 * 1. 数组 / map 两种格式
 * ------------------------------------------------------------------------- */
{
    const arrayEntries = parseModelOverwrite([
        { id: "qwen4-max", capabilities: { chat: { input: ["text", "image"] } } },
    ]);
    assert.equal(arrayEntries.length, 1);
    assert.equal(arrayEntries[0]?.id, "qwen4-max");

    const mapEntries = parseModelOverwrite({
        "qwen4-max": { capabilities: { chat: { input: ["text", "image"] } } },
    });
    assert.equal(mapEntries.length, 1);
    assert.equal(mapEntries[0]?.id, "qwen4-max");
    console.log("PASS modelOverwrite 两种文件格式");
}

/* ---------------------------------------------------------------------------
 * 2. 递归合并：缺省字段保留初始化默认值
 * ------------------------------------------------------------------------- */
{
    const merged = mergeModelInfo(baseModel, {
        capabilities: { chat: { input: ["text", "image"], output: ["text"] } },
    });
    assert.deepEqual(merged.capabilities?.chat?.input, ["text", "image"]);
    assert.deepEqual(merged.capabilities?.chat?.output, ["text"]);
    assert.equal(merged.capabilities?.chat?.tools, true);
    assert.equal(merged.capabilities?.chat?.streaming, true);
    assert.equal(merged.name, "qwen4-max");
    console.log("PASS modelOverwrite 递归合并保留默认字段");
}

/* ---------------------------------------------------------------------------
 * 3. 只写 ModelInfo 的 isVisionModel 字段也能生效
 * ------------------------------------------------------------------------- */
{
    const provider = new FakeProvider();
    const applied = await applyModelOverwrites(provider, [{
        id: "qwen4-max",
        info: { isVisionModel: true },
    }]);
    assert.equal(applied, 1);

    const info = await provider.resolveModelInfo("qwen4-max");
    assert.deepEqual(info?.capabilities?.chat?.input, ["text", "image"]);
    assert.equal(info?.isVisionModel, true);
    assert.equal(info?.supportToolCall, true);
    console.log("PASS modelOverwrite isVisionModel 派生字段");
}

/* ---------------------------------------------------------------------------
 * 4. 应用到 Provider 后，模型能力变为可接受图片
 * ------------------------------------------------------------------------- */
{
    const provider = new FakeProvider();
    const applied = await applyModelOverwrites(provider, [{
        id: "qwen4-max",
        info: { capabilities: { chat: { input: ["text", "image"], output: ["text"] } } },
    }]);
    assert.equal(applied, 1);

    const info = await provider.resolveModelInfo("qwen4-max");
    assert.deepEqual(info?.capabilities?.chat?.input, ["text", "image"]);
    assert.equal(info?.isVisionModel, true);
    assert.equal(info?.supportToolCall, true);
    console.log("PASS modelOverwrite 应用到 Provider 后接受图片");
}

console.log("\nAll modelOverwrite checks passed.");
