import { uniqueId } from "../../base";
import { graphFingerprint, graphNodeVersions } from "./fingerprint";
import { HarnessError, HarnessErrorCode } from "../base/error";
import { cloneJson, isRecord } from "../base/utils";
import { HarnessBuiltinNodeType } from "../definition";
import type { Edge } from "../graph/edge";
import type { GraphEvent, GraphEventListener, GraphRunStatus } from "../graph/event";
import type { Graph } from "../graph/graph";
import type { GraphNode, NodeContext, NodeServices } from "../graph/node";
import {
    harnessValueToJson,
    isHarnessValue,
    isHarnessValueCompatible,
    supportsOutputMode,
} from "../graph/type";
import type {
    HarnessValue,
    NodeOutputValues,
} from "../graph/type";
import { OutputChannel } from "./channel";
import { RunResultCollector } from "./run-result";
import type {
    GraphCheckpoint,
    GraphHost,
    GraphRunInput,
    GraphRunOptions,
    GraphRunResult,
    NodeRunRecord,
    RunResultEntry,
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
    private readonly _channels = new Map<string, OutputChannel<HarnessValue>>();
    private readonly _streamPorts = new Set<string>();
    private readonly _inputEdges = new Map<string, Map<string, Edge[]>>();
    private readonly _outgoingEdges = new Map<string, Edge[]>();
    private readonly _edgeStates = new Map<string, "value" | "skipped">();
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

    private _pauseRequested = false;
    private _pausePromise?: Promise<GraphCheckpoint>;
    private _pauseResolve?: (checkpoint: GraphCheckpoint) => void;
    private _pauseReject?: (error: unknown) => void;
    private _resumeWait?: () => void;
    private _lastCheckpoint?: GraphCheckpoint;
    private readonly _checkpoint?: GraphCheckpoint;
    private _restored = false;
    private readonly _collector: RunResultCollector;
    private readonly _graphPath: readonly string[];

    constructor(graph: Graph, options: GraphRunOptions){
        if (options.checkpoint !== undefined){
            validateCheckpointShape(options.checkpoint);
            if (options.checkpoint.graphId !== graph.id){
                throw new HarnessError(
                    HarnessErrorCode.InvalidCheckpoint,
                    `Checkpoint graphId "${options.checkpoint.graphId}" does not match "${graph.id}"`,
                );
            }

            const expectedHash = graphFingerprint(graph);
            if (options.checkpoint.graphHash !== expectedHash){
                throw new HarnessError(
                    HarnessErrorCode.InvalidCheckpoint,
                    "Checkpoint graph definition no longer matches the current graph",
                );
            }

            const expectedVersions = graphNodeVersions(graph);
            const checkpointVersions = options.checkpoint.nodeVersions;
            if (JSON.stringify(checkpointVersions) !== JSON.stringify(expectedVersions)){
                throw new HarnessError(
                    HarnessErrorCode.InvalidCheckpoint,
                    "Checkpoint node type versions no longer match the current graph",
                );
            }
        }

        this._graph = graph;
        this._host = options.host;
        this._checkpoint = options.checkpoint;
        this._input = options.checkpoint?.input ?? options.input ?? {};
        this._maxConcurrency = normalizeConcurrency(options.maxConcurrency);
        this._collector = options.resultCollector ?? new RunResultCollector();
        this._graphPath = options.graphPath ?? [];
        this.id = options.checkpoint?.runId ?? `run-${uniqueId()}`;
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

    get checkpoint(): GraphCheckpoint | undefined{
        return this._lastCheckpoint;
    }

    /** 运行期间已采集的 RunResult 条目快照（用于宿主逐步展示 / 落库）。 */
    get resultEntries(): readonly RunResultEntry[]{
        return this._collector.snapshot();
    }

    onEvent(listener: GraphEventListener): () => void{
        this._listeners.add(listener);
        return () => {
            this._listeners.delete(listener);
        };
    }

    /** 请求暂停；等当前活跃节点结束后返回 checkpoint */
    pause(): Promise<GraphCheckpoint>{
        if (this._status === "paused" && this._lastCheckpoint !== undefined){
            return Promise.resolve(this._lastCheckpoint);
        }
        if (this._status !== "running"){
            return Promise.reject(new HarnessError(
                HarnessErrorCode.InvalidRequest,
                `Cannot pause a run in status "${this._status}"`,
            ));
        }
        if (this._pausePromise !== undefined) return this._pausePromise;

        this._pauseRequested = true;
        this._pausePromise = new Promise<GraphCheckpoint>((resolve, reject) =>{
            this._pauseResolve = resolve;
            this._pauseReject = reject;
        });
        return this._pausePromise;
    }

    /** 恢复暂停中的 run；返回 false 表示当前不是 paused */
    resume(): boolean{
        if (this._status !== "paused") return false;

        this._status = "running";
        this._pauseRequested = false;
        this._emit({
            type: "run:resumed",
            runId: this.id,
            at: Date.now(),
        });
        const wake = this._resumeWait;
        this._resumeWait = undefined;
        wake?.();
        return true;
    }

    cancel(): void{
        if ((this._status !== "running" && this._status !== "paused")
            || this._cancelRequested){
            return;
        }

        this._cancelRequested = true;
        this._abort.abort();
        this._closeAllChannels();

        const reject = this._pauseReject;
        this._pauseReject = undefined;
        this._pauseResolve = undefined;
        this._pausePromise = undefined;
        reject?.(new HarnessError(
            HarnessErrorCode.InvalidRequest,
            "Run was cancelled before it could pause",
        ));

        const wake = this._resumeWait;
        this._resumeWait = undefined;
        wake?.();
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
            await this._validateRequirements();
            this._prepareExecution();
            if (this._checkpoint !== undefined){
                this._restoreCheckpoint(this._checkpoint);
            }

            while (true){
                const outcome = await this._execute();
                if (outcome !== "paused") break;

                const checkpoint = this._createCheckpoint();
                this._lastCheckpoint = checkpoint;
                this._status = "paused";
                this._emit({
                    type: "run:paused",
                    runId: this.id,
                    at: Date.now(),
                });

                const resolve = this._pauseResolve;
                this._pauseResolve = undefined;
                this._pauseReject = undefined;
                this._pausePromise = undefined;
                resolve?.(checkpoint);

                await new Promise<void>((resolveWait) =>{
                    this._resumeWait = resolveWait;
                });
                this._resumeWait = undefined;
            }
        }catch(error){
            this._failure = error;
            this._abort.abort();
            this._closeAllChannels();
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

    private async _validateRequirements(): Promise<void>{
        const nodes = this._graph.nodes
            .map((node) => ({ node, requirements: node.collectRequirements() }))
            .filter((entry) => entry.requirements.length > 0);
        if (nodes.length === 0) return;

        const needsTools = nodes.some((entry) =>
            entry.requirements.some((requirement) => requirement.kind === "tool"));
        const toolNames = new Set<string>();
        if (needsTools && this._host.tools !== undefined){
            const tools = await this._host.tools.listTools(this._abort.signal);
            for (const tool of tools) toolNames.add(tool.name);
        }

        const parameters = this._host.parameters ?? {};

        for (const { node, requirements } of nodes){
            for (const requirement of requirements){
                switch (requirement.kind){
                    case "tool":
                        if (!toolNames.has(requirement.name)){
                            throw new HarnessError(
                                HarnessErrorCode.MissingToolDependency,
                                `Node "${node.id}" requires tool "${requirement.name}", but it is not available`,
                                { nodeId: node.id },
                            );
                        }
                        break;

                    case "provider":
                        if (this._host.resolveProvider(requirement.providerId) === undefined){
                            throw new HarnessError(
                                HarnessErrorCode.MissingProviderDependency,
                                `Node "${node.id}" requires provider "${requirement.providerId}", but it is not available`,
                                { nodeId: node.id },
                            );
                        }
                        break;

                    case "model": {
                        const provider = this._host.resolveProvider(requirement.providerId);
                        if (provider === undefined){
                            throw new HarnessError(
                                HarnessErrorCode.MissingProviderDependency,
                                `Node "${node.id}" requires provider "${requirement.providerId}", but it is not available`,
                                { nodeId: node.id },
                            );
                        }

                        const models = provider.modelProvider?.availableModels;
                        if (models !== null && models !== undefined
                            && !models.some((model) => model.id === requirement.modelId)){
                            throw new HarnessError(
                                HarnessErrorCode.MissingModelDependency,
                                `Node "${node.id}" requires model "${requirement.providerId}/${requirement.modelId}", but it is not available`,
                                { nodeId: node.id },
                            );
                        }
                        break;
                    }

                    case "parameter":
                        if (!Object.prototype.hasOwnProperty.call(parameters, requirement.name)){
                            throw new HarnessError(
                                HarnessErrorCode.MissingParameterDependency,
                                `Node "${node.id}" requires parameter "${requirement.name}", but it is not provided`,
                                { nodeId: node.id },
                            );
                        }
                        break;
                }
            }
        }
    }

    private _prepareExecution(): void{
        for (const node of this._graph.nodes){
            this._pending.set(node.id, 0);
            this._inputEdges.set(node.id, new Map());
            this._outgoingEdges.set(node.id, []);
            for (const port of node.outputs){
                this._channels.set(
                    channelKey(node.id, port.name),
                    new OutputChannel<HarnessValue>(),
                );
            }
        }

        for (const edge of this._graph.edges){
            if (this._graph.getNode(edge.from.nodeId) === undefined
                || this._graph.getNode(edge.to.nodeId) === undefined){
                continue;
            }

            const outgoing = this._outgoingEdges.get(edge.from.nodeId);
            if (outgoing !== undefined) outgoing.push(edge);

            const byPort = this._inputEdges.get(edge.to.nodeId);
            if (byPort !== undefined){
                const edges = byPort.get(edge.to.port) ?? [];
                edges.push(edge);
                byPort.set(edge.to.port, edges);
            }

            const targetPort = this._graph.getNode(edge.to.nodeId)
                ?.inputs.find((port) => port.name === edge.to.port);
            if (targetPort?.mode === "stream"){
                this._streamPorts.add(channelKey(edge.from.nodeId, edge.from.port));
            } else {
                this._pending.set(
                    edge.to.nodeId,
                    (this._pending.get(edge.to.nodeId) ?? 0) + 1,
                );
            }
        }

        for (const node of this._graph.nodes){
            if ((this._pending.get(node.id) ?? 0) === 0){
                this._ready.push(node.id);
            }
        }
    }

    private async _execute(): Promise<"done" | "paused">{
        const active = new Set<Promise<void>>();
        const hasStreamConsumer = this._graph.nodes.some((node) =>
            node.inputs.some((port) => port.mode === "stream"));
        // 流消费者需要与上游并发运行；至少给它们留一个槽位
        const concurrency = hasStreamConsumer
            ? Math.max(2, this._maxConcurrency)
            : this._maxConcurrency;

        const launch = (nodeId: string): void =>{
            let promise: Promise<void>;
            promise = this._executeNode(nodeId).finally(() => {
                active.delete(promise);
            });
            active.add(promise);
        };

        while (this._failure === undefined
            && !this._abort.signal.aborted
            && !this._pauseRequested){
            while (this._ready.length > 0 && active.size < concurrency){
                const nodeId = this._ready.shift();
                if (nodeId !== undefined) launch(nodeId);
            }

            if (active.size === 0) break;
            await Promise.race(active);
        }

        const paused = this._pauseRequested
            && this._failure === undefined
            && !this._abort.signal.aborted;

        // 暂停时保留未启动节点的通道；失败/取消/完成时统一关闭
        if (!paused) this._closeAllChannels();
        while (active.size > 0){
            await Promise.race(active);
        }

        return paused ? "paused" : "done";
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
            const resolution = this._resolveInputs(node);
            if (resolution.skipped){
                this._closeNodeChannels(nodeId);
                record.status = "skipped";
                record.endedAt = Date.now();
                this._records.push(record);
                this._emit({
                    type: "node:skipped",
                    runId: this.id,
                    nodeId,
                    at: record.endedAt,
                });
                this._resolveOutgoing(nodeId, undefined);
                return;
            }

            const outputs = await node.execute(
                this._createContext(node),
                resolution.inputs,
            );

            if (this._abort.signal.aborted){
                throw new HarnessError(
                    HarnessErrorCode.NodeExecutionFailed,
                    `Node "${node.id}" completed after the run was aborted`,
                    { nodeId: node.id },
                );
            }

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

            this._closeNodeChannels(node.id);
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
            this._resolveOutgoing(nodeId, outputs);
        }catch(error){
            this._closeNodeChannels(nodeId);
            const cancelled = this._abort.signal.aborted;
            record.status = cancelled ? "cancelled" : "failed";
            record.error = error;
            record.endedAt = Date.now();
            this._records.push(record);

            if (!cancelled){
                this._failure ??= error;
                this._abort.abort();
                this._closeAllChannels();
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

    private _resolveInputs(node: GraphNode): {
        inputs: Record<string, HarnessValue>;
        skipped: boolean;
    }{
        const inputs: Record<string, HarnessValue> = {};
        const byPort = this._inputEdges.get(node.id);

        let connectedEdges = 0;
        let skippedEdges = 0;
        let availableValues = 0;
        let requiredSkipped = false;

        for (const port of node.inputs){
            const edges = byPort?.get(port.name) ?? [];
            if (port.mode === "stream"){
                if (edges.length === 0 && port.required === true){
                    throw new HarnessError(
                        HarnessErrorCode.MissingInput,
                        `Required stream input "${node.id}.${port.name}" has no source`,
                        { nodeId: node.id, port: port.name },
                    );
                }
                continue;
            }

            if (edges.length === 0){
                const fallback = node.inputDefaults[port.name];
                if (fallback !== undefined){
                    inputs[port.name] = fallback;
                    availableValues += 1;
                } else if (port.required === true){
                    throw new HarnessError(
                        HarnessErrorCode.MissingInput,
                        `Required input "${node.id}.${port.name}" has no value`,
                        { nodeId: node.id, port: port.name },
                    );
                }
                continue;
            }

            if (edges.length > 1
                && port.multiple !== true
                && port.join === "error"){
                throw new HarnessError(
                    HarnessErrorCode.MultipleInputEdges,
                    `Input "${node.id}.${port.name}" explicitly rejects multiple edges`,
                    { nodeId: node.id, port: port.name },
                );
            }

            connectedEdges += edges.length;
            const values: HarnessValue[] = [];

            for (const edge of edges){
                const state = this._edgeStates.get(edge.key);
                if (state === "skipped"){
                    skippedEdges += 1;
                    continue;
                }
                if (state !== "value"){
                    throw new HarnessError(
                        HarnessErrorCode.MissingValue,
                        `Input "${node.id}.${port.name}" is waiting for "${edge.from.nodeId}.${edge.from.port}"`,
                        { nodeId: node.id, port: port.name },
                    );
                }

                const source = this._outputs.get(edge.from.nodeId);
                const value = source?.[edge.from.port];
                if (value === undefined){
                    skippedEdges += 1;
                    continue;
                }
                values.push(value);
            }

            if (values.length === 0){
                if (port.required === true) requiredSkipped = true;
                continue;
            }

            if (port.multiple === true){
                inputs[port.name] = {
                    type: "json",
                    value: values.map(harnessValueToJson),
                };
                availableValues += values.length;
            } else {
                if (values.length > 1){
                    throw new HarnessError(
                        HarnessErrorCode.AmbiguousJoin,
                        `Input "${node.id}.${port.name}" received ${String(values.length)} values; `
                            + "use join \"all\" with multiple: true, an explicit MergeNode, or make the sources exclusive",
                        { nodeId: node.id, port: port.name },
                    );
                }
                inputs[port.name] = values[0];
                availableValues += 1;
            }
        }

        const skipped = requiredSkipped
            || (connectedEdges > 0 && skippedEdges === connectedEdges && availableValues === 0);
        return { inputs, skipped };
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

    private _resolveOutgoing(
        nodeId: string,
        outputs: NodeOutputValues | undefined,
    ): void{
        for (const edge of this._outgoingEdges.get(nodeId) ?? []){
            const targetPort = this._graph.getNode(edge.to.nodeId)
                ?.inputs.find((port) => port.name === edge.to.port);
            if (targetPort?.mode === "stream") continue;

            const value = outputs?.[edge.from.port];
            this._edgeStates.set(edge.key, value === undefined ? "skipped" : "value");

            const remaining = (this._pending.get(edge.to.nodeId) ?? 1) - 1;
            this._pending.set(edge.to.nodeId, remaining);
            if (remaining === 0) this._ready.push(edge.to.nodeId);
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
            defaultToolSet: this._graph.toolSet,
            parameters: host.parameters,
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
            stream: (port) => this._streamInput(node, port),
            emit: (port, chunk) => this._emitNodeChunk(node, port, chunk),
            collect: (entry) => this._collector.add(node, this._graphPath, entry),
            graphPath: this._graphPath,
            resultCollector: this._collector,
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

    private _streamInput(
        node: GraphNode,
        portName: string,
    ): AsyncIterable<HarnessValue>{
        const port = node.inputs.find((item) => item.name === portName);
        if (port === undefined || port.mode !== "stream"){
            throw new HarnessError(
                HarnessErrorCode.InvalidPort,
                `Node "${node.id}" has no stream input "${portName}"`,
                { nodeId: node.id, port: portName },
            );
        }

        const edges = this._inputEdges.get(node.id)?.get(portName) ?? [];
        if (edges.length === 0) return emptyStream();
        if (edges.length > 1 && port.multiple !== true){
            throw new HarnessError(
                HarnessErrorCode.MultipleInputEdges,
                `Stream input "${node.id}.${portName}" accepts a single source`,
                { nodeId: node.id, port: portName },
            );
        }

        const channels: OutputChannel<HarnessValue>[] = [];
        for (const edge of edges){
            const channel = this._channels.get(channelKey(edge.from.nodeId, edge.from.port));
            if (channel === undefined){
                throw new HarnessError(
                    HarnessErrorCode.MissingValue,
                    `Stream source "${edge.from.nodeId}.${edge.from.port}" is not available`,
                    { nodeId: node.id, port: portName },
                );
            }
            channels.push(channel);
        }

        return channels.length === 1 ? channels[0] : combineAllStreams(channels);
    }

    private _emitNodeChunk(
        node: GraphNode,
        portName: string,
        chunk: HarnessValue,
    ): void{
        const port = node.outputs.find((item) => item.name === portName);
        if (port === undefined){
            throw new HarnessError(
                HarnessErrorCode.InvalidValue,
                `Node "${node.id}" has no output port "${portName}"`,
                { nodeId: node.id, port: portName },
            );
        }
        if (!supportsOutputMode(port, "stream")){
            throw new HarnessError(
                HarnessErrorCode.InvalidValue,
                `Output "${node.id}.${portName}" does not support stream mode`,
                { nodeId: node.id, port: portName },
            );
        }
        if (!isHarnessValue(chunk) || !isHarnessValueCompatible(port.type, chunk)){
            throw new HarnessError(
                HarnessErrorCode.InvalidValue,
                `Stream chunk for "${node.id}.${portName}" is not a valid ${port.type} value`,
                { nodeId: node.id, port: portName },
            );
        }

        const key = channelKey(node.id, portName);
        const channel = this._channels.get(key);
        if (channel === undefined){
            throw new HarnessError(
                HarnessErrorCode.InvalidValue,
                `Node "${node.id}" has no output channel "${portName}"`,
                { nodeId: node.id, port: portName },
            );
        }

        // 没有 stream 消费者时只发 node:stream 事件，避免无界缓冲
        if (this._streamPorts.has(key)) channel.emit(chunk);
        this._emit({
            type: "node:stream",
            runId: this.id,
            nodeId: node.id,
            port: portName,
            chunk,
            at: Date.now(),
        });
    }

    private _closeNodeChannels(nodeId: string): void{
        const node = this._graph.getNode(nodeId);
        if (node === undefined) return;
        for (const port of node.outputs){
            this._channels.get(channelKey(nodeId, port.name))?.close();
        }
    }

    private _closeAllChannels(): void{
        for (const channel of this._channels.values()){
            channel.close();
        }
    }

    private _createCheckpoint(): GraphCheckpoint{
        return cloneJson<GraphCheckpoint>({
            version: 2,
            runId: this.id,
            graphId: this._graph.id,
            graphHash: graphFingerprint(this._graph),
            nodeVersions: graphNodeVersions(this._graph),
            input: this._input,
            outputs: Object.fromEntries(this._outputs),
            records: [...this._records],
            edgeStates: Object.fromEntries(this._edgeStates),
            pending: Object.fromEntries(this._pending),
            ready: [...this._ready],
        });
    }

    private _restoreCheckpoint(checkpoint: GraphCheckpoint): void{
        if (this._restored) return;
        this._restored = true;

        this._outputs.clear();
        for (const [nodeId, outputs] of Object.entries(checkpoint.outputs)){
            this._outputs.set(nodeId, outputs);
        }

        this._records.length = 0;
        this._records.push(...checkpoint.records);

        this._edgeStates.clear();
        for (const [key, state] of Object.entries(checkpoint.edgeStates)){
            this._edgeStates.set(key, state);
        }

        this._pending.clear();
        for (const [nodeId, count] of Object.entries(checkpoint.pending)){
            this._pending.set(nodeId, count);
        }

        this._ready.length = 0;
        this._ready.push(...checkpoint.ready);

        for (const record of checkpoint.records){
            if (record.status === "completed" || record.status === "skipped"){
                this._closeNodeChannels(record.nodeId);
            }
        }
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

        const rejectPause = this._pauseReject;
        this._pauseReject = undefined;
        this._pauseResolve = undefined;
        this._pausePromise = undefined;
        rejectPause?.(new HarnessError(
            HarnessErrorCode.InvalidRequest,
            "Run finished before it could pause",
        ));

        const result: GraphRunResult = {
            runId: this.id,
            graphId: this._graph.id,
            status,
            outputs,
            records: [...this._records],
            entries: this._collector.snapshot(),
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

function validateCheckpointShape(value: GraphCheckpoint): void{
    if (!isRecord(value)
        || value.version !== 2
        || typeof value.runId !== "string"
        || typeof value.graphId !== "string"
        || typeof value.graphHash !== "string"
        || value.graphHash.length === 0
        || !isRecord(value.nodeVersions)
        || !isRecord(value.input)
        || !isRecord(value.outputs)
        || !Array.isArray(value.records)
        || !isRecord(value.edgeStates)
        || !isRecord(value.pending)
        || !Array.isArray(value.ready)){
        throw new HarnessError(
            HarnessErrorCode.InvalidCheckpoint,
            "Invalid graph checkpoint shape",
        );
    }

    for (const state of Object.values(value.edgeStates)){
        if (state !== "value" && state !== "skipped"){
            throw new HarnessError(
                HarnessErrorCode.InvalidCheckpoint,
                "Invalid checkpoint edge state",
            );
        }
    }
    for (const count of Object.values(value.pending)){
        if (typeof count !== "number" || !Number.isInteger(count) || count < 0){
            throw new HarnessError(
                HarnessErrorCode.InvalidCheckpoint,
                "Invalid checkpoint pending count",
            );
        }
    }
    if (value.ready.some((nodeId) => typeof nodeId !== "string")){
        throw new HarnessError(
            HarnessErrorCode.InvalidCheckpoint,
            "Invalid checkpoint ready list",
        );
    }
    for (const version of Object.values(value.nodeVersions)){
        if (typeof version !== "number" || !Number.isInteger(version) || version < 1){
            throw new HarnessError(
                HarnessErrorCode.InvalidCheckpoint,
                "Invalid checkpoint node version",
            );
        }
    }
}

function channelKey(nodeId: string, port: string): string{
    return `${nodeId}\u0000${port}`;
}

async function* emptyStream(): AsyncGenerator<HarnessValue>{
    // 可选 stream 输入没有上游时立即结束
    return;
}

/** 多个 stream 源按“谁先到谁先出”汇合；所有通道关闭后结束 */
async function* combineAllStreams(
    channels: readonly OutputChannel<HarnessValue>[],
): AsyncGenerator<HarnessValue>{
    const queue: HarnessValue[] = [];
    let wake: (() => void) | undefined;
    let remaining = channels.length;

    const notify = (): void =>{
        const resolve = wake;
        wake = undefined;
        resolve?.();
    };

    for (const channel of channels){
        void (async () =>{
            try{
                for await (const chunk of channel){
                    queue.push(chunk);
                    notify();
                }
            }finally{
                remaining -= 1;
                notify();
            }
        })();
    }

    while (remaining > 0 || queue.length > 0){
        if (queue.length > 0){
            yield queue.shift() as HarnessValue;
            continue;
        }
        await new Promise<void>((resolve) =>{
            wake = resolve;
        });
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
