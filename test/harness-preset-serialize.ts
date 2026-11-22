import assert from "node:assert/strict";

import {
    HarnessBuiltinNodeType,
    HarnessError,
    HarnessErrorCode,
    NodePresetLibrary,
    deserializeNodePreset,
    deserializeNodePresetLibrary,
    serializeNodePreset,
    serializeNodePresetLibrary,
} from "../src/harness";
import type { NodePresetDocument } from "../src/harness";

function section(title: string): void{
    console.log(`\n=== ${title} ===`);
}

const preset: NodePresetDocument = {
    version: 1,
    presetId: "const-preset",
    name: "Const Preset",
    description: "constant preset",
    type: HarnessBuiltinNodeType.Constant,
    typeVersion: 1,
    config: { value: { type: "text", text: "hello" } },
    parameters: [{ name: "value", path: "value", default: { type: "text", text: "hello" } }],
    requires: [{ kind: "tool", name: "tools__echo" }],
    tags: ["built-in"],
};

function expectCode(operation: () => unknown, code: HarnessErrorCode): void{
    assert.throws(operation, (error: unknown) =>
        error instanceof HarnessError && error.code === code);
}

section("单个 preset 往返");
{
    const serialized = serializeNodePreset(preset);
    assert.deepEqual(serialized, preset);
    assert.deepEqual(deserializeNodePreset(preset), preset);
    console.log("PASS serializeNodePreset / deserializeNodePreset");
}

section("preset 版本迁移");
{
    const legacy = {
        version: 0,
        presetId: "legacy-preset",
        name: "Legacy",
        type: HarnessBuiltinNodeType.Constant,
        typeVersion: 1,
        config: { value: { type: "text", text: "legacy" } },
    };

    expectCode(
        () => deserializeNodePreset(legacy),
        HarnessErrorCode.UnsupportedPresetVersion,
    );

    const migrated = deserializeNodePreset(legacy, {
        migrations: [{
            fromVersion: 0,
            toVersion: 1,
            migrate: (value) => ({
                ...value,
                version: 1,
                tags: ["migrated"],
            }),
        }],
    });
    assert.equal(migrated.version, 1);
    assert.deepEqual(migrated.tags, ["migrated"]);

    expectCode(
        () => deserializeNodePreset(legacy, {
            migrations: [{
                fromVersion: 0,
                toVersion: 1,
                migrate: (value) => ({ ...value, version: 2 }),
            }],
        }),
        HarnessErrorCode.InvalidPreset,
    );
    console.log("PASS 旧版本迁移链与非法迁移结果");
}

section("节点库导出/导入");
{
    const library = new NodePresetLibrary();
    library.add(preset);
    library.add({
        ...preset,
        presetId: "const-preset-2",
        name: "Const Preset 2",
    });

    const document = serializeNodePresetLibrary(library);
    assert.equal(document.version, 1);
    assert.equal(document.presets.length, 2);

    const loaded = deserializeNodePresetLibrary(document);
    assert.deepEqual(loaded.list(), library.list());

    expectCode(
        () => deserializeNodePresetLibrary({
            version: 1,
            presets: [preset, preset],
        }),
        HarnessErrorCode.InvalidPreset,
    );
    expectCode(
        () => deserializeNodePresetLibrary({ version: 99, presets: [] }),
        HarnessErrorCode.UnsupportedPresetVersion,
    );
    console.log("PASS 节点库 JSON 往返、重复 preset 与库版本错误");
}
