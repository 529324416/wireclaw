import { isJsonSafe } from "../../base";
import { HarnessError, HarnessErrorCode } from "../base/error";
import { isRecord } from "../base/utils";
import type { GraphNode } from "./node";
import type {
    JsonObject,
    JsonValue,
    NodeInputValues,
} from "./type";

/** 节点类型定义；由宿主注册，JSON 中只保存 type + typeVersion */
export type NodeTypeDefinition = {
    type: string;
    version: number;
    title?: string;
    description?: string;
    builtIn?: boolean;

    /** 供设计器生成参数表单的 JSON Schema */
    configSchema?: JsonObject;

    create: (
        id: string,
        config: JsonValue | undefined,
        inputDefaults: NodeInputValues,
        ui: JsonObject | undefined,
    ) => GraphNode;
};

/** 对外暴露的节点类型元信息（不含构造器） */
export type NodeTypeDescriptor = Omit<NodeTypeDefinition, "create">;

export type NodeCreateInput = {
    id: string;
    type: string;
    typeVersion: number;
    config?: JsonValue;
    inputs?: NodeInputValues;
    ui?: JsonObject;
};

/**
 * 节点类型注册表。
 *
 * @note 反序列化自定义节点前，宿主必须先把对应类型注册进来；
 *       Graph JSON 本身不携带可执行代码。
 */
export class NodeTypeRegistry{

    private readonly _types = new Map<string, NodeTypeDefinition>();

    register(definition: NodeTypeDefinition): void{
        if (typeof definition.type !== "string" || definition.type.length === 0){
            throw new HarnessError(
                HarnessErrorCode.NodeTypeConflict,
                "Node type must be a non-empty string",
            );
        }
        if (!Number.isInteger(definition.version) || definition.version < 1){
            throw new HarnessError(
                HarnessErrorCode.NodeTypeConflict,
                `Node type "${definition.type}" has an invalid version`,
            );
        }
        if (typeof definition.create !== "function"){
            throw new HarnessError(
                HarnessErrorCode.NodeTypeConflict,
                `Node type "${definition.type}" is missing a create function`,
            );
        }
        if (definition.configSchema !== undefined && !isJsonSafe(definition.configSchema)){
            throw new HarnessError(
                HarnessErrorCode.NodeTypeConflict,
                `Node type "${definition.type}" has a non-JSON config schema`,
            );
        }
        if (this._types.has(definition.type)){
            throw new HarnessError(
                HarnessErrorCode.NodeTypeConflict,
                `Node type "${definition.type}" is already registered`,
            );
        }

        this._types.set(definition.type, definition);
    }

    has(type: string): boolean{
        return this._types.has(type);
    }

    get(type: string): NodeTypeDefinition | undefined{
        return this._types.get(type);
    }

    require(type: string): NodeTypeDefinition{
        const definition = this._types.get(type);
        if (definition === undefined){
            throw new HarnessError(
                HarnessErrorCode.UnknownNodeType,
                `Unknown node type "${type}"; register it before deserializing`,
            );
        }
        return definition;
    }

    list(): readonly NodeTypeDescriptor[]{
        return [...this._types.values()].map(toDescriptor);
    }

    describe(type: string): NodeTypeDescriptor | undefined{
        const definition = this._types.get(type);
        return definition === undefined ? undefined : toDescriptor(definition);
    }

    createNode(input: NodeCreateInput): GraphNode{
        if (!isRecord(input)){
            throw new HarnessError(
                HarnessErrorCode.InvalidNode,
                "Node input must be an object",
            );
        }

        const definition = this.require(input.type);
        if (!Number.isInteger(input.typeVersion) || input.typeVersion !== definition.version){
            throw new HarnessError(
                HarnessErrorCode.UnsupportedNodeTypeVersion,
                `Node "${input.id}" uses type "${input.type}" version ${String(input.typeVersion)}, `
                    + `but the registered version is ${String(definition.version)}`,
                { nodeId: input.id },
            );
        }

        const node = definition.create(
            input.id,
            input.config,
            input.inputs ?? {},
            input.ui,
        );

        if (node.type !== definition.type){
            throw new HarnessError(
                HarnessErrorCode.InvalidNode,
                `Node "${input.id}" was created as "${node.type}", expected "${definition.type}"`,
                { nodeId: input.id },
            );
        }
        if (node.typeVersion !== definition.version){
            throw new HarnessError(
                HarnessErrorCode.UnsupportedNodeTypeVersion,
                `Node "${input.id}" reports version ${String(node.typeVersion)}, `
                    + `but its type is registered as ${String(definition.version)}`,
                { nodeId: input.id },
            );
        }

        return node;
    }
}

function toDescriptor(definition: NodeTypeDefinition): NodeTypeDescriptor{
    return {
        type: definition.type,
        version: definition.version,
        title: definition.title,
        description: definition.description,
        builtIn: definition.builtIn,
        configSchema: definition.configSchema,
    };
}
