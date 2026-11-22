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
import {
    readConfig,
    readOptionalBoolean,
    readRequiredString,
} from "./helpers";

/** 从 GraphRunInput.values 中读取命名值；ForEach / Loop / 子图参数复用 */
export class ValueNode extends GraphNode{

    override readonly type = HarnessBuiltinNodeType.Value;

    override get inputs(): readonly InputPortSpec[]{
        return [];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{
            name: "value",
            type: "any",
            supportedModes: ["value"],
            defaultMode: "value",
        }];
    }

    override async execute(
        ctx: NodeContext,
        _inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const config = readConfig(this.config, this.type);
        const name = readRequiredString(config, "name", this.type);
        const required = readOptionalBoolean(config, "required", this.type) ?? true;
        const value = ctx.input.values?.[name];

        if (value === undefined){
            if (required){
                throw new HarnessError(
                    HarnessErrorCode.MissingValue,
                    `${this.type} requires input value "${name}"`,
                    { nodeId: this.id },
                );
            }
            return {};
        }

        return { value };
    }
}
