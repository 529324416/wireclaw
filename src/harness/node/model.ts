import { HarnessBuiltinNodeType } from "../definition";
import { GraphNode } from "../graph/node";
import type { NodeContext } from "../graph/node";
import type {
    InputPortSpec,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "../graph/type";
import { readConfig, readRequiredString } from "./helpers";

/** 模型绑定节点；只保存 providerId + modelId，不包含 Provider 实例或密钥 */
export class ModelNode extends GraphNode{

    override readonly type = HarnessBuiltinNodeType.Model;

    override get inputs(): readonly InputPortSpec[]{
        return [];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{
            name: "model",
            type: "model",
            supportedModes: ["value"],
            defaultMode: "value",
        }];
    }

    override async execute(
        _ctx: NodeContext,
        _inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const config = readConfig(this.config, this.type);
        const providerId = readRequiredString(config, "providerId", this.type);
        const modelId = readRequiredString(config, "modelId", this.type);

        return {
            model: {
                type: "model",
                model: { providerId, modelId },
            },
        };
    }
}
