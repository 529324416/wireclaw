import { HarnessError } from "../base/error";
import { cloneJson } from "../base/utils";
import type { NodeTypeRegistry } from "../graph/registry";
import type {
    InputPortSpec,
    JsonObject,
    JsonValue,
    NodeRequirement,
    OutputPortSpec,
} from "../graph/type";
import { NodePresetLibrary } from "../preset/library";
import type { NodePresetDocument } from "../preset/type";

export const GRAPH_EDITOR_CATALOG_VERSION = 2 as const;

/** 单个节点类型的编辑器描述；端口来自一个空的示例实例 */
export type NodeCatalogEntry = {
    type: string;
    version: number;
    title?: string;
    description?: string;
    builtIn?: boolean;
    configSchema?: JsonObject;
    defaultConfig?: JsonValue;
    category?: string;
    keywords?: readonly string[];
    inputs: readonly InputPortSpec[];
    outputs: readonly OutputPortSpec[];
    requirements: readonly NodeRequirement[];

    /** 用默认 config 无法创建示例实例时的原因；编辑器可展示为不可用 */
    error?: string;
};

export type GraphEditorCatalog = {
    version: typeof GRAPH_EDITOR_CATALOG_VERSION;
    nodeTypes: readonly NodeCatalogEntry[];
    presets: readonly NodePresetDocument[];
};

/**
 * 描述单个节点类型。
 *
 * @note 端口可能依赖 config（例如动态端口节点），所以这里会创建一个
 *       id 为 `catalog:<type>` 的示例实例，不执行节点。
 */
export function describeNodeType(
    registry: NodeTypeRegistry,
    type: string,
    options: { config?: JsonValue } = {},
): NodeCatalogEntry{
    const definition = registry.require(type);
    const config = options.config ?? {};
    const node = definition.create(
        `catalog:${type}`,
        config,
        {},
        undefined,
    );

    return {
        type: definition.type,
        version: definition.version,
        title: definition.title,
        description: definition.description,
        builtIn: definition.builtIn,
        configSchema: definition.configSchema,
        defaultConfig: definition.defaultConfig === undefined
            ? undefined
            : cloneJson(definition.defaultConfig),
        category: definition.category,
        keywords: definition.keywords,
        inputs: node.inputs,
        outputs: node.outputs,
        requirements: [
            ...(definition.requirements ?? []),
            ...node.requirements,
        ],
    };
}

/** 描述全部已注册节点类型；单个类型失败不会中断整个目录 */
export function describeNodeTypes(
    registry: NodeTypeRegistry,
    options: { configs?: Readonly<Record<string, JsonValue>> } = {},
): readonly NodeCatalogEntry[]{
    const entries: NodeCatalogEntry[] = [];

    for (const descriptor of registry.list()){
        try{
            entries.push(describeNodeType(registry, descriptor.type, {
                config: options.configs?.[descriptor.type],
            }));
        }catch(error){
            entries.push({
                type: descriptor.type,
                version: descriptor.version,
                title: descriptor.title,
                description: descriptor.description,
                builtIn: descriptor.builtIn,
                configSchema: descriptor.configSchema,
                defaultConfig: descriptor.defaultConfig === undefined
                    ? undefined
                    : cloneJson(descriptor.defaultConfig),
                category: descriptor.category,
                keywords: descriptor.keywords,
                inputs: [],
                outputs: [],
                requirements: descriptor.requirements ?? [],
                error: errorMessage(error),
            });
        }
    }

    return entries;
}

/** 生成 GraphEditor 启动时需要的节点目录 + 预设目录 */
export function createEditorCatalog(
    registry: NodeTypeRegistry,
    options: {
        configs?: Readonly<Record<string, JsonValue>>;
        presets?: NodePresetLibrary | readonly NodePresetDocument[];
    } = {},
): GraphEditorCatalog{
    const presets = options.presets === undefined
        ? []
        : options.presets instanceof NodePresetLibrary
            ? options.presets.list()
            : options.presets;

    return {
        version: GRAPH_EDITOR_CATALOG_VERSION,
        nodeTypes: describeNodeTypes(registry, {
            ...(options.configs === undefined ? {} : { configs: options.configs }),
        }),
        presets: cloneJson(presets),
    };
}

function errorMessage(error: unknown): string{
    return error instanceof HarnessError || error instanceof Error
        ? error.message
        : String(error);
}
