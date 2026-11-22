import { isJsonSafe } from "../../base";
import { HarnessError, HarnessErrorCode } from "../base/error";
import { cloneJson, isRecord } from "../base/utils";
import { HARNESS_GRAPH_VERSION } from "../definition";
import { Edge } from "../graph/edge";
import { Graph } from "../graph/graph";
import type { NodeTypeRegistry } from "../graph/registry";
import { GRAPH_PARAMETER_TYPES } from "../graph/type";
import type {
    GraphEventDeclaration,
    GraphParameterDeclaration,
    HarnessValue,
    JsonObject,
    JsonValue,
    NodeInputValues,
} from "../graph/type";
import { isHarnessValue, isPortValueType, isToolSetSpec } from "../graph/type";
import type { GraphDocument, NodeDocument } from "./document";

export type GraphDeserializeOptions = {
    registry: NodeTypeRegistry;

    /** 默认 true；编辑器可以设为 false 载入未完成的草稿 */
    validate?: boolean;
};

/** 把 Graph 对象序列化为纯 JSON 文档 */
export function serializeGraph(graph: Graph): GraphDocument{
    const document: GraphDocument = {
        version: HARNESS_GRAPH_VERSION,
        id: graph.id,
        nodes: graph.nodes.map((node) => {
            const nodeDocument: NodeDocument = {
                id: node.id,
                type: node.type,
                typeVersion: node.typeVersion,
            };

            if (node.config !== undefined){
                if (!isJsonSafe(node.config)){
                    throw new HarnessError(
                        HarnessErrorCode.SerializationFailed,
                        `Node "${node.id}" config is not JSON-safe`,
                        { nodeId: node.id },
                    );
                }
                nodeDocument.config = cloneJson(node.config) as JsonValue;
            }

            if (Object.keys(node.inputDefaults).length > 0){
                for (const [name, value] of Object.entries(node.inputDefaults)){
                    if (!isHarnessValue(value) || !isJsonSafe(value)){
                        throw new HarnessError(
                            HarnessErrorCode.SerializationFailed,
                            `Node "${node.id}" input default "${name}" is not JSON-safe`,
                            { nodeId: node.id, port: name },
                        );
                    }
                }
                nodeDocument.inputs = cloneJson(node.inputDefaults) as NodeInputValues;
            }

            if (node.ui !== undefined){
                if (!isJsonSafe(node.ui)){
                    throw new HarnessError(
                        HarnessErrorCode.SerializationFailed,
                        `Node "${node.id}" ui data is not JSON-safe`,
                        { nodeId: node.id },
                    );
                }
                nodeDocument.ui = cloneJson(node.ui) as JsonObject;
            }

            return nodeDocument;
        }),
        edges: graph.edges.map((edge) => edge.toJSON()),
    };

    if (graph.title !== undefined) document.title = graph.title;
    if (graph.description !== undefined) document.description = graph.description;
    if (graph.parameters.length > 0){
        document.parameters = cloneJson(graph.parameters) as GraphParameterDeclaration[];
    }
    if (graph.events.length > 0){
        document.events = cloneJson(graph.events) as GraphEventDeclaration[];
    }
    if (graph.toolSet !== undefined){
        if (!isToolSetSpec(graph.toolSet)){
            throw new HarnessError(
                HarnessErrorCode.SerializationFailed,
                "Graph toolSet is not a valid ToolSetSpec",
            );
        }
        document.toolSet = cloneJson(graph.toolSet);
    }
    if (graph.metadata !== undefined){
        if (!isJsonSafe(graph.metadata)){
            throw new HarnessError(
                HarnessErrorCode.SerializationFailed,
                "Graph metadata is not JSON-safe",
            );
        }
        document.metadata = cloneJson(graph.metadata) as JsonObject;
    }
    if (graph.ui !== undefined){
        if (!isJsonSafe(graph.ui)){
            throw new HarnessError(
                HarnessErrorCode.SerializationFailed,
                "Graph ui data is not JSON-safe",
            );
        }
        document.ui = cloneJson(graph.ui) as JsonObject;
    }

    return document;
}

/** 从纯 JSON 文档重建 Graph；自定义节点类型必须已注册 */
export function deserializeGraph(
    value: unknown,
    options: GraphDeserializeOptions,
): Graph{
    const document = parseGraphDocument(value);
    const nodes = document.nodes.map((node) => options.registry.createNode(node));
    const edges = document.edges.map((edge) => Edge.fromJSON(edge));

    const graph = new Graph(nodes, edges, {
        id: document.id,
        title: document.title,
        description: document.description,
        parameters: document.parameters,
        events: document.events,
        toolSet: document.toolSet,
        metadata: document.metadata,
        ui: document.ui,
    });

    if (options.validate !== false) graph.assertValid();
    return graph;
}

function parseGraphDocument(value: unknown): GraphDocument{
    if (!isRecord(value)){
        throw invalidDocument("Graph document must be an object");
    }

    const version = value.version;
    if (typeof version !== "number" || !Number.isInteger(version)){
        throw invalidDocument("Graph document version must be an integer");
    }
    if (version !== HARNESS_GRAPH_VERSION){
        throw new HarnessError(
            HarnessErrorCode.UnsupportedDocumentVersion,
            `Unsupported graph document version ${String(version)}; expected ${String(HARNESS_GRAPH_VERSION)}`,
        );
    }

    const id = readNonEmptyString(value.id, "id");
    const nodes = readArray(value.nodes, "nodes").map(parseNodeDocument);
    const edges = readArray(value.edges, "edges").map(parseEdgeDocument);

    const document: GraphDocument = {
        version,
        id,
        nodes,
        edges,
    };

    if (value.title !== undefined){
        document.title = readString(value.title, "title");
    }
    if (value.description !== undefined){
        document.description = readString(value.description, "description");
    }
    if (value.parameters !== undefined){
        document.parameters = readArray(value.parameters, "parameters")
            .map(parseParameterDeclaration);
    }
    if (value.events !== undefined){
        document.events = readArray(value.events, "events")
            .map(parseEventDeclaration);
    }
    if (value.toolSet !== undefined){
        if (!isToolSetSpec(value.toolSet)){
            throw invalidDocument("toolSet is not a valid ToolSetSpec");
        }
        document.toolSet = cloneJson(value.toolSet);
    }
    if (value.metadata !== undefined){
        document.metadata = readJsonObject(value.metadata, "metadata");
    }
    if (value.ui !== undefined){
        document.ui = readJsonObject(value.ui, "ui");
    }

    return document;
}

function parseNodeDocument(value: unknown, index: number): NodeDocument{
    const field = `nodes[${String(index)}]`;
    if (!isRecord(value)){
        throw invalidDocument(`${field} must be an object`);
    }

    const node: NodeDocument = {
        id: readNonEmptyString(value.id, `${field}.id`),
        type: readNonEmptyString(value.type, `${field}.type`),
        typeVersion: readPositiveInteger(value.typeVersion, `${field}.typeVersion`),
    };

    if (value.config !== undefined){
        if (!isJsonSafe(value.config)){
            throw invalidDocument(`${field}.config must be JSON-safe`);
        }
        node.config = cloneJson(value.config) as JsonValue;
    }

    if (value.inputs !== undefined){
        if (!isRecord(value.inputs)){
            throw invalidDocument(`${field}.inputs must be an object`);
        }

        const inputs: Record<string, HarnessValue> = {};
        for (const [name, item] of Object.entries(value.inputs)){
            if (!isHarnessValue(item)){
                throw invalidDocument(`${field}.inputs.${name} is not a valid HarnessValue`);
            }
            inputs[name] = cloneJson(item) as HarnessValue;
        }
        node.inputs = inputs;
    }

    if (value.ui !== undefined){
        node.ui = readJsonObject(value.ui, `${field}.ui`);
    }

    return node;
}

function parseEdgeDocument(value: unknown, index: number){
    const field = `edges[${String(index)}]`;
    try{
        return Edge.fromJSON(value).toJSON();
    }catch(error){
        throw new HarnessError(
            HarnessErrorCode.InvalidDocument,
            `Invalid ${field}: ${errorMessage(error)}`,
            { origin: error },
        );
    }
}

function parseParameterDeclaration(
    value: unknown,
    index: number,
): GraphParameterDeclaration{
    const field = `parameters[${String(index)}]`;
    if (!isRecord(value)){
        throw invalidDocument(`${field} must be an object`);
    }

    const type = value.type;
    if (typeof type !== "string"
        || !(GRAPH_PARAMETER_TYPES as readonly string[]).includes(type)){
        throw invalidDocument(`${field}.type must be one of ${GRAPH_PARAMETER_TYPES.join(", ")}`);
    }

    const parameter: GraphParameterDeclaration = {
        name: readNonEmptyString(value.name, `${field}.name`),
        type: type as GraphParameterDeclaration["type"],
    };

    if (value.required !== undefined){
        parameter.required = readBoolean(value.required, `${field}.required`);
    }
    if (value.secret !== undefined){
        parameter.secret = readBoolean(value.secret, `${field}.secret`);
    }
    if (value.description !== undefined){
        parameter.description = readString(value.description, `${field}.description`);
    }
    if (value.default !== undefined){
        if (!isJsonSafe(value.default)){
            throw invalidDocument(`${field}.default must be JSON-safe`);
        }
        parameter.default = cloneJson(value.default) as JsonValue;
    }

    return parameter;
}

function parseEventDeclaration(
    value: unknown,
    index: number,
): GraphEventDeclaration{
    const field = `events[${String(index)}]`;
    if (!isRecord(value)){
        throw invalidDocument(`${field} must be an object`);
    }

    const event: GraphEventDeclaration = {
        name: readNonEmptyString(value.name, `${field}.name`),
    };

    if (value.description !== undefined){
        event.description = readString(value.description, `${field}.description`);
    }
    if (value.payload !== undefined){
        if (!isPortValueType(value.payload)){
            throw invalidDocument(`${field}.payload is not a valid port value type`);
        }
        event.payload = value.payload;
    }

    return event;
}

function readArray(value: unknown, field: string): readonly unknown[]{
    if (!Array.isArray(value)){
        throw invalidDocument(`${field} must be an array`);
    }
    return value;
}

function readNonEmptyString(value: unknown, field: string): string{
    const text = readString(value, field);
    if (text.length === 0){
        throw invalidDocument(`${field} must be a non-empty string`);
    }
    return text;
}

function readString(value: unknown, field: string): string{
    if (typeof value !== "string"){
        throw invalidDocument(`${field} must be a string`);
    }
    return value;
}

function readBoolean(value: unknown, field: string): boolean{
    if (typeof value !== "boolean"){
        throw invalidDocument(`${field} must be a boolean`);
    }
    return value;
}

function readPositiveInteger(value: unknown, field: string): number{
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1){
        throw invalidDocument(`${field} must be a positive integer`);
    }
    return value;
}

function readJsonObject(value: unknown, field: string): JsonObject{
    if (!isRecord(value) || !isJsonSafe(value)){
        throw invalidDocument(`${field} must be a JSON-safe object`);
    }
    return cloneJson(value) as JsonObject;
}

function invalidDocument(message: string): HarnessError{
    return new HarnessError(HarnessErrorCode.InvalidDocument, message);
}

function errorMessage(error: unknown): string{
    return error instanceof Error ? error.message : String(error);
}
