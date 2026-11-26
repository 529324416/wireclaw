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

/**
 * Provider 绑定节点：把 Provider Profile id 作为 `provider` 值输出。
 *
 * 不持有 Provider 实例、密钥或模型；密钥由宿主在运行时按 providerId 解析。
 * Model 节点可把该输出连到 `provider` 输入，从而复用同一条 Provider 配置。
 */
export class ProviderNode extends GraphNode{

    override readonly type = HarnessBuiltinNodeType.Provider;

    override get inputs(): readonly InputPortSpec[]{
        return [];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{
            name: "provider",
            type: "provider",
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

        return {
            provider: {
                type: "provider",
                provider: { providerId },
            },
        };
    }
}
