import { HarnessBuiltinNodeType } from "../definition";
import { GraphNode } from "../graph/node";
import type { NodeContext } from "../graph/node";
import type {
    InputPortSpec,
    JsonValue,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "../graph/type";
import { readConfig, readRequiredString } from "./helpers";

/**
 * EventTrigger：把 stream 输入逐块发布为 Graph 的 custom 事件。
 *
 * @note 它只发布事件，不做外部副作用；外部动作由宿主 listener 决定。
 */
export class EventTriggerNode extends GraphNode{

    override readonly type = HarnessBuiltinNodeType.EventTrigger;

    override get inputs(): readonly InputPortSpec[]{
        return [{
            name: "signal",
            type: "any",
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
        const event = readRequiredString(config, "event", this.type);

        for await (const chunk of ctx.stream("signal")){
            ctx.publish(event, chunk as unknown as JsonValue);
        }
        return {};
    }
}
