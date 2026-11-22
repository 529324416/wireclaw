import type { GraphNode } from "../graph/node";
import type { NodeTypeRegistry } from "../graph/registry";
import type { JsonObject } from "../graph/type";
import type { NodeDocument } from "./document";

/**
 * 序列化插件（占位）。
 *
 * 当前 Step 1 只依赖 NodeTypeRegistry 完成自定义节点反序列化；
 * 这个接口预留给后续的节点迁移、私有字段编解码和第三方节点包。
 */
export interface SerializationPluginContext{
    readonly registry: NodeTypeRegistry;
}

export interface HarnessSerializationPlugin{

    /** 插件 ID；用于冲突检测 */
    readonly id: string;

    /** 在节点文档之外补充私有字段 */
    serializeNode?(
        node: GraphNode,
        context: SerializationPluginContext,
    ): JsonObject | undefined;

    /** 优先于 NodeTypeRegistry 接管某个节点的反序列化 */
    deserializeNode?(
        document: NodeDocument,
        context: SerializationPluginContext,
    ): GraphNode | undefined;

    /** 节点类型版本迁移 */
    migrateNode?(
        document: NodeDocument,
        fromVersion: number,
        context: SerializationPluginContext,
    ): NodeDocument | undefined;
}
