import { runMinimalGraph } from "./minimal";
import type { GraphEvent } from "../../src/harness";

function printEvent(event: GraphEvent): void{
    switch (event.type){
        case "run:start":
            console.log(`[run] start graph=${event.graphId}`);
            break;
        case "node:start":
            console.log(`[node] start ${event.nodeId}`);
            break;
        case "node:stream":
            console.log(`[stream] ${event.nodeId}.${event.port} = ${JSON.stringify(event.chunk)}`);
            break;
        case "node:end":
            console.log(`[node] end   ${event.nodeId}`);
            break;
        case "node:error":
            console.error(`[node] error ${event.nodeId}:`, event.error);
            break;
        case "custom":
            console.log(`[event] ${event.name} = ${JSON.stringify(event.payload)}`);
            break;
        case "run:end":
            console.log(`[run] end   status=${event.status}`);
            break;
    }
}

const result = await runMinimalGraph(printEvent);

const output = result.outputs.text;
console.log(`\nfinal status: ${result.status}`);
console.log(`final output: ${output?.type === "text" ? output.text : "(no text output)"}`);

if (result.status !== "completed"){
    process.exitCode = 1;
}
