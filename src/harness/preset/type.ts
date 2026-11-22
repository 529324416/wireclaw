import type {
    JsonObject,
    JsonValue,
    NodeInputValues,
    NodeRequirement,
} from "../graph/type";

export const NODE_PRESET_VERSION = 1 as const;

/** 预设里“实例化时仍可填写”的参数；path 指向 config 的点路径 */
export type NodePresetParameter = {
    name: string;
    path: string;
    required?: boolean;
    default?: JsonValue;
    description?: string;
};

/**
 * 节点库条目。
 *
 * @note 与 NodeDocument 的区别：没有图内唯一 id，带 presetId / 名称 / 标签 /
 *       依赖声明与可覆盖参数；实例化时才生成节点 id。
 */
export type NodePresetDocument = {
    version: number;
    presetId: string;
    name: string;
    description?: string;
    type: string;
    typeVersion: number;
    config?: JsonValue;
    inputs?: NodeInputValues;
    ui?: JsonObject;
    parameters?: readonly NodePresetParameter[];
    requires?: readonly NodeRequirement[];
    tags?: readonly string[];
};
