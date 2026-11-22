import {
    Edge,
    Graph,
    HarnessBuiltinNodeType,
    HarnessError,
    createBuiltinNodeRegistry,
    instantiateNodePreset,
} from "../../src/harness";
import type {
    GraphEventListener,
    GraphRunResult,
    NodePresetDocument,
} from "../../src/harness";
import { ToolMessage, assistant } from "../../src/session/message";
import type { Message } from "../../src/session/message";
import { AIProvider } from "../../src/session/protocol";
import { ToolRegistry } from "../../src/session/tool";
import type { ToolProvider } from "../../src/session/tool";
import { ChatStopReason } from "../../src/session/type";
import type {
    ChatOptions,
    ChatResult,
    ChatUsage,
    SessionRuntimeOptions,
    ToolCall,
    ToolCallResult,
    ToolDefinition,
} from "../../src/session/type";

const TOOL_NAME = "tools__echo";

/** 预设：一个使用 echo 工具的 B 节点 */
export const ECHO_AGENT_PRESET: NodePresetDocument = {
    version: 1,
    presetId: "echo-agent",
    name: "Echo Agent",
    description: "Agent preset that requires the echo tool",
    type: HarnessBuiltinNodeType.AgentRun,
    typeVersion: 1,
    config: {
        permission: "full",
        maxSteps: 3,
    },
    parameters: [{
        name: "maxSteps",
        path: "maxSteps",
        default: 3,
        description: "Agent loop max steps",
    }],
    requires: [{ kind: "tool", name: TOOL_NAME }],
    tags: ["example", "tool"],
};

class EchoToolProvider implements ToolProvider{

    readonly id = "tools";
    readonly name = "tools";
    readonly description = "example tools";

    async fetchTools(): Promise<ToolDefinition[]>{
        return [{
            name: "echo",
            description: "echo text",
            inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
            },
            annotations: { readOnlyHint: true },
        }];
    }

    async call(call: ToolCall): Promise<ToolCallResult>{
        return {
            content: `echo:${String(call.params.text)}`,
            status: { isSuccess: true, duration: 0 },
        };
    }
}

class ToolCallingChatProvider extends AIProvider{

    private _step = 0;

    get title(): string{
        return "preset-example";
    }

    override get supportsTools(): boolean{
        return true;
    }

    async chat(
        messages: readonly Message[],
        _options: SessionRuntimeOptions,
        _turn?: ChatOptions,
    ): Promise<ChatResult>{
        if (this._step === 0){
            this._step += 1;
            return {
                message: assistant("", undefined, usage(), [{
                    id: "call-echo",
                    name: TOOL_NAME,
                    params: { text: "hello" },
                }], ChatStopReason.ToolCall),
            };
        }

        this._step += 1;
        const toolMessage = findLastToolMessage(messages);
        return {
            message: assistant(
                `tool result: ${toolMessage === undefined ? "missing" : String(toolMessage.content)}`,
                undefined,
                usage(),
                undefined,
                ChatStopReason.Stop,
            ),
        };
    }
}

function usage(): ChatUsage{
    return { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
}

function findLastToolMessage(messages: readonly Message[]): ToolMessage | undefined{
    for (let index = messages.length - 1; index >= 0; index -= 1){
        const message = messages[index];
        if (message instanceof ToolMessage) return message;
    }
    return undefined;
}

export function createEchoToolRegistry(): ToolRegistry{
    const registry = new ToolRegistry();
    registry.registerProvider(new EchoToolProvider());
    return registry;
}

/**
 * 用节点预设创建 B 节点，并连成 Input -> Agent -> Output。
 *
 * @note 这个阶段先传入 available 工具目录，证明预设实例化时的依赖检查；
 *       后面的运行阶段会单独演示“工具被移除”。
 */
export function createPresetDependencyGraph(): Graph{
    const registry = createBuiltinNodeRegistry();
    const agent = instantiateNodePreset(ECHO_AGENT_PRESET, {
        registry,
        id: "agent",
        available: {
            tools: [TOOL_NAME],
        },
    });

    const input = registry.createNode({
        id: "input",
        type: HarnessBuiltinNodeType.Input,
        typeVersion: 1,
    });
    const model = registry.createNode({
        id: "model",
        type: HarnessBuiltinNodeType.Model,
        typeVersion: 1,
        config: {
            providerId: "example",
            modelId: "preset-model",
        },
    });
    const output = registry.createNode({
        id: "output",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });

    return new Graph([
        input,
        model,
        agent,
        output,
    ], [
        new Edge({ nodeId: "input", port: "text" }, { nodeId: "agent", port: "input" }),
        new Edge({ nodeId: "model", port: "model" }, { nodeId: "agent", port: "model" }),
        new Edge({ nodeId: "agent", port: "text" }, { nodeId: "output", port: "text" }),
    ], {
        id: "preset-dependency-graph",
        title: "Preset Dependency Landing",
        description: "Preset-created agent with a tool dependency",
    });
}

export type PresetDependencyDemo = {
    completed: GraphRunResult;
    missing: GraphRunResult;
    restored: GraphRunResult;
};

/** 运行三个阶段：有工具 -> 移除工具 -> 恢复工具 */
export async function runPresetDependencyExample(
    listener?: GraphEventListener,
): Promise<PresetDependencyDemo>{
    const graph = createPresetDependencyGraph();
    const input = { text: "please echo hello" };

    const completed = await graph.run({
        host: {
            resolveProvider: () => new ToolCallingChatProvider(),
            tools: createEchoToolRegistry(),
        },
        input,
        listener,
    }).done;

    const missing = await graph.run({
        host: {
            resolveProvider: () => new ToolCallingChatProvider(),
            tools: new ToolRegistry(),
        },
        input,
    }).done;

    const restored = await graph.run({
        host: {
            resolveProvider: () => new ToolCallingChatProvider(),
            tools: createEchoToolRegistry(),
        },
        input,
    }).done;

    return { completed, missing, restored };
}

/** 工具缺失时给出可读的错误码；供 CLI/测试复用 */
export function describeFailure(result: GraphRunResult): string{
    if (result.error instanceof HarnessError){
        return `${result.error.code}: ${result.error.message}`;
    }
    return String(result.error ?? result.status);
}
