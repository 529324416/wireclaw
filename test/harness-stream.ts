import assert from "node:assert/strict";

import {
    Edge,
    Graph,
    HarnessBuiltinNodeType,
    createBuiltinNodeRegistry,
} from "../src/harness";
import type { GraphEvent } from "../src/harness";
import { assistant } from "../src/session/message";
import type { Message } from "../src/session/message";
import { AIProvider } from "../src/session/protocol";
import { ChatStopReason } from "../src/session/type";
import type {
    ChatOptions,
    ChatResult,
    ChatUsage,
    SessionRuntimeOptions,
} from "../src/session/type";

function section(title: string): void{
    console.log(`\n=== ${title} ===`);
}

function usage(): ChatUsage{
    return { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
}

class StreamingChatProvider extends AIProvider{

    get title(): string{
        return "streaming";
    }

    override get supportsTools(): boolean{
        return false;
    }

    async chat(
        _messages: readonly Message[],
        _options: SessionRuntimeOptions,
        turn?: ChatOptions,
    ): Promise<ChatResult>{
        turn?.onToken?.("think-1", true);
        turn?.onToken?.("think-2", true);
        turn?.onToken?.("hello", false);
        turn?.onToken?.(" world", false);

        return {
            message: assistant(
                "hello world",
                "think-1think-2",
                usage(),
                undefined,
                ChatStopReason.Stop,
            ),
        };
    }
}

function createRegistry() {
    return createBuiltinNodeRegistry();
}

function node(
    registry: ReturnType<typeof createRegistry>,
    id: string,
    type: string,
    config?: unknown,
) {
    return registry.createNode({
        id,
        type,
        typeVersion: 1,
        config: config as never,
    });
}

section("thinking / content 流与 EventTrigger");
{
    const registry = createRegistry();
    const provider = new StreamingChatProvider();
    const events: GraphEvent[] = [];
    const logs: string[] = [];

    const input = node(registry, "input", HarnessBuiltinNodeType.Input);
    const model = node(registry, "model", HarnessBuiltinNodeType.Model, {
        providerId: "fake",
        modelId: "stream-model",
    });
    const call = node(registry, "call", HarnessBuiltinNodeType.ModelCall, {
        mode: "chat",
    });
    const trigger = node(registry, "trigger", HarnessBuiltinNodeType.EventTrigger, {
        event: "thinking.delta",
    });
    const logSink = node(registry, "log", HarnessBuiltinNodeType.LogSink, {
        level: "info",
    });
    const output = node(registry, "output", HarnessBuiltinNodeType.Output);

    const graph = new Graph([
        input,
        model,
        call,
        trigger,
        logSink,
        output,
    ], [
        new Edge({ nodeId: "input", port: "text" }, { nodeId: "call", port: "prompt" }),
        new Edge({ nodeId: "model", port: "model" }, { nodeId: "call", port: "model" }),
        new Edge({ nodeId: "call", port: "thinking" }, { nodeId: "trigger", port: "signal" }),
        new Edge({ nodeId: "call", port: "text" }, { nodeId: "log", port: "signal" }),
        new Edge({ nodeId: "call", port: "text" }, { nodeId: "output", port: "text" }),
    ], { id: "stream-graph" });

    const result = await graph.run({
        host: {
            resolveProvider: () => provider,
            log: (_level, message) => logs.push(message),
        },
        input: { text: "hello" },
        listener: (event) => events.push(event),
    }).done;

    assert.equal(result.status, "completed");
    const text = result.outputs.text;
    assert.equal(text?.type, "text");
    if (text?.type === "text") assert.equal(text.text, "hello world");

    const custom = events.filter((event) =>
        event.type === "custom" && event.name === "thinking.delta");
    assert.equal(custom.length, 2);
    assert.deepEqual(
        custom.map((event) => event.type === "custom" ? event.payload : undefined),
        [
            { type: "text", text: "think-1" },
            { type: "text", text: "think-2" },
        ],
    );
    assert.deepEqual(logs, ["hello", " world"]);
    console.log("PASS thinking 流触发 ET，content 流进入 LogSink，最终值仍输出");
}

console.log("\nAll harness stream checks passed.");
