import { uniqueId } from "../../base";
import { HarnessError, HarnessErrorCode } from "../base/error";
import { isRecord } from "../base/utils";
import { HarnessBuiltinNodeType } from "../definition";
import type { Edge } from "../graph/edge";
import type { GraphEvent, GraphEventListener, GraphRunStatus } from "../graph/event";
import type { Graph } from "../graph/graph";
import type { GraphNode, NodeContext, NodeServices } from "../graph/node";
import {
    isHarnessValue,
    isHarnessValueCompatible,
} from "../graph/type";
import type {
    HarnessValue,
    NodeOutputValues,
} from "../graph/type";
import type {
    GraphHost,
    GraphRunInput,
    GraphRunOptions,
    GraphRunResult,
    NodeRunRecord,
} from "./types";

const DEFAULT_MAX_CONCURRENCY = 4;

/** 创建并立即开始一次 Graph 运行；监听器随 options 注入 */
export function runGraph(graph: Graph, options: GraphRunOptions): GraphRun{
    const run = new GraphRun(graph, options);
    run.start();
    return run;
}

/**
 * 一次 Graph 运行。
 *
 * @note Step 2 是 value-first：节点执行完成后把输出值交给下游；
 *       `ctx.emit` 只转发 node:stream 事件，流消费/EventTrigger 在后续步骤接入。
 */
export class GraphRun{

    readonly id: string;
    readonly done: Promise<GraphRunResult>;

    private readonly _graph: Graph;
    private readonly _host: GraphHost;
    private readonly _input: GraphRunInput;
    private readonly _maxConcurrency: number;
    private readonly _abort = new AbortController();
    private readonly _listeners = new Set<GraphEventListener>();
    private readonly _records: NodeRunRecord[] = [];
    private readonly _outputs = new Map<string, NodeOutputValues>();
    private readonly _inputEdges = new Map<string, Map<string, Edge[]>>();
    private readonly _dependents = new Map<string, string[]>();
    private readonly _pending = new Map<string, number>();
    private readonly _ready: string[] = [];
    private readonly _startedAt = Date.now();

    private _resolveDone!: (result: GraphRunResult) => void;
    private _status: GraphRunStatus = "running";
    private _result?: GraphRunResult;
    private _failure: unknown;
    private _cancelRequested = false;
    private _started = false;
    private _outputNode?: GraphNode;
    private _sequence = 0;

    constructor(graph: Graph, options: GraphRunOptions){
        this._graph = graph;
        this._host = options.host;
        this._input = options.input ?? {};
        this._maxConcurrency = normalizeConcurrency(options.maxConcurrency);
        this.id = `run-${uniqueId()}`;
        this.done = new Promise<GraphRunResult>((resolve) => {
            this._resolveDone = resolve;
        });

        if (options.listener !== undefined){
            this._listeners.add(options.listener);
        }
        if (options.signal !== undefined){
            if (options.signal.aborted){
                this.cancel();
            } else {
                options.signal.addEventListener("abort", () => this.cancel(), { once: true });
            }
        }
    }

    get status(): GraphRunStatus{
        return this._status;
    }

    get result(): GraphRunResult | undefined{
        return this._result;
    }

    onEvent(listener: GraphEventListener): () => void{
        this._listeners.add(listener);
        return () => {
            this._listeners.delete(listener);
        };
    }

    cancel(): void{
        if (this._status !== "running" || this._cancelRequested) return;
        this._cancelRequested = true;
        this._abort.abort();
    }

    start(): void{
        if (this._started) return;
        this._started = true;
        void this._run();
    }

    private async _run(): Promise<void>{
        this._emit({
            type: "run:start",
            runId: this.id,
            graphId: this._graph.id,
            at: Date.now(),
        });

        try{
            if (typeof this._host?.resolveProvider !== "function"){
                throw new HarnessError(
                    HarnessErrorCode.InvalidGraph,
                    "GraphRun requires a host with resolveProvider()",
                );
            }
            if (this._abort.signal.aborted){
                this._finish();
                return;
            }

            this._graph.assertValid();
            this._outputNode = this._selectOutputNode();
            this._prepareExecution();
            await this._execute();
        }catch(error){
            this._failure = error;
            this._abort.abort();
        }

        this._finish();
    }

    private _selectOutputNode(): GraphNode{
        const outputs = this._graph.nodes.filter(
            (node) => node.type === HarnessBuiltinNodeType.Output,
        );
        if (outputs.length === 0){
            throw new HarnessError(
                HarnessErrorCode.MissingOutputNode,
                `Graph "${this._graph.id}" has no ${HarnessBuiltinNodeType.Output} node`,
            );
        }
        if (outputs.length > 1){
            throw new HarnessError(
                HarnessErrorCode.DuplicateOutputNode,
                `Graph "${this._graph.id}" has multiple output nodes`,
            );
        }
        return outputs[0];
    }

    private _prepareExecution(): void{
        const dependencies = new Map<string, Set<string>>();

        for (const node of this._graph.nodes){
            dependencies.set(node.id, new Set());
            this._dependents.set(node.id, []);
            this._inputEdges.set(node.id, new Map());
        }

        for (const edge of this._graph.edges){
            const from = dependencies.get(edge.from.nodeId);
            const to = dependencies.get(edge.to.nodeId);
            if (from === undefined || to === undefined) continue;
            to.add(edge.from.nodeId);

            const byPort = this._inputEdges.get(edge.to.nodeId);
            if (byPort === undefined) continue;
            const edges = byPort.get(edge.to.port) ?? [];
            edges.push(edge);
            byPort.set(edge.to.port, edges);
        }

        for (const [nodeId, deps] of dependencies){
            this._pending.set(nodeId, deps.size);
            for (const from of deps){
                const next = this._dependents.get(from);
                if (next !== undefined) next.push(nodeId);
            }
            if (deps.size === 0) this._ready.push(nodeId);
        }
    }

    private async _execute(): Promise<void>{
        const active = new Set<Promise<void>>();

        const launch = (nodeId: string): void =>{
            let promise: Promise<void>;
            promise = this._executeNode(nodeId).finally(() => {
                active.delete(promise);
            });
            active.add(promise);
        };

        while (this._failure === undefined && !this._abort.signal.aborted){
            while (this._ready.length > 0 && active.size < this._maxConcurrency){
                const nodeId = this._ready.shift();
                if (nodeId !== undefined) launch(nodeId);
            }

            if (active.size === 0) break;
            await Promise.race(active);
        }

        // 失败/取消后等待已经启动的节点收尾，保证 records 完整
        while (active.size > 0){
            await Promise.race(active);
        }
    }

    private async _executeNode(nodeId: string): Promise<void>{
        const node = this._graph.getNode(nodeId);
        if (node === undefined) return;

        const record: NodeRunRecord = {
            nodeId,
            type: node.type,
            status: "completed",
            startedAt: Date.now(),
            endedAt: Date.now(),
        };
        this._emit({
            type: "node:start",
            runId: this.id,
            nodeId,
            at: Date.now(),
        });

        try{
            const inputs = this._resolveInputs(node);
            const outputs = await node.execute(this._createContext(node), inputs);

            if (!isRecord(outputs)){
                throw new HarnessError(
                    HarnessErrorCode.NodeExecutionFailed,
                    `Node "${node.id}" did not return an output object`,
                    { nodeId: node.id },
                );
            }

            if (node.type !== HarnessBuiltinNodeType.Output){
                this._validateOutputs(node, outputs);
            }

            this._outputs.set(node.id, outputs);
            record.outputs = outputs;
            record.endedAt = Date.now();
            this._records.push(record);
            this._emit({
                type: "node:end",
                runId: this.id,
                nodeId,
                outputs,
                at: record.endedAt,
            });
            this._notifyDependents(nodeId);
        }catch(error){
            const cancelled = this._abort.signal.aborted;
            record.status = cancelled ? "cancelled" : "failed";
            record.error = error;
            record.endedAt = Date.now();
            this._records.push(record);

            if (!cancelled){
                this._failure ??= error;
                this._abort.abort();
                this._emit({
                    type: "node:error",
                    runId: this.id,
                    nodeId,
                    error,
                    at: record.endedAt,
                });
            }
        }
    }

    private _resolveInputs(node: GraphNode): Record<string, HarnessValue>{
        const inputs: Record<string, HarnessValue> = {};
        const byPort = this._inputEdges.get(node.id);

        for (const port of node.inputs){
            const edges = byPort?.get(port.name) ?? [];
            if (edges.length === 0){
                const fallback = node.inputDefaults[port.name];
                if (fallback !== undefined){
                    inputs[port.name] = fallback;
                } else if (port.required === true){
                    throw new HarnessError(
                        HarnessErrorCode.MissingInput,
                        `Required input "${node.id}.${port.name}" has no value`,
                        { nodeId: node.id, port: port.name },
                    );
                }
                continue;
            }

            if (edges.length > 1){
                if (port.multiple !== true){
                    throw new HarnessError(
                        HarnessErrorCode.MultipleInputEdges,
                        `Input "${node.id}.${port.name}" accepts a single edge`,
                        { nodeId: node.id, port: port.name },
                    );
                }
                throw new HarnessError(
                    HarnessErrorCode.NotImplemented,
                    `Fan-in input "${node.id}.${port.name}" is not supported by the Step 2 runtime`,
                    { nodeId: node.id, port: port.name },
                );
            }

            const edge = edges[0];
            const source = this._outputs.get(edge.from.nodeId);
            const value = source?.[edge.from.port];
            if (value === undefined){
                throw new HarnessError(
                    HarnessErrorCode.MissingValue,
                    `Input "${node.id}.${port.name}" has no value from "${edge.from.nodeId}.${edge.from.port}"`,
                    { nodeId: node.id, port: port.name },
                );
            }
            inputs[port.name] = value;
        }

        return inputs;
    }

    private _validateOutputs(
        node: GraphNode,
        outputs: NodeOutputValues,
    ): void{
        for (const [name, value] of Object.entries(outputs)){
            const port = node.outputs.find((item) => item.name === name);
            if (port === undefined){
                throw new HarnessError(
                    HarnessErrorCode.InvalidValue,
                    `Node "${node.id}" returned unknown output "${name}"`,
                    { nodeId: node.id, port: name },
                );
            }
            if (!isHarnessValue(value)){
                throw new HarnessError(
                    HarnessErrorCode.InvalidValue,
                    `Node "${node.id}" output "${name}" is not a valid HarnessValue`,
                    { nodeId: node.id, port: name },
                );
            }
            if (!isHarnessValueCompatible(port.type, value)){
                throw new HarnessError(
                    HarnessErrorCode.PortTypeMismatch,
                    `Node "${node.id}" output "${name}" is not compatible with ${port.type}`,
                    { nodeId: node.id, port: name },
                );
            }
        }
    }

    private _notifyDependents(nodeId: string): void{
        for (const next of this._dependents.get(nodeId) ?? []){
            const remaining = (this._pending.get(next) ?? 1) - 1;
            this._pending.set(next, remaining);
            if (remaining === 0) this._ready.push(next);
        }
    }

    private _createContext(node: GraphNode): NodeContext{
        const host = this._host;
        const services: NodeServices = {
            resolveProvider: (providerId) => host.resolveProvider(providerId),
            resolveModel: (binding) =>{
                const provider = host.resolveProvider(binding.providerId);
                if (provider === undefined){
                    throw new HarnessError(
                        HarnessErrorCode.ProviderNotFound,
                        `Provider "${binding.providerId}" is not available`,
                        { nodeId: node.id },
                    );
                }
                return provider;
            },
            attachments: host.attachments,
            tools: host.tools,
            ...(host.onToolApproval === undefined
                ? {}
                : {
                    onToolApproval: (request) => host.onToolApproval!(request, node.id),
                }),
            ...(host.onUserInput === undefined
                ? {}
                : {
                    onUserInput: (request) => host.onUserInput!(request, node.id),
                }),
        };

        return {
            runId: this.id,
            signal: this._abort.signal,
            config: node.config,
            input: this._input,
            services,
            log: (level, message, data) =>{
                host.log?.(level, message, data);
            },
            emit: (port, chunk) =>{
                this._emit({
                    type: "node:stream",
                    runId: this.id,
                    nodeId: node.id,
                    port,
                    chunk,
                    at: Date.now(),
                });
            },
            publish: (event, payload) =>{
                this._sequence += 1;
                this._emit({
                    type: "custom",
                    runId: this.id,
                    nodeId: node.id,
                    name: event,
                    payload,
                    seq: this._sequence,
                    at: Date.now(),
                });
            },
        };
    }

    private _finish(): void{
        const status: GraphRunStatus = this._failure !== undefined
            ? "failed"
            : this._abort.signal.aborted
                ? "cancelled"
                : "completed";
        const outputs = this._outputNode === undefined
            ? {}
            : this._outputs.get(this._outputNode.id) ?? {};
        const endedAt = Date.now();

        const result: GraphRunResult = {
            runId: this.id,
            status,
            outputs,
            records: [...this._records],
            startedAt: this._startedAt,
            endedAt,
            ...(this._failure === undefined ? {} : { error: this._failure }),
        };

        this._status = status;
        this._result = result;
        this._emit({
            type: "run:end",
            runId: this.id,
            status,
            outputs,
            at: endedAt,
        });
        this._resolveDone(result);
    }

    private _emit(event: GraphEvent): void{
        for (const listener of [...this._listeners]){
            try{
                listener(event);
            }catch{
                // listener 异常不能破坏 GraphRun
            }
        }
    }
}

function normalizeConcurrency(value: number | undefined): number{
    if (value === undefined) return DEFAULT_MAX_CONCURRENCY;
    if (!Number.isInteger(value) || value < 1){
        throw new HarnessError(
            HarnessErrorCode.InvalidGraph,
            `maxConcurrency must be a positive integer, got ${String(value)}`,
        );
    }
    return value;
}
