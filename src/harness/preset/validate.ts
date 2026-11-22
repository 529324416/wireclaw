import { isJsonSafe } from "../../base";
import { HarnessError, HarnessErrorCode } from "../base/error";
import { cloneJson, isRecord } from "../base/utils";
import { isHarnessValue, isNodeRequirement } from "../graph/type";
import type {
    JsonObject,
    JsonValue,
    NodeInputValues,
    NodeRequirement,
} from "../graph/type";
import { NODE_PRESET_VERSION } from "./type";
import type {
    NodePresetDocument,
    NodePresetParameter,
} from "./type";

/** 解析并校验节点库条目；返回深拷贝，调用方不能反向修改原对象 */
export function parseNodePresetDocument(value: unknown): NodePresetDocument{
    if (!isRecord(value)){
        throw invalidPreset("Node preset must be an object");
    }

    if (value.version !== NODE_PRESET_VERSION){
        throw invalidPreset(
            `Unsupported node preset version ${String(value.version)}; expected ${String(NODE_PRESET_VERSION)}`,
        );
    }

    const preset: NodePresetDocument = {
        version: NODE_PRESET_VERSION,
        presetId: readNonEmptyString(value.presetId, "presetId"),
        name: readNonEmptyString(value.name, "name"),
        type: readNonEmptyString(value.type, "type"),
        typeVersion: readPositiveInteger(value.typeVersion, "typeVersion"),
    };

    if (value.description !== undefined){
        preset.description = readString(value.description, "description");
    }
    if (value.config !== undefined){
        if (!isJsonSafe(value.config)){
            throw invalidPreset("config must be JSON-safe");
        }
        preset.config = cloneJson(value.config) as JsonValue;
    }
    if (value.inputs !== undefined){
        if (!isRecord(value.inputs)){
            throw invalidPreset("inputs must be an object");
        }

        const inputs: Record<string, unknown> = {};
        for (const [name, item] of Object.entries(value.inputs)){
            if (!isHarnessValue(item)){
                throw invalidPreset(`inputs.${name} is not a valid HarnessValue`);
            }
            inputs[name] = cloneJson(item);
        }
        preset.inputs = inputs as NodeInputValues;
    }
    if (value.ui !== undefined){
        preset.ui = readJsonObject(value.ui, "ui");
    }
    if (value.parameters !== undefined){
        preset.parameters = readArray(value.parameters, "parameters")
            .map(parseParameter);
        validateUniqueParameters(preset.parameters);
    }
    if (value.requires !== undefined){
        preset.requires = readArray(value.requires, "requires")
            .map((requirement, index) =>{
                if (!isNodeRequirement(requirement)){
                    throw invalidPreset(`requires[${String(index)}] is not a valid NodeRequirement`);
                }
                return cloneJson(requirement) as NodeRequirement;
            });
    }
    if (value.tags !== undefined){
        preset.tags = readArray(value.tags, "tags").map((tag, index) =>{
            if (typeof tag !== "string"){
                throw invalidPreset(`tags[${String(index)}] must be a string`);
            }
            return tag;
        });
    }

    return preset;
}

/**
 * 把实例化参数写入预设 config。
 *
 * @note 只接受 preset.parameters 中声明的参数名；未声明的键会报错，避免拼写错误静默生效。
 */
export function applyPresetParameters(
    preset: NodePresetDocument,
    values: Readonly<Record<string, JsonValue>> = {},
): JsonValue | undefined{
    const parameters = preset.parameters ?? [];
    const declared = new Set(parameters.map((parameter) => parameter.name));

    for (const name of Object.keys(values)){
        if (!declared.has(name)){
            throw invalidPreset(`Unknown preset parameter "${name}"`);
        }
    }

    if (parameters.length === 0 && Object.keys(values).length === 0){
        return preset.config === undefined
            ? undefined
            : cloneJson(preset.config);
    }

    const config: unknown = preset.config === undefined ? {} : cloneJson(preset.config);
    if (!isRecord(config)){
        throw invalidPreset("Preset parameters require config to be an object");
    }

    for (const parameter of parameters){
        const value = values[parameter.name] ?? parameter.default;
        if (value === undefined){
            if (parameter.required === true){
                throw new HarnessError(
                    HarnessErrorCode.MissingParameterDependency,
                    `Preset "${preset.presetId}" requires parameter "${parameter.name}"`,
                );
            }
            continue;
        }

        setPath(config, parameter.path, value);
    }

    return config as JsonValue;
}

function parseParameter(value: unknown, index: number): NodePresetParameter{
    const field = `parameters[${String(index)}]`;
    if (!isRecord(value)){
        throw invalidPreset(`${field} must be an object`);
    }

    const parameter: NodePresetParameter = {
        name: readNonEmptyString(value.name, `${field}.name`),
        path: readNonEmptyString(value.path, `${field}.path`),
    };

    if (value.required !== undefined){
        parameter.required = readBoolean(value.required, `${field}.required`);
    }
    if (value.description !== undefined){
        parameter.description = readString(value.description, `${field}.description`);
    }
    if (value.default !== undefined){
        if (!isJsonSafe(value.default)){
            throw invalidPreset(`${field}.default must be JSON-safe`);
        }
        parameter.default = cloneJson(value.default) as JsonValue;
    }

    return parameter;
}

function validateUniqueParameters(parameters: readonly NodePresetParameter[]): void{
    const names = new Set<string>();
    const paths = new Set<string>();

    for (const parameter of parameters){
        if (names.has(parameter.name)){
            throw invalidPreset(`Duplicate preset parameter name "${parameter.name}"`);
        }
        if (paths.has(parameter.path)){
            throw invalidPreset(`Duplicate preset parameter path "${parameter.path}"`);
        }
        names.add(parameter.name);
        paths.add(parameter.path);
    }
}

function setPath(
    root: Record<string, unknown>,
    path: string,
    value: JsonValue,
): void{
    const segments = path.split(".");
    if (segments.some((segment) => segment.length === 0)){
        throw invalidPreset(`Invalid preset parameter path "${path}"`);
    }

    let cursor = root;
    for (const segment of segments.slice(0, -1)){
        const next = cursor[segment];
        if (next === undefined){
            const created: Record<string, unknown> = {};
            cursor[segment] = created;
            cursor = created;
            continue;
        }
        if (!isRecord(next)){
            throw invalidPreset(`Preset parameter path "${path}" hits a non-object value`);
        }
        cursor = next;
    }

    cursor[segments[segments.length - 1]] = cloneJson(value);
}

function readArray(value: unknown, field: string): readonly unknown[]{
    if (!Array.isArray(value)){
        throw invalidPreset(`${field} must be an array`);
    }
    return value;
}

function readNonEmptyString(value: unknown, field: string): string{
    const text = readString(value, field);
    if (text.length === 0){
        throw invalidPreset(`${field} must be a non-empty string`);
    }
    return text;
}

function readString(value: unknown, field: string): string{
    if (typeof value !== "string"){
        throw invalidPreset(`${field} must be a string`);
    }
    return value;
}

function readBoolean(value: unknown, field: string): boolean{
    if (typeof value !== "boolean"){
        throw invalidPreset(`${field} must be a boolean`);
    }
    return value;
}

function readPositiveInteger(value: unknown, field: string): number{
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1){
        throw invalidPreset(`${field} must be a positive integer`);
    }
    return value;
}

function readJsonObject(value: unknown, field: string): JsonObject{
    if (!isRecord(value) || !isJsonSafe(value)){
        throw invalidPreset(`${field} must be a JSON-safe object`);
    }
    return cloneJson(value) as JsonObject;
}

function invalidPreset(message: string): HarnessError{
    return new HarnessError(HarnessErrorCode.InvalidPreset, message);
}
