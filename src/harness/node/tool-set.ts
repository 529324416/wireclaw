import { HarnessError, HarnessErrorCode } from "../base/error";
import { HarnessBuiltinNodeType } from "../definition";
import { GraphNode } from "../graph/node";
import type { NodeContext } from "../graph/node";
import { isToolSetSpec } from "../graph/type";
import type {
    InputPortSpec,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "../graph/type";
import { readConfig } from "./helpers";

/** ToolSet 值节点：只保存选择规则，运行时由宿主 ToolRegistry 解析 */
export class ToolSetNode extends GraphNode{

    override readonly type = HarnessBuiltinNodeType.ToolSet;

    override get inputs(): readonly InputPortSpec[]{
        return [];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{
            name: "toolset",
            type: "toolset",
            supportedModes: ["value"],
            defaultMode: "value",
        }];
    }

    override async execute(
        _ctx: NodeContext,
        _inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const config = readConfig(this.config, this.type);
        if (!isToolSetSpec(config)){
            throw new HarnessError(
                HarnessErrorCode.InvalidNode,
                `${this.type} config must be a valid ToolSetSpec`,
                { nodeId: this.id },
            );
        }

        return {
            toolset: {
                type: "toolset",
                toolset: config,
            },
        };
    }
}
