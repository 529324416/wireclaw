import { createNewSession } from "../src/create";
import { OllamaProvider } from "../src/platform/ollama";
import { RunStatus } from "../src/session/session";

const llm = new OllamaProvider();
const session = createNewSession(llm);
const run = await session.run("只回�?OK", { enableUserInput: false });

console.log(JSON.stringify({
    status: run.status,
    model: session.runtimeOptions.model,
    think: session.runtimeOptions.think,
    messages: session.history?.messages.length,
    text: String(session.history?.messages.at(-1)?.content ?? ""),
}));

if (run.status !== RunStatus.Completed) {
    process.exitCode = 1;
}
