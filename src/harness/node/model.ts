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
import { readConfig, readRequiredString, requireProviderRef } from "./helpers";

/**
 * 模型绑定节点；只保存 providerId + modelId，不包含 Provider 实例或密钥。
 *
 * providerId 有两个来源：
 * 1. 可选 `provider` 输入（来自 Provider 节点），连接时优先；
 * 2. config.providerId（手填 / 下拉）；
 * 连接存在时 config 只作为回退，不对节点输出生效。
 */
export class ModelNode extends GraphNode{

    override readonly type = HarnessBuiltinNodeType.Model;

    override get inputs(): readonly InputPortSpec[]{
        return [{
            name: "provider",
            type: "provider",
            required: false,
            description: "Provider 节点连入；优先级高于 config.providerId",
        }];
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
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const config = readConfig(this.config, this.type);
        const connectedProvider = inputs.provider;
        const providerId = connectedProvider === undefined
            ? readRequiredString(config, "providerId", this.type)
            : requireProviderRef(connectedProvider).providerId;
        const modelId = readRequiredString(config, "modelId", this.type);

        if (providerId.length === 0){
            throw new HarnessError(
                HarnessErrorCode.InvalidNode,
                `${this.type} requires a connected provider or config.providerId`,
                { nodeId: this.id },
            );
        }

        return {
            model: {
                type: "model",
                model: { providerId, modelId },
            },
        };
    }
}
