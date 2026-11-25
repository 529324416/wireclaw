import { Graph } from "../graph/graph";
import type { GraphEventListener } from "../graph/event";
import type { NodeContext } from "../graph/node";
import type { NodeTypeRegistry } from "../graph/registry";
import type { GraphHost, GraphRunInput, GraphRunResult } from "../runtime/types";

export type SubgraphRunOptions = {
    registry: NodeTypeRegistry;
    ctx: NodeContext;
    document: unknown;
    input: GraphRunInput;
    prefix: string;
    signal?: AbortSignal;
};

/**
 * 运行一张内嵌子图。
 *
 * @note 调用方负责把 Graph.fromJSON / 运行失败包装成当前节点的错误。
 */
export async function runSubgraph(
    options: SubgraphRunOptions,
): Promise<GraphRunResult>{
    const graph = Graph.fromJSON(options.document, {
        registry: options.registry,
    });

    return await graph.run({
        host: createHost(options.ctx),
        input: options.input,
        listener: createListener(options.ctx, options.prefix),
        signal: options.signal ?? options.ctx.signal,
        ...(options.ctx.resultCollector === undefined
            ? {}
            : { resultCollector: options.ctx.resultCollector }),
        graphPath: [...options.ctx.graphPath, options.prefix],
    }).done;
}

function createHost(ctx: NodeContext): GraphHost{
    return {
        resolveProvider: (providerId) => ctx.services.resolveProvider(providerId),
        ...(ctx.services.tools === undefined ? {} : { tools: ctx.services.tools }),
        ...(ctx.services.attachments === undefined
            ? {}
            : { attachments: ctx.services.attachments }),
        ...(ctx.services.parameters === undefined
            ? {}
            : { parameters: ctx.services.parameters }),
        ...(ctx.services.onToolApproval === undefined
            ? {}
            : {
                onToolApproval: (request) => ctx.services.onToolApproval!(request),
            }),
        ...(ctx.services.onUserInput === undefined
            ? {}
            : {
                onUserInput: (request) => ctx.services.onUserInput!(request),
            }),
        log: (level, message, data) =>{
            ctx.log(level, message, data);
        },
    };
}

function createListener(
    ctx: NodeContext,
    prefix: string,
): GraphEventListener{
    return (event) =>{
        if (event.type === "custom"){
            ctx.publish(`${prefix}.${event.name}`, event.payload);
            return;
        }
        if (event.type === "node:skipped"){
            ctx.publish(`${prefix}.node:skipped`, { nodeId: event.nodeId });
        }
    };
}
