import {
    createAutoJoinBranchGraph,
    runBranchLandingExample,
} from "./branching";
import { HarnessError, HarnessBuiltinNodeType } from "../../src/harness";
import type { GraphRunResult } from "../../src/harness";

function outputText(result: GraphRunResult): string{
    const output = result.outputs.text;
    return output?.type === "text" ? output.text : "(no text output)";
}

function skippedNodes(result: GraphRunResult): string{
    const skipped = result.records
        .filter((record) => record.status === "skipped")
        .map((record) => record.nodeId);
    return skipped.length === 0 ? "(none)" : skipped.join(", ");
}

const autoDocument = createAutoJoinBranchGraph(true).toJSON();
const hasFilter = autoDocument.nodes.some(
    (node) => node.type === HarnessBuiltinNodeType.Filter,
);
console.log(`auto graph nodes: ${autoDocument.nodes.map((node) => node.type).join(", ")}`);
console.log(`auto graph contains FilterNode: ${String(hasFilter)}`);
console.log("");

const demo = await runBranchLandingExample();

console.log(`[1] branch true, implicit join: status=${demo.autoTrue.status}`);
console.log(`    output=${outputText(demo.autoTrue)}`);
console.log(`    skipped=${skippedNodes(demo.autoTrue)}`);
console.log("");

console.log(`[2] branch false, implicit join: status=${demo.autoFalse.status}`);
console.log(`    output=${outputText(demo.autoFalse)}`);
console.log(`    skipped=${skippedNodes(demo.autoFalse)}`);
console.log("");

console.log(`[3] concurrent sources, no policy: status=${demo.ambiguous.status}`);
if (demo.ambiguous.error instanceof HarnessError){
    console.log(`    error=${demo.ambiguous.error.code}: ${demo.ambiguous.error.message}`);
} else {
    console.log(`    error=${String(demo.ambiguous.error ?? "unknown")}`);
}
console.log("");

console.log(`[4] explicit FilterNode: status=${demo.explicitMerge.status}`);
console.log(`    output=${outputText(demo.explicitMerge)}`);

const ok = !hasFilter
    && demo.autoTrue.status === "completed"
    && demo.autoFalse.status === "completed"
    && demo.ambiguous.status === "failed"
    && demo.explicitMerge.status === "completed";

if (!ok){
    process.exitCode = 1;
}
