import assert from "node:assert/strict";

import {
    createAutoJoinBranchGraph,
    createBranchRegistry,
    runBranchLandingExample,
} from "../examples/harness/branching";
import {
    Graph,
    HarnessBuiltinNodeType,
    HarnessError,
    HarnessErrorCode,
} from "../src/harness";

const demo = await runBranchLandingExample();

assert.equal(demo.autoTrue.status, "completed");
const trueText = demo.autoTrue.outputs.text;
assert.equal(trueText?.type, "text");
if (trueText?.type === "text"){
    assert.equal(trueText.text, "hello-A");
}
assert.ok(demo.autoTrue.records.some((record) =>
    record.nodeId === "falsePath" && record.status === "skipped"));

assert.equal(demo.autoFalse.status, "completed");
const falseText = demo.autoFalse.outputs.text;
assert.equal(falseText?.type, "text");
if (falseText?.type === "text"){
    assert.equal(falseText.text, "hello-B");
}
assert.ok(demo.autoFalse.records.some((record) =>
    record.nodeId === "truePath" && record.status === "skipped"));

assert.equal(demo.ambiguous.status, "failed");
assert.ok(demo.ambiguous.error instanceof HarnessError);
assert.equal(demo.ambiguous.error?.code, HarnessErrorCode.AmbiguousJoin);

assert.equal(demo.explicitMerge.status, "completed");
const mergeText = demo.explicitMerge.outputs.text;
assert.equal(mergeText?.type, "text");
if (mergeText?.type === "text"){
    assert.equal(mergeText.text, "hello-A");
}

const document = createAutoJoinBranchGraph(true).toJSON();
assert.ok(!document.nodes.some(
    (node) => node.type === HarnessBuiltinNodeType.Merge,
));

const loaded = Graph.fromJSON(document, { registry: createBranchRegistry() });
const loadedResult = await loaded.run({
    host: { resolveProvider: () => undefined },
    input: {},
}).done;
assert.equal(loadedResult.status, "completed");
const loadedText = loadedResult.outputs.text;
assert.equal(loadedText?.type, "text");
if (loadedText?.type === "text"){
    assert.equal(loadedText.text, "hello-A");
}

console.log("PASS Landing B: implicit exclusive join, skipped, ambiguity, explicit merge");
