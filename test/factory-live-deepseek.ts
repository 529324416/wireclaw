import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createNewSession } from "../src/create";
import { DeepSeekProvider } from "../src/platform/deepseek";
import { RunStatus } from "../src/session/session";

const configured = process.env.DEEPSEEK_API_KEY?.trim();
const raw = configured ?? readFileSync(resolve(process.cwd(), "apikey-ds.txt"), "utf8")
    .replace(/^\uFEFF/, "")
    .trim();
const assignment = /^DEEPSEEK_API_KEY\s*=\s*(.+)$/m.exec(raw);
const apiKey = (assignment?.[1] ?? raw).replace(/^["']|["']$/g, "").trim();

const llm = new DeepSeekProvider({ apiKey });
const session = createNewSession(llm);
const run = await session.run("只回�?OK", { enableUserInput: false });

console.log(JSON.stringify({
    status: run.status,
    model: session.runtimeOptions.model,
    messages: session.history?.messages.length,
    text: String(session.history?.messages.at(-1)?.content ?? ""),
}));

if (run.status !== RunStatus.Completed) {
    process.exitCode = 1;
}
