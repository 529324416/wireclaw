import { HarnessError, HarnessErrorCode } from "../base/error";
import { isRecord } from "../base/utils";
import { Graph } from "../graph/graph";
import type { EmbeddedGraph } from "../graph/node";
import type { NodeTypeRegistry } from "../graph/registry";
import type { JsonValue } from "../graph/type";

/**
 * 从容器节点的 `config.graph` 读取内嵌图。
 *
 * - 解析用 `validate: false`，让 `Graph.validate()` 统一收集问题；
 * - 结构非法（缺 graph / 版本不支持 / 节点类型未注册）时不抛错，
 *   而是把原因带回给父图，由父图定位到容器节点。
 */
export function readEmbeddedGraph(
    config: JsonValue | undefined,
    nodeType: string,
    registry: NodeTypeRegistry,
    path: string,
): EmbeddedGraph{
    const document = isRecord(config) ? config.graph : undefined;

    if (!isRecord(document)){
        return {
            path,
            document,
            error: new HarnessError(
                HarnessErrorCode.InvalidNode,
                `${nodeType} requires config.graph to be a GraphDocument`,
            ),
        };
    }

    try{
        return {
            path,
            document,
            graph: Graph.fromJSON(document, { registry, validate: false }),
        };
    }catch(error){
        return { path, document, error };
    }
}
