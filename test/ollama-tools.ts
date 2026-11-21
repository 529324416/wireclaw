import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OllamaProvider } from "../src/platform/index";
import { LocalToolProvider } from "../src/client";
import { RunStatus, Session, SessionHistory } from "../src/session/session";
import { ToolRegistry } from "../src/session/tool";
import { SessionEventType, SessionPermission } from "../src/session/type";
import type { SessionEvent } from "../src/session/type";

/**
 * 实机测试：真�?Ollama + 本地工具 + 审批�? *
 * 运行�? *   npx tsx test/ollama-tools.ts
 *
 * 环境变量�? *   OLLAMA_BASE_URL  默认 http://127.0.0.1:11434
 *   OLLAMA_MODEL     默认 qwen3.5:9b
 */
const BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
const TIMEOUT_MS = 240_000;

function section(title: string): void {
    console.log(`\n=== ${title} ===`);
}

section("准备");

const root = await mkdtemp(join(tmpdir(), "wireclaw-ollama-"));
const note = "Wireclaw says hello.\n";

try {
    await writeFile(join(root, "note.txt"), note, "utf8");

    const provider = new OllamaProvider(BASE_URL);
    await provider.modelProvider.validateNetwork();
    console.log(`ollama: ${BASE_URL}, model: ${MODEL}`);

    const session = new Session(provider, new SessionHistory(), {
        model: MODEL,
        think: false,
    });

    const registry = new ToolRegistry();
    registry.registerProvider(new LocalToolProvider(root, { id: "local" }));
    console.log(`workspace: ${root}`);

    const toolCalls: string[] = [];
    const toolResults: string[] = [];
    let approvals = 0;

    session.subscribe((event: SessionEvent) => {
        switch (event.type) {
            case SessionEventType.TOOL_CALL_START:
                toolCalls.push(event.call.name);
                console.log(`\n[tool] ${event.call.name} ${JSON.stringify(event.call.params)}`);
                break;

            case SessionEventType.TOOL_CALL_END: {
                const ok = event.result.status.isSuccess;
                toolResults.push(`${event.call.name}:${ok ? "ok" : "error"}`);
                console.log(`[tool] ${event.call.name} -> ${ok ? "ok" : String(event.result.content)}`);
                break;
            }

            case SessionEventType.TOOL_APPROVAL_REQUIRED:
                approvals += 1;
                console.log(`[approval] ${event.call.name} (auto approve)`);
                session.resume("approve");
                break;

            case SessionEventType.TOOL_PERMISSION_WARNING:
                console.log(`[warning] ${event.message}`);
                break;

            case SessionEventType.ASSISTANT_TOKEN:
                if (!event.isThinking) process.stdout.write(event.token);
                break;

            case SessionEventType.ERROR:
                console.log(`\n[error] ${String(event.msg)}`);
                break;

            default:
                break;
        }
    });

    section("运行");

    const timeout = setTimeout(() => {
        console.log("\n[test] timeout, canceling session");
        session.cancel();
    }, TIMEOUT_MS);

    const run = await session.run(
        "Call local__readFile to read note.txt, then call local__writeFile to copy the content into copy.txt. "
            + "You must actually invoke the tools; do not just describe the steps.",
        {
            tools: registry,
            permission: SessionPermission.Approval,
            maxSteps: 8,
        },
    );

    clearTimeout(timeout);

    console.log(`\n\nstatus=${run.status}, usage=${run.pendingUsage.totalTokens}, steps=${run.step}`);
    console.log(`toolCalls=${JSON.stringify(toolCalls)}`);
    console.log(`toolResults=${JSON.stringify(toolResults)}`);
    console.log(`approvals=${approvals}`);

    section("断言");

    assert.equal(run.status, RunStatus.Completed, "run should complete");
    assert.ok(toolCalls.includes("local__readFile"), "model should call readFile");
    assert.ok(toolCalls.includes("local__writeFile"), "model should call writeFile");
    assert.equal(approvals, 1, "writeFile should trigger exactly one approval");

    const copied = await readFile(join(root, "copy.txt"), "utf8");
    assert.equal(copied.trim(), note.trim(), "copy.txt should contain the note content");

    console.log("PASS real model completed read -> approval -> write chain");
} finally {
    await rm(root, { recursive: true, force: true });
}
