import { HarnessError, HarnessErrorCode } from "../base/error";
import { assertRequirementsSatisfied } from "../graph/requirements";
import type { GraphNode } from "../graph/node";
import type { NodeTypeRegistry } from "../graph/registry";
import type {
    JsonValue,
    RequirementCatalog,
} from "../graph/type";
import { parseNodePresetDocument, applyPresetParameters } from "./validate";
import type { NodePresetDocument } from "./type";

export type InstantiateNodePresetOptions = {
    registry: NodeTypeRegistry;

    /** 新节点的 graph 内唯一 id */
    id: string;

    /** 预设声明的可覆盖参数值 */
    parameters?: Readonly<Record<string, JsonValue>>;

    /** 可选依赖目录；提供时在实例化阶段就失败 */
    available?: RequirementCatalog;
};

/** 从节点库条目创建一个新的 GraphNode */
export function instantiateNodePreset(
    value: unknown,
    options: InstantiateNodePresetOptions,
): GraphNode{
    const preset: NodePresetDocument = parseNodePresetDocument(value);
    if (options.id.length === 0){
        throw new HarnessError(
            HarnessErrorCode.InvalidPreset,
            "instantiateNodePreset requires a non-empty node id",
        );
    }

    const config = applyPresetParameters(preset, options.parameters);
    const node = options.registry.createNode({
        id: options.id,
        type: preset.type,
        typeVersion: preset.typeVersion,
        config,
        inputs: preset.inputs,
        ui: preset.ui,
        requirements: preset.requires,
    });

    if (options.available !== undefined){
        assertRequirementsSatisfied(node.requirements, options.available, {
            nodeId: options.id,
        });
    }

    return node;
}
