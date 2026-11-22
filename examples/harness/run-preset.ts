import {
    ECHO_AGENT_PRESET,
    createPresetDependencyGraph,
    describeFailure,
    runPresetDependencyExample,
} from "./preset-dependency";
import type { GraphEvent, GraphRunResult } from "../../src/harness";

function outputText(result: GraphRunResult): string{
    const output = result.outputs.text;
    return output?.type === "text" ? output.text : "(no text output)";
}

function printEvent(event: GraphEvent): void{
    if (event.type === "node:start" || event.type === "node:end"){
        console.log(`[node] ${event.type === "node:start" ? "start" : "end  "} ${event.nodeId}`);
    }
}

const graph = createPresetDependencyGraph();
const document = graph.toJSON();
const agentNode = document.nodes.find((node) => node.id === "agent");

console.log(`preset: ${ECHO_AGENT_PRESET.presetId} (${ECHO_AGENT_PRESET.name})`);
console.log(`requires: ${JSON.stringify(ECHO_AGENT_PRESET.requires)}`);
console.log(`serialized requires: ${JSON.stringify(agentNode?.requires)}`);
console.log("");

const demo = await runPresetDependencyExample(printEvent);

console.log(`[1] with tool:   status=${demo.completed.status}`);
console.log(`    output=${outputText(demo.completed)}`);
console.log("");
console.log(`[2] without tool: status=${demo.missing.status}`);
console.log(`    error=${describeFailure(demo.missing)}`);
console.log("");
console.log(`[3] restored:     status=${demo.restored.status}`);
console.log(`    output=${outputText(demo.restored)}`);

if (demo.completed.status !== "completed"
    || demo.missing.status !== "failed"
    || demo.restored.status !== "completed"){
    process.exitCode = 1;
}
