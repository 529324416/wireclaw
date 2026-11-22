import { HarnessError, HarnessErrorCode } from "../base/error";
import { cloneJson, isRecord } from "../base/utils";
import { NODE_PRESET_VERSION } from "./type";
import type { NodePresetDocument } from "./type";
import { parseNodePresetDocument } from "./validate";
import { NodePresetLibrary } from "./library";

export const NODE_PRESET_LIBRARY_VERSION = 1 as const;

/** 旧版本 preset 的迁移器；fromVersion -> toVersion */
export type NodePresetMigration = {
    fromVersion: number;
    toVersion: number;
    migrate: (preset: Record<string, unknown>) => unknown;
};

export type DeserializeNodePresetOptions = {
    migrations?: readonly NodePresetMigration[];
};

export type NodePresetLibraryDocument = {
    version: number;
    presets: NodePresetDocument[];
};

/** 校验并导出单个 preset；当前只接受最新 schema */
export function serializeNodePreset(value: unknown): NodePresetDocument{
    return parseNodePresetDocument(value);
}

/** 按版本链迁移后解析 preset */
export function deserializeNodePreset(
    value: unknown,
    options: DeserializeNodePresetOptions = {},
): NodePresetDocument{
    let current = cloneJson(value);

    for (let attempt = 0; attempt < 16; attempt += 1){
        if (!isRecord(current)){
            throw new HarnessError(
                HarnessErrorCode.InvalidPreset,
                "Node preset must be an object",
            );
        }

        const version = current.version;
        if (typeof version !== "number" || !Number.isInteger(version)){
            throw new HarnessError(
                HarnessErrorCode.InvalidPreset,
                "Node preset version must be an integer",
            );
        }

        if (version === NODE_PRESET_VERSION){
            return parseNodePresetDocument(current);
        }
        if (version > NODE_PRESET_VERSION){
            throw new HarnessError(
                HarnessErrorCode.UnsupportedPresetVersion,
                `Node preset version ${String(version)} is newer than ${String(NODE_PRESET_VERSION)}`,
            );
        }

        const migration = options.migrations?.find(
            (item) => item.fromVersion === version,
        );
        if (migration === undefined){
            throw new HarnessError(
                HarnessErrorCode.UnsupportedPresetVersion,
                `No migration registered for node preset version ${String(version)}`,
            );
        }
        if (migration.toVersion <= migration.fromVersion){
            throw new HarnessError(
                HarnessErrorCode.UnsupportedPresetVersion,
                `Invalid node preset migration ${String(migration.fromVersion)} -> ${String(migration.toVersion)}`,
            );
        }

        const next = migration.migrate(cloneJson(current) as Record<string, unknown>);
        if (!isRecord(next)){
            throw new HarnessError(
                HarnessErrorCode.InvalidPreset,
                `Node preset migration ${String(migration.fromVersion)} -> ${String(migration.toVersion)} did not return an object`,
            );
        }
        if (next.version !== migration.toVersion){
            throw new HarnessError(
                HarnessErrorCode.InvalidPreset,
                `Node preset migration ${String(migration.fromVersion)} -> ${String(migration.toVersion)} `
                    + `produced version ${String(next.version)}`,
            );
        }
        current = next;
    }

    throw new HarnessError(
        HarnessErrorCode.UnsupportedPresetVersion,
        "Node preset migration chain is too long",
    );
}

/** 导出节点库为纯 JSON */
export function serializeNodePresetLibrary(
    library: NodePresetLibrary,
): NodePresetLibraryDocument{
    return {
        version: NODE_PRESET_LIBRARY_VERSION,
        presets: library.list().map((preset) => serializeNodePreset(preset)),
    };
}

/** 从纯 JSON 重建节点库 */
export function deserializeNodePresetLibrary(
    value: unknown,
    options: DeserializeNodePresetOptions = {},
): NodePresetLibrary{
    if (!isRecord(value)){
        throw new HarnessError(
            HarnessErrorCode.InvalidPreset,
            "Node preset library must be an object",
        );
    }
    if (value.version !== NODE_PRESET_LIBRARY_VERSION){
        throw new HarnessError(
            HarnessErrorCode.UnsupportedPresetVersion,
            `Unsupported node preset library version ${String(value.version)}; `
                + `expected ${String(NODE_PRESET_LIBRARY_VERSION)}`,
        );
    }
    if (!Array.isArray(value.presets)){
        throw new HarnessError(
            HarnessErrorCode.InvalidPreset,
            "Node preset library presets must be an array",
        );
    }

    const library = new NodePresetLibrary();
    for (const preset of value.presets){
        library.add(deserializeNodePreset(preset, options));
    }
    return library;
}
