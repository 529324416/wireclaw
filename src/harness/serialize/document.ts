import type { EdgeDocument } from "../graph/edge";
import type {
    GraphEventDeclaration,
    GraphParameterDeclaration,
    JsonObject,
    JsonValue,
    NodeInputValues,
    ToolSetSpec,
} from "../graph/type";

/** 节点实例的序列化形态；端口由节点类型/实例在反序列化时重建 */
export type NodeDocument = {
    id: string;
    type: string;
    typeVersion: number;
    config?: JsonValue;
    inputs?: NodeInputValues;
    ui?: JsonObject;
};

/** Graph 的纯 JSON 文档；运行时不直接消费它，先反序列化为 Graph */
export type GraphDocument = {
    version: number;
    id: string;
    title?: string;
    description?: string;
    nodes: NodeDocument[];
    edges: EdgeDocument[];
    parameters?: GraphParameterDeclaration[];
    events?: GraphEventDeclaration[];
    toolSet?: ToolSetSpec;
    metadata?: JsonObject;

    /** 设计器坐标等；运行时忽略 */
    ui?: JsonObject;
};
