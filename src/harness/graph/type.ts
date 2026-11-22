import { isJsonSafe } from "../../base";
import { isContentHash } from "../../session/attachment";
import type { AttachmentRef } from "../../session/type";

/* ---------------------------------------------------------------------------
 * JSON / 值类型
 * ------------------------------------------------------------------------- */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** 端口承载的值类型；不包含 stream，流是输出模式而不是类型 */
export const PORT_VALUE_TYPES = [
    "text",
    "json",
    "model",
    "toolset",
    "attachment",
    "attachments",
    "any",
] as const;
export type PortValueType = (typeof PORT_VALUE_TYPES)[number];

/** 输出端口的暴露模式；value 只暴露 final，stream 同时暴露 chunk */
export const OUTPUT_MODES = ["value", "stream"] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

export type InputPortSpec = {
    name: string;
    type: PortValueType;
    required?: boolean;

    /** 消费模式；默认 value，stream 表示运行期逐块消费 */
    mode?: "value" | "stream";

    /** 是否允许多个上游同时连入；默认 false */
    multiple?: boolean;
    description?: string;
};

export type OutputPortSpec = {
    name: string;
    type: PortValueType;

    /** 该端口声明支持的模式；缺省视为只支持 value */
    supportedModes?: readonly OutputMode[];

    /** 未显式配置节点 outputMode 时使用 */
    defaultMode?: OutputMode;
    description?: string;
};

/** 模型绑定只保存身份；Provider 实例、密钥、baseUrl 均由宿主注入 */
export type ModelBinding = {
    providerId: string;
    modelId: string;
};

/** Harness 层的工具可见范围描述；真正的 ToolSet 在运行时由宿主构造 */
export type ToolSetSpec = {
    include?: readonly string[];
    exclude?: readonly string[];
    hostTools?: {
        askUser?: boolean;
        viewMedia?: boolean;
    };
};

/** 图中流动的值；附件只保存 contentHash */
export type HarnessValue =
    | { type: "text"; text: string }
    | { type: "json"; value: JsonValue }
    | { type: "model"; model: ModelBinding }
    | { type: "toolset"; toolset: ToolSetSpec }
    | { type: "attachment"; attachment: AttachmentRef }
    | { type: "attachments"; attachments: readonly AttachmentRef[] };

export type NodeInputValues = Readonly<Record<string, HarnessValue>>;
export type NodeOutputValues = Readonly<Record<string, HarnessValue>>;

/** 一次 GraphRun 的输入；Step 2 只有 text / attachments，values 预留给命名输入 */
export type HarnessInput = {
    text?: string;
    attachments?: readonly AttachmentRef[];
    values?: Readonly<Record<string, HarnessValue>>;
};

/* ---------------------------------------------------------------------------
 * 图级声明
 * ------------------------------------------------------------------------- */

export const GRAPH_PARAMETER_TYPES = ["string", "number", "boolean", "json"] as const;
export type GraphParameterType = (typeof GRAPH_PARAMETER_TYPES)[number];

export type GraphParameterDeclaration = {
    name: string;
    type: GraphParameterType;
    required?: boolean;
    default?: JsonValue;
    secret?: boolean;
    description?: string;
};

export type GraphEventDeclaration = {
    name: string;
    description?: string;
    payload?: PortValueType;
};

/* ---------------------------------------------------------------------------
 * 运行时判断
 * ------------------------------------------------------------------------- */

export function isJsonValue(value: unknown): value is JsonValue{
    return isJsonSafe(value);
}

export function isPortValueType(value: unknown): value is PortValueType{
    return typeof value === "string"
        && (PORT_VALUE_TYPES as readonly string[]).includes(value);
}

export function isOutputMode(value: unknown): value is OutputMode{
    return value === "value" || value === "stream";
}

export function isModelBinding(value: unknown): value is ModelBinding{
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return typeof record.providerId === "string"
        && record.providerId.length > 0
        && typeof record.modelId === "string"
        && record.modelId.length > 0;
}

export function isToolSetSpec(value: unknown): value is ToolSetSpec{
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

    const record = value as Record<string, unknown>;
    if (!isStringArray(record.include) || !isStringArray(record.exclude)) return false;

    if (record.hostTools === undefined) return true;
    if (typeof record.hostTools !== "object" || record.hostTools === null
        || Array.isArray(record.hostTools)){
        return false;
    }

    const hostTools = record.hostTools as Record<string, unknown>;
    return isOptionalBoolean(hostTools.askUser)
        && isOptionalBoolean(hostTools.viewMedia);
}

export function isHarnessValue(value: unknown): value is HarnessValue{
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

    const record = value as Record<string, unknown>;
    switch (record.type){
        case "text":
            return typeof record.text === "string";
        case "json":
            return isJsonValue(record.value);
        case "model":
            return isModelBinding(record.model);
        case "toolset":
            return isToolSetSpec(record.toolset);
        case "attachment":
            return isAttachmentRef(record.attachment);
        case "attachments":
            return Array.isArray(record.attachments)
                && record.attachments.every(isAttachmentRef);
        default:
            return false;
    }
}

export function isNodeInputValues(value: unknown): value is NodeInputValues{
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    return Object.values(value as Record<string, unknown>).every(isHarnessValue);
}

/** 输出端口 -> 输入端口 的类型兼容规则；any 是唯一通配 */
export function isPortTypeCompatible(
    source: PortValueType,
    target: PortValueType,
): boolean{
    return source === "any" || target === "any" || source === target;
}

/** 值是否能被指定类型的端口接收 */
export function isHarnessValueCompatible(
    portType: PortValueType,
    value: HarnessValue,
): boolean{
    if (portType === "any") return true;

    switch (value.type){
        case "text":
            return portType === "text";
        case "json":
            return portType === "json";
        case "model":
            return portType === "model";
        case "toolset":
            return portType === "toolset";
        case "attachment":
            return portType === "attachment";
        case "attachments":
            return portType === "attachments";
    }
}

/** 输出端口当前声明的默认模式；Step 1 只做契约，不执行 */
export function defaultOutputMode(port: OutputPortSpec): OutputMode{
    if (port.defaultMode !== undefined) return port.defaultMode;
    if (port.supportedModes !== undefined && port.supportedModes.length > 0){
        return port.supportedModes[0];
    }
    return "value";
}

export function supportsOutputMode(
    port: OutputPortSpec,
    mode: OutputMode,
): boolean{
    if (port.supportedModes === undefined || port.supportedModes.length === 0){
        return mode === "value";
    }
    return port.supportedModes.includes(mode);
}

function isStringArray(value: unknown): boolean{
    return value === undefined
        || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function isOptionalBoolean(value: unknown): boolean{
    return value === undefined || typeof value === "boolean";
}

function isAttachmentRef(value: unknown): value is AttachmentRef{
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return typeof record.contentHash === "string"
        && isContentHash(record.contentHash);
}
