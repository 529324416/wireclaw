import type {
    HarnessValue,
    JsonValue,
    NodeOutputValues,
} from "./type";

export type GraphRunStatus = "completed" | "failed" | "cancelled" | "paused";

/**
 * Graph 运行事件。
 *
 * - 生命周期事件由运行时自动发出；
 * - `custom` 由 EventTrigger 节点发布，是 Graph 对外暴露的领域事件；
 * - 事件默认同步通知，listener 不应阻塞执行。
 */
export type GraphEvent =
    | {
        type: "run:start";
        runId: string;
        graphId: string;
        at: number;
    }
    | {
        type: "node:start";
        runId: string;
        nodeId: string;
        at: number;
    }
    | {
        type: "node:stream";
        runId: string;
        nodeId: string;
        port: string;
        chunk: HarnessValue;
        at: number;
    }
    | {
        type: "node:end";
        runId: string;
        nodeId: string;
        outputs: NodeOutputValues;
        at: number;
    }
    | {
        type: "node:error";
        runId: string;
        nodeId: string;
        error: unknown;
        at: number;
    }
    | {
        type: "custom";
        runId: string;
        nodeId: string;
        name: string;
        payload: JsonValue;
        seq: number;
        at: number;
    }
    | {
        type: "run:end";
        runId: string;
        status: GraphRunStatus;
        outputs: NodeOutputValues;
        at: number;
    };

export type GraphEventListener = (event: GraphEvent) => void;
