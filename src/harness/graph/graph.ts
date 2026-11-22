import { uniqueId } from "../../base";
import type { HarnessIssue } from "../base/error";
import { HarnessError, HarnessErrorCode, formatHarnessIssue } from "../base/error";
import type { GraphRun } from "../runtime/runner";
import { runGraph } from "../runtime/runner";
import type { GraphRunOptions } from "../runtime/types";
import type { GraphDocument } from "../serialize/document";
import type { GraphDeserializeOptions } from "../serialize/serializer";
import { deserializeGraph, serializeGraph } from "../serialize/serializer";
import { Edge } from "./edge";
import type { GraphNode } from "./node";
import {
    isHarnessValue,
    isHarnessValueCompatible,
    isPortTypeCompatible,
    isPortValueType,
    isToolSetSpec,
    supportsOutputMode,
} from "./type";
import type {
    GraphEventDeclaration,
    GraphParameterDeclaration,
    InputPortSpec,
    JsonObject,
    OutputPortSpec,
    ToolSetSpec,
} from "./type";

export type GraphOptions = {
    id?: string;
    title?: string;
    description?: string;
    metadata?: JsonObject;
    ui?: JsonObject;
    parameters?: readonly GraphParameterDeclaration[];
    events?: readonly GraphEventDeclaration[];

    /** Graph 级默认工具范围；节点级 ToolSet 只能在此基础上收窄 */
    toolSet?: ToolSetSpec;
};

/**
 * 可执行的图定义（Step 1：结构、校验、序列化；运行器在 Step 2 接入）。
 *
 * @note Node/Edge 是 TS 对象；JSON 只是它们的快照。
 * @note Graph 本身必须是有向无环图；循环由未来的复合节点表达。
 */
export class Graph{

    readonly id: string;
    readonly title?: string;
    readonly description?: string;
    readonly nodes: readonly GraphNode[];
    readonly edges: readonly Edge[];
    readonly metadata?: JsonObject;
    readonly ui?: JsonObject;
    readonly parameters: readonly GraphParameterDeclaration[];
    readonly events: readonly GraphEventDeclaration[];
    readonly toolSet?: ToolSetSpec;

    constructor(
        nodes: readonly GraphNode[],
        edges: readonly Edge[] = [],
        options: GraphOptions = {},
    ){
        this.nodes = [...nodes];
        this.edges = [...edges];
        this.id = options.id ?? `graph-${uniqueId()}`;
        this.title = options.title;
        this.description = options.description;
        this.metadata = options.metadata;
        this.ui = options.ui;
        this.parameters = options.parameters ?? [];
        this.events = options.events ?? [];
        this.toolSet = options.toolSet;
    }

    getNode(nodeId: string): GraphNode | undefined{
        return this.nodes.find((node) => node.id === nodeId);
    }

    /** 返回全部可定位的校验问题；不抛异常，供设计器逐条展示 */
    validate(): readonly HarnessIssue[]{
        const issues: HarnessIssue[] = [];
        const nodeById = new Map<string, GraphNode>();

        if (this.id.length === 0){
            issues.push({
                code: HarnessErrorCode.InvalidGraph,
                message: "Graph id must be a non-empty string",
            });
        }

        for (const node of this.nodes){
            if (node.id.length === 0){
                issues.push({
                    code: HarnessErrorCode.InvalidNode,
                    message: "Node id must be a non-empty string",
                });
            } else if (nodeById.has(node.id)){
                issues.push({
                    code: HarnessErrorCode.DuplicateNodeId,
                    message: `Duplicate node id "${node.id}"`,
                    nodeId: node.id,
                });
            } else {
                nodeById.set(node.id, node);
            }

            if (typeof node.type !== "string" || node.type.length === 0){
                issues.push({
                    code: HarnessErrorCode.InvalidNode,
                    message: "Node type must be a non-empty string",
                    nodeId: node.id,
                });
            }

            validatePorts(node, issues);
            validateInputDefaults(node, issues);
        }

        const incomingCounts = new Map<string, number>();
        const edgeKeys = new Set<string>();
        const adjacency = new Map<string, string[]>();

        for (const [index, edge] of this.edges.entries()){
            const fromNode = nodeById.get(edge.from.nodeId);
            const toNode = nodeById.get(edge.to.nodeId);

            if (fromNode === undefined){
                issues.push({
                    code: HarnessErrorCode.UnknownPort,
                    message: `Edge source node "${edge.from.nodeId}" does not exist`,
                    edgeIndex: index,
                });
            }
            if (toNode === undefined){
                issues.push({
                    code: HarnessErrorCode.UnknownPort,
                    message: `Edge target node "${edge.to.nodeId}" does not exist`,
                    edgeIndex: index,
                });
            }

            if (edgeKeys.has(edge.key)){
                issues.push({
                    code: HarnessErrorCode.DuplicateEdge,
                    message: `Duplicate edge "${edge.key}"`,
                    edgeIndex: index,
                });
            }
            edgeKeys.add(edge.key);

            if (fromNode === undefined || toNode === undefined) continue;

            const fromPort = findOutputPort(fromNode, edge.from.port);
            const toPort = findInputPort(toNode, edge.to.port);

            if (fromPort === undefined){
                issues.push({
                    code: HarnessErrorCode.UnknownPort,
                    message: `Node "${fromNode.id}" has no output port "${edge.from.port}"`,
                    nodeId: fromNode.id,
                    port: edge.from.port,
                    edgeIndex: index,
                });
            }
            if (toPort === undefined){
                issues.push({
                    code: HarnessErrorCode.UnknownPort,
                    message: `Node "${toNode.id}" has no input port "${edge.to.port}"`,
                    nodeId: toNode.id,
                    port: edge.to.port,
                    edgeIndex: index,
                });
            }

            if (fromPort !== undefined && toPort !== undefined
                && !isPortTypeCompatible(fromPort.type, toPort.type)){
                issues.push({
                    code: HarnessErrorCode.PortTypeMismatch,
                    message: `Cannot connect ${fromPort.type} output "${fromNode.id}.${fromPort.name}" `
                        + `to ${toPort.type} input "${toNode.id}.${toPort.name}"`,
                    nodeId: toNode.id,
                    port: toPort.name,
                    edgeIndex: index,
                });
            }

            if (fromPort !== undefined && toPort?.mode === "stream"
                && !supportsOutputMode(fromPort, "stream")){
                issues.push({
                    code: HarnessErrorCode.PortTypeMismatch,
                    message: `Output "${fromNode.id}.${fromPort.name}" does not support stream mode`,
                    nodeId: fromNode.id,
                    port: fromPort.name,
                    edgeIndex: index,
                });
            }

            const incomingKey = portKey(toNode.id, edge.to.port);
            const incoming = (incomingCounts.get(incomingKey) ?? 0) + 1;
            incomingCounts.set(incomingKey, incoming);

            if (incoming > 1 && toPort?.multiple !== true){
                issues.push({
                    code: HarnessErrorCode.MultipleInputEdges,
                    message: `Input "${toNode.id}.${edge.to.port}" accepts a single edge`,
                    nodeId: toNode.id,
                    port: edge.to.port,
                    edgeIndex: index,
                });
            }

            const next = adjacency.get(fromNode.id) ?? [];
            next.push(toNode.id);
            adjacency.set(fromNode.id, next);
        }

        for (const node of this.nodes){
            for (const port of node.inputs){
                if (port.required !== true) continue;
                if (incomingCounts.has(portKey(node.id, port.name))) continue;
                if (Object.prototype.hasOwnProperty.call(node.inputDefaults, port.name)) continue;

                issues.push({
                    code: HarnessErrorCode.MissingInput,
                    message: `Required input "${node.id}.${port.name}" is not connected`,
                    nodeId: node.id,
                    port: port.name,
                });
            }
        }

        const cycle = findCycle(this.nodes, adjacency);
        if (cycle !== undefined){
            issues.push({
                code: HarnessErrorCode.CycleDetected,
                message: `Graph contains a cycle: ${cycle.join(" -> ")}`,
            });
        }

        validateDeclarations(this, issues);
        if (this.toolSet !== undefined && !isToolSetSpec(this.toolSet)){
            issues.push({
                code: HarnessErrorCode.InvalidGraph,
                message: "Graph toolSet is not a valid ToolSetSpec",
            });
        }
        return issues;
    }

    /** 校验失败时抛出 HarnessError，issues 保留全部问题 */
    assertValid(): void{
        const issues = this.validate();
        if (issues.length === 0) return;

        const first = issues[0];
        throw new HarnessError(
            HarnessErrorCode.InvalidGraph,
            `Invalid graph: ${formatHarnessIssue(first)}`,
            {
                nodeId: first.nodeId,
                port: first.port,
                issues,
            },
        );
    }

    /** 启动一次运行；返回的 GraphRun 立即开始调度 */
    run(options: GraphRunOptions): GraphRun{
        return runGraph(this, options);
    }

    /** 序列化为纯 JSON 文档；不要求图已经通过 validate()，便于编辑器保存草稿 */
    toJSON(): GraphDocument{
        return serializeGraph(this);
    }

    static fromJSON(
        value: unknown,
        options: GraphDeserializeOptions,
    ): Graph{
        return deserializeGraph(value, options);
    }
}

function validatePorts(node: GraphNode, issues: HarnessIssue[]): void{
    const inputNames = new Set<string>();
    for (const port of node.inputs){
        if (port.name.length === 0){
            issues.push({
                code: HarnessErrorCode.InvalidPort,
                message: "Input port name must be non-empty",
                nodeId: node.id,
            });
        } else if (inputNames.has(port.name)){
            issues.push({
                code: HarnessErrorCode.InvalidPort,
                message: `Duplicate input port "${port.name}"`,
                nodeId: node.id,
                port: port.name,
            });
        } else {
            inputNames.add(port.name);
        }

        if (!isPortValueType(port.type)){
            issues.push({
                code: HarnessErrorCode.InvalidPort,
                message: `Input port "${port.name}" has an invalid type`,
                nodeId: node.id,
                port: port.name,
            });
        }
    }

    const inputModes = new Set(node.inputs.map((port) => port.mode ?? "value"));
    if (inputModes.size > 1){
        issues.push({
            code: HarnessErrorCode.InvalidNode,
            message: "A node cannot mix stream and value inputs in Step 3",
            nodeId: node.id,
        });
    }

    const outputNames = new Set<string>();
    for (const port of node.outputs){
        if (port.name.length === 0){
            issues.push({
                code: HarnessErrorCode.InvalidPort,
                message: "Output port name must be non-empty",
                nodeId: node.id,
            });
        } else if (outputNames.has(port.name)){
            issues.push({
                code: HarnessErrorCode.InvalidPort,
                message: `Duplicate output port "${port.name}"`,
                nodeId: node.id,
                port: port.name,
            });
        } else {
            outputNames.add(port.name);
        }

        if (!isPortValueType(port.type)){
            issues.push({
                code: HarnessErrorCode.InvalidPort,
                message: `Output port "${port.name}" has an invalid type`,
                nodeId: node.id,
                port: port.name,
            });
        }

        if (port.supportedModes !== undefined){
            if (port.supportedModes.length === 0
                || port.supportedModes.some((mode) => mode !== "value" && mode !== "stream")){
                issues.push({
                    code: HarnessErrorCode.InvalidPort,
                    message: `Output port "${port.name}" has an invalid mode declaration`,
                    nodeId: node.id,
                    port: port.name,
                });
            } else if (port.defaultMode !== undefined
                && !port.supportedModes.includes(port.defaultMode)){
                issues.push({
                    code: HarnessErrorCode.InvalidPort,
                    message: `Output port "${port.name}" default mode is not supported`,
                    nodeId: node.id,
                    port: port.name,
                });
            }
        }
    }
}

function validateInputDefaults(node: GraphNode, issues: HarnessIssue[]): void{
    const inputs = new Map<string, InputPortSpec>(
        node.inputs.map((port) => [port.name, port] as const),
    );

    for (const [name, value] of Object.entries(node.inputDefaults)){
        const port = inputs.get(name);
        if (port === undefined){
            issues.push({
                code: HarnessErrorCode.UnknownPort,
                message: `Node "${node.id}" has a default value for unknown input "${name}"`,
                nodeId: node.id,
                port: name,
            });
            continue;
        }

        if (!isHarnessValue(value)){
            issues.push({
                code: HarnessErrorCode.InvalidValue,
                message: `Default value for input "${node.id}.${name}" is not a valid HarnessValue`,
                nodeId: node.id,
                port: name,
            });
            continue;
        }

        if (!isHarnessValueCompatible(port.type, value)){
            issues.push({
                code: HarnessErrorCode.PortTypeMismatch,
                message: `Default value for input "${node.id}.${name}" is not compatible with ${port.type}`,
                nodeId: node.id,
                port: name,
            });
        }
    }
}

function validateDeclarations(graph: Graph, issues: HarnessIssue[]): void{
    const parameterNames = new Set<string>();
    for (const parameter of graph.parameters){
        if (parameter.name.length === 0 || parameterNames.has(parameter.name)){
            issues.push({
                code: HarnessErrorCode.InvalidGraph,
                message: `Invalid or duplicate graph parameter "${parameter.name}"`,
            });
        }
        parameterNames.add(parameter.name);
    }

    const eventNames = new Set<string>();
    for (const event of graph.events){
        if (event.name.length === 0 || eventNames.has(event.name)){
            issues.push({
                code: HarnessErrorCode.InvalidGraph,
                message: `Invalid or duplicate graph event "${event.name}"`,
            });
        }
        eventNames.add(event.name);
    }
}

function findInputPort(node: GraphNode, name: string): InputPortSpec | undefined{
    return node.inputs.find((port) => port.name === name);
}

function findOutputPort(node: GraphNode, name: string): OutputPortSpec | undefined{
    return node.outputs.find((port) => port.name === name);
}

function portKey(nodeId: string, port: string): string{
    return `${nodeId}\u0000${port}`;
}

function findCycle(
    nodes: readonly GraphNode[],
    adjacency: ReadonlyMap<string, readonly string[]>,
): readonly string[] | undefined{
    const state = new Map<string, 0 | 1 | 2>();
    const stack: string[] = [];

    const visit = (nodeId: string): readonly string[] | undefined => {
        state.set(nodeId, 1);
        stack.push(nodeId);

        for (const next of adjacency.get(nodeId) ?? []){
            const nextState = state.get(next);
            if (nextState === 1){
                const start = stack.indexOf(next);
                return [...stack.slice(start), next];
            }
            if (nextState === undefined){
                const cycle = visit(next);
                if (cycle !== undefined) return cycle;
            }
        }

        stack.pop();
        state.set(nodeId, 2);
        return undefined;
    };

    for (const node of nodes){
        if (state.has(node.id)) continue;
        const cycle = visit(node.id);
        if (cycle !== undefined) return cycle;
    }

    return undefined;
}
