import assert from "node:assert/strict";

import { runCompositeLandingExample } from "../examples/harness/composite";

const demo = await runCompositeLandingExample();

assert.equal(demo.subgraph.status, "completed");
const subgraphText = demo.subgraph.outputs.text;
assert.equal(subgraphText?.type, "text");
if (subgraphText?.type === "text") assert.equal(subgraphText.text, "HELLO");

assert.equal(demo.forEach.status, "completed");
const forEachResults = demo.forEach.outputs.json;
assert.equal(forEachResults?.type, "json");
if (forEachResults?.type === "json"){
    assert.deepEqual(forEachResults.value, [
        { type: "text", text: "ALPHA" },
        { type: "text", text: "BETA" },
        { type: "text", text: "GAMMA" },
    ]);
}

assert.equal(demo.loop.status, "completed");
const loopValue = demo.loop.outputs.json;
assert.equal(loopValue?.type, "json");
if (loopValue?.type === "json") assert.equal(loopValue.value, 3);

assert.equal(demo.checkpoint.version, 1);
assert.ok(demo.checkpoint.records.some((record) => record.nodeId === "first"));
assert.ok(!demo.checkpoint.records.some((record) => record.nodeId === "second"));

assert.equal(demo.resumed.status, "completed");
const resumedText = demo.resumed.outputs.text;
assert.equal(resumedText?.type, "text");
if (resumedText?.type === "text") assert.equal(resumedText.text, "x!!");

console.log("PASS Landing C: subgraph + foreach + loop + checkpoint resume");
