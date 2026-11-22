import assert from "node:assert/strict";

import {
    ECHO_AGENT_PRESET,
    createPresetDependencyGraph,
    runPresetDependencyExample,
} from "../examples/harness/preset-dependency";
import {
    HarnessError,
    HarnessErrorCode,
} from "../src/harness";
import type { GraphEvent } from "../src/harness";

const events: GraphEvent[] = [];
const demo = await runPresetDependencyExample((event) => events.push(event));

assert.equal(demo.completed.status, "completed");
const completedText = demo.completed.outputs.text;
assert.equal(completedText?.type, "text");
if (completedText?.type === "text"){
    assert.equal(completedText.text, "tool result: echo:hello");
}

assert.equal(demo.missing.status, "failed");
assert.ok(demo.missing.error instanceof HarnessError);
assert.equal(demo.missing.error?.code, HarnessErrorCode.MissingToolDependency);
assert.match(
    demo.missing.error?.message ?? "",
    /tools__echo/,
);

assert.equal(demo.restored.status, "completed");
const restoredText = demo.restored.outputs.text;
assert.equal(restoredText?.type, "text");
if (restoredText?.type === "text"){
    assert.equal(restoredText.text, "tool result: echo:hello");
}

assert.deepEqual(ECHO_AGENT_PRESET.requires, [
    { kind: "tool", name: "tools__echo" },
]);

const document = createPresetDependencyGraph().toJSON();
assert.deepEqual(
    document.nodes.find((node) => node.id === "agent")?.requires,
    [{ kind: "tool", name: "tools__echo" }],
);

assert.ok(events.some((event) =>
    event.type === "node:start" && event.nodeId === "agent"));

console.log("PASS Landing A: preset -> tool dependency -> remove -> restore");
