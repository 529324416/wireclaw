import { HarnessError, HarnessErrorCode } from "../base/error";
import { HarnessBuiltinNodeType } from "../definition";
import { GraphNode } from "../graph/node";
import type { NodeContext } from "../graph/node";
import type {
    InputPortSpec,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "../graph/type";
import { readConfig, readOptionalString } from "./helpers";

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

/** LogSink：把 text stream 逐块写入宿主日志 */
export class LogSinkNode extends GraphNode{

    override readonly type = HarnessBuiltinNodeType.LogSink;

    override get inputs(): readonly InputPortSpec[]{
        return [{
            name: "signal",
            type: "text",
            mode: "stream",
            required: true,
        }];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [];
    }

    override async execute(
        ctx: NodeContext,
        _inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const config = readConfig(this.config, this.type);
        const level = readLevel(config);

        for await (const chunk of ctx.stream("signal")){
            if (chunk.type !== "text") continue;
            ctx.log(level, chunk.text);
        }
        return {};
    }
}

function readLevel(config: Record<string, unknown>): LogLevel{
    const value = readOptionalString(config, "level", HarnessBuiltinNodeType.LogSink);
    if (value === undefined) return "info";
    if ((LOG_LEVELS as readonly string[]).includes(value)){
        return value as LogLevel;
    }

    throw new HarnessError(
        HarnessErrorCode.InvalidNode,
        `${HarnessBuiltinNodeType.LogSink}.level must be debug, info, warn or error`,
    );
}
