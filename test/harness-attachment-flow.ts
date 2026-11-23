import assert from "node:assert/strict";

import {
    Edge,
    Graph,
    GraphNode,
    HarnessBuiltinNodeType,
    createBuiltinNodeRegistry,
} from "../src/harness";
import type {
    InputPortSpec,
    NodeContext,
    NodeInputValues,
    NodeOutputValues,
    OutputPortSpec,
} from "../src/harness";

class AttachmentSourceNode extends GraphNode{

    override readonly type = "test.attachmentSource";

    override get inputs(): readonly InputPortSpec[]{
        return [{ name: "value", type: "any", required: true }];
    }

    override get outputs(): readonly OutputPortSpec[]{
        return [{ name: "attachments", type: "attachments" }];
    }

    override async execute(
        _ctx: NodeContext,
        inputs: NodeInputValues,
    ): Promise<NodeOutputValues>{
        const value = inputs.value;
        const index = value?.type === "json" && typeof value.value === "number"
            ? value.value
            : 0;
        return {
            attachments: {
                type: "attachments",
                attachments: [{
                    contentHash: String(index).padStart(64, "0"),
                }],
            },
        };
    }
}

function createRegistry() {
    const registry = createBuiltinNodeRegistry();
    registry.register({
        type: "test.attachmentSource",
        version: 1,
        create: (id, config, inputs, ui) => new AttachmentSourceNode(id, config, inputs, ui),
    });
    return registry;
}

function forEachInnerGraph(registry: ReturnType<typeof createRegistry>): Graph{
    const item = registry.createNode({
        id: "item",
        type: HarnessBuiltinNodeType.Value,
        typeVersion: 1,
        config: { name: "item" },
    });
    const source = registry.createNode({
        id: "source",
        type: "test.attachmentSource",
        typeVersion: 1,
    });
    const output = registry.createNode({
        id: "output",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });

    return new Graph([item, source, output], [
        new Edge({ nodeId: "item", port: "value" }, { nodeId: "source", port: "value" }),
        new Edge({ nodeId: "source", port: "attachments" }, { nodeId: "output", port: "attachments" }),
    ], { id: "attachment-foreach-inner" });
}

function loopInnerGraph(registry: ReturnType<typeof createRegistry>): Graph{
    const state = registry.createNode({
        id: "state",
        type: HarnessBuiltinNodeType.Value,
        typeVersion: 1,
        config: { name: "state" },
    });
    const source = registry.createNode({
        id: "source",
        type: "test.attachmentSource",
        typeVersion: 1,
    });
    const done = registry.createNode({
        id: "done",
        type: HarnessBuiltinNodeType.Constant,
        typeVersion: 1,
        config: { value: { type: "json", value: { state: 1, done: true } } },
    });
    const output = registry.createNode({
        id: "output",
        type: HarnessBuiltinNodeType.Output,
        typeVersion: 1,
    });

    return new Graph([state, source, done, output], [
        new Edge({ nodeId: "state", port: "value" }, { nodeId: "source", port: "value" }),
        new Edge({ nodeId: "source", port: "attachments" }, { nodeId: "output", port: "attachments" }),
        new Edge({ nodeId: "done", port: "value" }, { nodeId: "output", port: "json" }),
    ], { id: "attachment-loop-inner" });
}

const registry = createRegistry();
const host = { resolveProvider: () => undefined };

const forEachInner = forEachInnerGraph(registry).toJSON();
const items = registry.createNode({
    id: "items",
    type: HarnessBuiltinNodeType.Constant,
    typeVersion: 1,
    config: { value: { type: "json", value: [0, 1, 2] } },
});
const forEach = registry.createNode({
    id: "forEach",
    type: HarnessBuiltinNodeType.ForEach,
    typeVersion: 1,
    config: { graph: forEachInner } as never,
});
const forEachOutput = registry.createNode({
    id: "output",
    type: HarnessBuiltinNodeType.Output,
    typeVersion: 1,
});
const forEachGraph = new Graph([items, forEach, forEachOutput], [
    new Edge({ nodeId: "items", port: "value" }, { nodeId: "forEach", port: "items" }),
    new Edge({ nodeId: "forEach", port: "attachments" }, { nodeId: "output", port: "attachments" }),
], { id: "attachment-foreach" });

const forEachResult = await forEachGraph.run({ host }).done;
assert.equal(forEachResult.status, "completed");
const forEachAttachments = forEachResult.outputs.attachments;
assert.equal(forEachAttachments?.type, "attachments");
if (forEachAttachments?.type === "attachments"){
    assert.deepEqual(
        forEachAttachments.attachments.map((item) => item.contentHash),
        [0, 1, 2].map((index) => String(index).padStart(64, "0")),
    );
}

const loopInner = loopInnerGraph(registry).toJSON();
const initial = registry.createNode({
    id: "initial",
    type: HarnessBuiltinNodeType.Constant,
    typeVersion: 1,
    config: { value: { type: "json", value: 0 } },
});
const loop = registry.createNode({
    id: "loop",
    type: HarnessBuiltinNodeType.Loop,
    typeVersion: 1,
    config: { graph: loopInner, maxIterations: 1 } as never,
});
const loopOutput = registry.createNode({
    id: "output",
    type: HarnessBuiltinNodeType.Output,
    typeVersion: 1,
});
const loopGraph = new Graph([initial, loop, loopOutput], [
    new Edge({ nodeId: "initial", port: "value" }, { nodeId: "loop", port: "initial" }),
    new Edge({ nodeId: "loop", port: "attachments" }, { nodeId: "output", port: "attachments" }),
], { id: "attachment-loop" });

const loopResult = await loopGraph.run({ host }).done;
assert.equal(loopResult.status, "completed");
const loopAttachments = loopResult.outputs.attachments;
assert.equal(loopAttachments?.type, "attachments");
if (loopAttachments?.type === "attachments"){
    assert.equal(loopAttachments.attachments.length, 1);
}

console.log("PASS Loop/ForEach 携带并聚合附件");
