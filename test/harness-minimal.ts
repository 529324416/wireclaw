import assert from "node:assert/strict";

import { runMinimalGraph } from "../examples/harness/minimal";
import type { GraphEvent } from "../src/harness";

const events: GraphEvent[] = [];
const result = await runMinimalGraph((event) => events.push(event));

assert.equal(result.status, "completed");

const output = result.outputs.text;
assert.equal(output?.type, "text");
if (output?.type === "text"){
    assert.equal(output.text, "HELLO HARNESS");
}

const started = events
    .filter((event) => event.type === "node:start")
    .map((event) => event.type === "node:start" ? event.nodeId : "");
assert.deepEqual(started, ["input", "uppercase", "output"]);

const stream = events.find((event) =>
    event.type === "node:stream"
    && event.nodeId === "uppercase"
    && event.port === "text");
assert.ok(stream !== undefined, "uppercase should emit a text stream chunk");
if (stream?.type === "node:stream"){
    assert.deepEqual(stream.chunk, { type: "text", text: "HELLO HARNESS" });
}

assert.ok(events.some((event) => event.type === "run:end" && event.status === "completed"));
console.log("PASS minimal graph: input -> uppercase -> output");
