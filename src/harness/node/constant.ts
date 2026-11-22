import { HarnessError, HarnessErrorCode } from "../base/error";
import { HarnessBuiltinNodeType } from "../definition";
import { GraphNode } from "../graph/node";
import type { NodeContext } from "../graph/node";
import { isHarnessValue } from "../graph/type";
import type {
    InputPortSpec,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "../graph/type";
import { readConfig } from "./helpers";

/** 常量节点；config.value 必须是 HarnessValue */
export class ConstantNode extends GraphNode{

    override readonly type = HarnessBuiltinNodeType.Constant;

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
        _ctx: NodeContext,
        _inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const config = readConfig(this.config, this.type);
        const value = config.value;
        if (!isHarnessValue(value)){
            throw new HarnessError(
                HarnessErrorCode.InvalidNode,
                `${this.type}.value must be a valid HarnessValue`,
                { nodeId: this.id },
            );
        }
        return { value };
    }
}
