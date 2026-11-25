import type { Graph } from "../graph/graph";
import { serializeGraph } from "../serialize/serializer";

/**
 * 可执行图定义的稳定指纹。
 *
 * 不含 ui / title / description / metadata：布局或展示名变化不应让 checkpoint 失效。
 * 边按端口地址排序，节点按 id 排序，避免文档顺序影响结果。
 */
export function graphFingerprint(graph: Graph): string {
    const document = serializeGraph(graph);
    const executable = {
        id: document.id,
        nodes: document.nodes
            .map((node) => ({
                id: node.id,
                type: node.type,
                typeVersion: node.typeVersion,
                ...(node.config === undefined ? {} : { config: node.config }),
                ...(node.inputs === undefined ? {} : { inputs: node.inputs }),
                ...(node.requires === undefined ? {} : { requires: node.requires }),
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        edges: document.edges
            .map(
                (edge) =>
                    `${edge.from.nodeId}:${edge.from.port}->${edge.to.nodeId}:${edge.to.port}`,
            )
            .sort(),
        ...(document.parameters === undefined
            ? {}
            : { parameters: document.parameters }),
        ...(document.events === undefined ? {} : { events: document.events }),
        ...(document.toolSet === undefined ? {} : { toolSet: document.toolSet }),
    };

    const text = JSON.stringify(executable);
    const first = hash32(text, 0x811c9dc5);
    const second = hash32(text, 0x9e3779b9);
    return `fnv1a64:${first.toString(16).padStart(8, "0")}${second
        .toString(16)
        .padStart(8, "0")}`;
}

/** 顶层节点的类型版本映射。 */
export function graphNodeVersions(graph: Graph): Record<string, number> {
    return Object.fromEntries(
        [...graph.nodes]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((node) => [node.id, node.typeVersion]),
    );
}

function hash32(text: string, seed: number): number {
    let hash = seed >>> 0;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}
