import assert from "node:assert/strict";

import { ModelProvider, normalizeModelInfo } from "../src/session/protocol";
import type { ModelInfo } from "../src/session/protocol";

class FakeModelProvider extends ModelProvider {
    private readonly _models: ModelInfo[];

    constructor(models: ModelInfo[]) {
        super();
        this._models = models;
    }

    async validateNetwork(): Promise<void> {
        // no-op
    }

    protected async fetchModels(): Promise<ModelInfo[]> {
        return this._models;
    }
}

function legacyModel(): ModelInfo {
    return {
        id: "legacy",
        name: "legacy",
        description: "",
        size: 0,
        supportCompletion: true,
        supportToolCall: true,
        supportThink: true,
        isVisionModel: true,
        isEmbeddingModel: false,
    };
}

/* ---------------------------------------------------------------------------
 * 1. 传统 bool 反向合成 capabilities，bool 由 capabilities 派生
 * ------------------------------------------------------------------------- */
{
    const normalized = normalizeModelInfo(legacyModel());
    assert.deepEqual(normalized.capabilities?.chat?.input, ["text", "image"]);
    assert.equal(normalized.capabilities?.chat?.tools, true);
    assert.equal(normalized.supportToolCall, true);
    assert.equal(normalized.isVisionModel, true);

    console.log("PASS 传统 bool -> capabilities 归一化");
}

/* ---------------------------------------------------------------------------
 * 2. overwrite / overwriteMany 覆盖已加载模型并追加未知模型
 * ------------------------------------------------------------------------- */
{
    const provider = new FakeModelProvider([legacyModel()]);
    const initial = await provider.initModels();
    assert.equal(initial[0]?.isVisionModel, true);

    provider.overwrite("legacy", {
        capabilities: {
            chat: {
                input: ["text", "audio"],
                output: ["text"],
                streaming: true,
                tools: false,
            },
        },
    });
    const afterSingle = provider.availableModels ?? [];
    assert.deepEqual(afterSingle[0]?.capabilities?.chat?.input, ["text", "audio"]);
    assert.equal(afterSingle[0]?.supportToolCall, false);
    assert.equal(afterSingle[0]?.isVisionModel, false);

    provider.overwriteMany([
        {
            id: "new-model",
            info: {
                name: "new-model",
                capabilities: {
                    chat: {
                        input: ["text", "image"],
                        output: ["text"],
                        streaming: true,
                        tools: true,
                    },
                },
            },
        },
    ]);
    const models = provider.availableModels ?? [];
    assert.equal(models.some((model) => model.id === "new-model"), true);
    assert.equal(models.length, 2);

    console.log("PASS overwrite / overwriteMany 合并与追加");
}

/* ---------------------------------------------------------------------------
 * 3. generate 输出模态 -> bool 派生
 * ------------------------------------------------------------------------- */
{
    const normalized = normalizeModelInfo({
        id: "image-model",
        name: "image-model",
        description: "",
        size: 0,
        supportCompletion: false,
        supportToolCall: false,
        supportThink: false,
        isVisionModel: false,
        isEmbeddingModel: false,
        capabilities: {
            generate: {
                input: ["text"],
                output: ["image"],
                async: false,
            },
        },
    });

    assert.equal(normalized.capabilities?.generate?.image, true);
    assert.equal(normalized.capabilities?.generate?.audio, false);
    assert.equal(normalized.capabilities?.generate?.video, false);

    console.log("PASS generate output -> 派生 bool");
}

console.log("\nAll model capability checks passed.");
