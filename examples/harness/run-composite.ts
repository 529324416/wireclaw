import { runCompositeLandingExample } from "./composite";
import type { GraphRunResult } from "../../src/harness";

function textOutput(result: GraphRunResult): string{
    const output = result.outputs.text;
    return output?.type === "text" ? output.text : "(no text output)";
}

const demo = await runCompositeLandingExample();

console.log(`[1] subgraph: status=${demo.subgraph.status} output=${textOutput(demo.subgraph)}`);

const forEachResults = demo.forEach.outputs.json;
console.log(`[2] forEach:  status=${demo.forEach.status}`);
if (forEachResults?.type === "json" && Array.isArray(forEachResults.value)){
    console.log(`    results=${JSON.stringify(forEachResults.value)}`);
} else {
    console.log("    results=(missing)");
}

const loopValue = demo.loop.outputs.json;
console.log(`[3] loop:     status=${demo.loop.status}`);
console.log(`    value=${loopValue?.type === "json" ? JSON.stringify(loopValue.value) : "(missing)"}`);

console.log(`[4] checkpoint: graphId=${demo.checkpoint.graphId}`);
console.log(`    records=${demo.checkpoint.records.map((record) => `${record.nodeId}:${record.status}`).join(", ")}`);
console.log(`    resumed: status=${demo.resumed.status} output=${textOutput(demo.resumed)}`);

const ok = demo.subgraph.status === "completed"
    && textOutput(demo.subgraph) === "HELLO"
    && demo.forEach.status === "completed"
    && demo.loop.status === "completed"
    && demo.resumed.status === "completed"
    && textOutput(demo.resumed) === "x!!";

if (!ok){
    process.exitCode = 1;
}
