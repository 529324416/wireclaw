import { isRecord } from "../base/utils";
import type { JsonObject, JsonValue } from "../graph/type";

/**
 * 节点 configSchema 的受支持子集。
 *
 * wireclaw 不引入 JSON Schema 实现；设计器只需要「够生成表单 + 够做基础校验」：
 *
 * - `type`: object / string / number / integer / boolean / array / null（也接受类型数组）
 * - `title` / `description`：表单标签与说明
 * - `default`：字段默认值（编辑器用于预填）
 * - `enum` / `enumLabels`：下拉选项与显示名
 * - `required`（object 级）：必填字段名
 * - `properties`：对象字段（可递归）
 * - `items`：数组元素 schema
 * - `minimum` / `maximum`、`minLength` / `maxLength`、`minItems` / `maxItems`
 * - `format`：编辑器提示。`"json"` / `"graph"` 表示该字段用 JSON 文本域兜底
 *
 * 其他关键字（oneOf / $ref / anyOf …）不参与校验，编辑器遇到无法表达的
 * schema 时回退到原始 JSON 编辑。
 */
export type NodeConfigIssue = {
    /** 相对 config 的路径；根为空字符串 */
    path: string;
    message: string;
};

export type NodeConfigValidation = {
    issues: readonly NodeConfigIssue[];
    /** config 是否可作为对象使用（undefined 视为空对象） */
    ok: boolean;
};

/** 校验节点 config 是否符合受支持子集；无法识别的 schema 直接放行。 */
export function validateNodeConfig(
    schema: JsonObject | undefined,
    config: JsonValue | undefined,
): NodeConfigValidation{
    if (schema === undefined){
        return { issues: [], ok: true };
    }

    const issues: NodeConfigIssue[] = [];
    const value: JsonValue = config === undefined ? {} : config;
    validateValue(schema, value, "", issues);
    return { issues, ok: issues.length === 0 };
}

/**
 * 从 schema 的 `default` 收集初始 config。
 *
 * 只处理 object/properties 与嵌套 object；数组与其他复杂类型不自动生成。
 * 没有任何默认值时返回 undefined。
 */
export function defaultConfigFromSchema(
    schema: JsonObject | undefined,
): JsonObject | undefined{
    if (schema === undefined){
        return undefined;
    }

    const defaults = collectDefaults(schema);
    return defaults === undefined || Object.keys(defaults).length === 0
        ? undefined
        : defaults;
}

function collectDefaults(schema: JsonObject): JsonObject | undefined{
    if (schema.default !== undefined && isRecord(schema.default)){
        return schema.default as JsonObject;
    }

    const type = readTypes(schema);
    if (type !== undefined && !type.includes("object")){
        return undefined;
    }

    const properties = toSchemaRecord(schema.properties);
    if (properties === undefined){
        return undefined;
    }

    const result: Record<string, JsonValue> = {};
    for (const [key, raw] of Object.entries(properties)){
        const property = toSchema(raw);
        if (property === undefined){
            continue;
        }
        if (property.default !== undefined){
            result[key] = property.default;
            continue;
        }
        if (readTypes(property)?.includes("object") === true){
            const nested = collectDefaults(property);
            if (nested !== undefined){
                result[key] = nested;
            }
        }
    }

    return result;
}

function validateValue(
    schema: JsonObject,
    value: JsonValue,
    path: string,
    issues: NodeConfigIssue[],
): void{
    const types = readTypes(schema);

    if (types !== undefined && !matchesAnyType(types, value)){
        issues.push({
            path,
            message: `应为 ${types.join(" / ")}，实际是 ${describeType(value)}`,
        });
        return;
    }

    if (schema.enum !== undefined){
        if (!Array.isArray(schema.enum) || !schema.enum.some((item) => jsonEquals(item, value))){
            issues.push({
                path,
                message: `必须是以下值之一：${formatEnum(schema.enum)}`,
            });
            return;
        }
    }

    if (typeof value === "string"){
        validateString(schema, value, path, issues);
        return;
    }

    if (typeof value === "number"){
        validateNumber(schema, value, path, issues);
        return;
    }

    if (Array.isArray(value)){
        validateArray(schema, value, path, issues);
        return;
    }

    if (isRecord(value)){
        validateObject(schema, value as JsonObject, path, issues);
    }
}

function validateString(
    schema: JsonObject,
    value: string,
    path: string,
    issues: NodeConfigIssue[],
): void{
    if (typeof schema.minLength === "number" && value.length < schema.minLength){
        issues.push({ path, message: `至少需要 ${String(schema.minLength)} 个字符` });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength){
        issues.push({ path, message: `最多 ${String(schema.maxLength)} 个字符` });
    }
}

function validateNumber(
    schema: JsonObject,
    value: number,
    path: string,
    issues: NodeConfigIssue[],
): void{
    if (schema.type === "integer" && !Number.isInteger(value)){
        issues.push({ path, message: "必须是整数" });
    }
    if (typeof schema.minimum === "number" && value < schema.minimum){
        issues.push({ path, message: `不能小于 ${String(schema.minimum)}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum){
        issues.push({ path, message: `不能大于 ${String(schema.maximum)}` });
    }
}

function validateArray(
    schema: JsonObject,
    value: readonly JsonValue[],
    path: string,
    issues: NodeConfigIssue[],
): void{
    if (typeof schema.minItems === "number" && value.length < schema.minItems){
        issues.push({ path, message: `至少需要 ${String(schema.minItems)} 项` });
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems){
        issues.push({ path, message: `最多 ${String(schema.maxItems)} 项` });
    }

    const items = toSchema(schema.items);
    if (items === undefined){
        return;
    }
    value.forEach((item, index) =>{
        validateValue(items, item, `${path}[${String(index)}]`, issues);
    });
}

function validateObject(
    schema: JsonObject,
    value: JsonObject,
    path: string,
    issues: NodeConfigIssue[],
): void{
    const required = Array.isArray(schema.required)
        ? schema.required.filter((name): name is string => typeof name === "string")
        : [];

    for (const name of required){
        if (value[name] === undefined){
            issues.push({ path: joinPath(path, name), message: "必填" });
        }
    }

    const properties = toSchemaRecord(schema.properties);
    if (properties === undefined){
        return;
    }

    for (const [name, raw] of Object.entries(properties)){
        const property = toSchema(raw);
        if (property === undefined){
            continue;
        }
        const child = value[name];
        if (child === undefined){
            continue;
        }
        validateValue(property, child, joinPath(path, name), issues);
    }
}

function toSchema(value: unknown): JsonObject | undefined{
    return isRecord(value) ? value as JsonObject : undefined;
}

function toSchemaRecord(value: unknown): Record<string, unknown> | undefined{
    return isRecord(value) ? value : undefined;
}

function readTypes(schema: JsonObject): readonly string[] | undefined{
    const type = schema.type;
    if (typeof type === "string"){
        return [type];
    }
    if (Array.isArray(type)){
        const types = type.filter((item): item is string => typeof item === "string");
        return types.length === 0 ? undefined : types;
    }
    return undefined;
}

function matchesAnyType(types: readonly string[], value: JsonValue): boolean{
    return types.some((type) => matchesType(type, value));
}

function matchesType(type: string, value: JsonValue): boolean{
    switch (type){
        case "object":
            return isRecord(value);
        case "array":
            return Array.isArray(value);
        case "string":
            return typeof value === "string";
        case "number":
            return typeof value === "number" && Number.isFinite(value);
        case "integer":
            return typeof value === "number" && Number.isInteger(value);
        case "boolean":
            return typeof value === "boolean";
        case "null":
            return value === null;
        default:
            return true;
    }
}

function describeType(value: JsonValue): string{
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
}

function formatEnum(value: JsonValue): string{
    if (!Array.isArray(value)){
        return "（无效的 enum）";
    }
    return value.map((item) => JSON.stringify(item)).join(" / ");
}

function joinPath(parent: string, key: string): string{
    return parent.length === 0 ? key : `${parent}.${key}`;
}

function jsonEquals(a: JsonValue, b: JsonValue): boolean{
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)){
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((item, index) => jsonEquals(item, b[index] as JsonValue));
    }
    if (isRecord(a) && isRecord(b)){
        const aKeys = Object.keys(a);
        const bKeys = Object.keys(b);
        if (aKeys.length !== bKeys.length) return false;
        return aKeys.every((key) => b[key] !== undefined
            && jsonEquals(a[key] as JsonValue, b[key] as JsonValue));
    }
    return false;
}
