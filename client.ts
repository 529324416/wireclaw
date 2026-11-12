import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { LocalToolProvider, OllamaLLMProvider } from "./src/platform/index";
import {
    DEFAULT_SESSION_PERMISSION,
    RunStatus,
    Session,
    SessionHistory,
    SessionPermission,
    SessionSerializer,
    ToolRegistry,
} from "./src/session/index";
import { SessionEventType } from "./src/session/type";
import type { SessionEvent, SessionRuntimeOptions } from "./src/session/type";

/**
 * Rotom 控制台客户端。
 *
 * 用法：
 *   npx tsx client.ts
 *
 * 环境变量：
 *   OLLAMA_BASE_URL  默认 http://127.0.0.1:11434
 *   OLLAMA_MODEL     不填时优先选择 qwen3.5 9b，否则选择第一个支持 completion 的非 embedding 模型
 *
 * 命令：
 *   /exit                                退出
 *   /model <model-name>                  切换模型
 *   /list_models                         列出所有可用模型及其能力
 *   /permission [readonly|approval|full] 查看/切换会话权限等级
 *   /save_session [path]                 保存当前会话数据（默认 ./rotom-session.json）
 *   /restore_session [path]              读取会话数据并覆盖当前会话（会丢弃当前数据）
 */

const BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const DEFAULT_SESSION_PATH = "./rotom-session.json";

type ApprovalEvent = Extract<
    SessionEvent,
    { type: typeof SessionEventType.TOOL_APPROVAL_REQUIRED }
>;

function textOfContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return String(content ?? "");
    return content
        .map(part => {
            if (part && typeof part === "object" && "type" in part && part.type === "text") {
                return (part as { text?: unknown }).text;
            }
            return "";
        })
        .filter((text): text is string => typeof text === "string")
        .join("");
}

function shortJson(value: unknown, max = 240): string {
    let text: string;
    try {
        text = JSON.stringify(value) ?? String(value);
    } catch {
        text = String(value);
    }
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function parsePermission(value: string): SessionPermission | null {
    switch (value) {
        case SessionPermission.ReadOnly:
            return SessionPermission.ReadOnly;
        case SessionPermission.Approval:
            return SessionPermission.Approval;
        case SessionPermission.Full:
            return SessionPermission.Full;
        default:
            return null;
    }
}

async function resolveInitialModel(provider: OllamaLLMProvider): Promise<string> {
    const configured = process.env.OLLAMA_MODEL;
    if (configured !== undefined && configured.length > 0) {
        await provider.modelProvider.validateNetwork();
        return configured;
    }

    const models = await provider.modelProvider.initModels();
    const candidates = models.filter(model => model.supportCompletion && !model.isEmbeddingModel);
    if (candidates.length === 0) {
        throw new Error("No completion model is available in Ollama");
    }

    // 优先使用实机测试模型 qwen3.5:9b
    const preferred = candidates.find(model => model.name === "qwen3.5:9b")
        ?? candidates.find(model => /qwen3\.5.*9b/i.test(model.name));
    return (preferred ?? candidates[0]).name;
}

async function main(): Promise<void> {
    const provider = new OllamaLLMProvider(BASE_URL);
    const model = await resolveInitialModel(provider);

    const history = new SessionHistory();
    const runtimeOptions: SessionRuntimeOptions = {
        model,
        think: false,
    };
    const session = new Session(provider, history, runtimeOptions);

    const registry = new ToolRegistry();
    registry.registerProvider(new LocalToolProvider(process.cwd(), { id: "local" }));
    const workspace = process.cwd();

    let permission: SessionPermission = DEFAULT_SESSION_PERMISSION;
    let currentModel = model;
    let outputStarted = false;
    let thinkingStarted = false;

    const rl = createInterface({ input, output });

    const askApproval = async (event: ApprovalEvent): Promise<void> => {
        const { call, tool } = event;

        process.stdout.write(`\n[approval] ${call.name}\n`);
        process.stdout.write(`  params: ${shortJson(call.params, 400)}\n`);

        const risks: string[] = [];
        if (tool?.annotations?.destructiveHint === true) risks.push("destructive");
        if (tool?.annotations?.requiresApproval === true) risks.push("requires approval");
        if (risks.length > 0) process.stdout.write(`  risk: ${risks.join(", ")}\n`);

        let answer = "";
        try {
            answer = await rl.question("  approve? [y/N] ");
        } catch {
            answer = "";
        }

        const decision = /^y(es)?$/i.test(answer.trim()) ? "approve" : "deny";
        const resumed = session.resume(decision);
        process.stdout.write(
            resumed ? `  ${decision}\n` : "  (run is no longer waiting for approval)\n",
        );
    };

    session.subscribe((event: SessionEvent) => {
        switch (event.type) {
            case SessionEventType.ASSISTANT_START:
                outputStarted = false;
                thinkingStarted = false;
                break;

            case SessionEventType.ASSISTANT_TOKEN:
                if (event.isThinking) {
                    if (!thinkingStarted) {
                        process.stdout.write("thinking: ");
                        thinkingStarted = true;
                    }
                    process.stdout.write(event.token);
                } else {
                    if (thinkingStarted && !outputStarted) {
                        process.stdout.write("\n");
                    }
                    if (!outputStarted) {
                        process.stdout.write("assistant: ");
                        outputStarted = true;
                    }
                    process.stdout.write(event.token);
                }
                break;

            case SessionEventType.ASSISTANT_THINKING_OVER:
                if (thinkingStarted && !outputStarted) {
                    process.stdout.write("\n");
                }
                break;

            case SessionEventType.TOOL_CALL_START:
                process.stdout.write(`\n[tool] ${event.call.name} ${shortJson(event.call.params)}\n`);
                break;

            case SessionEventType.TOOL_CALL_END: {
                const status = event.result.status.isSuccess ? "ok" : "error";
                const detail = event.result.status.isSuccess
                    ? ""
                    : `: ${shortJson(textOfContent(event.result.content), 300)}`;
                process.stdout.write(`[tool] ${event.call.name} -> ${status}${detail}\n`);
                break;
            }

            case SessionEventType.TOOL_APPROVAL_REQUIRED:
                void askApproval(event);
                break;

            case SessionEventType.TOOL_PERMISSION_WARNING:
                process.stdout.write(`\n[warning] ${event.message}\n`);
                break;

            case SessionEventType.USER_ABORT:
                process.stdout.write("[canceled]\n");
                break;

            case SessionEventType.ERROR:
                process.stderr.write(`\n[error] ${textOfContent(event.msg)}\n`);
                break;

            default:
                break;
        }
    });

    process.on("SIGINT", () => {
        if (session.isBusy) {
            session.cancel();
            process.stdout.write("\n[canceling current run]\n");
            return;
        }

        process.stdout.write("\nbye\n");
        rl.close();
        process.exit(0);
    });

    console.log("Rotom Ollama console");
    console.log(`baseUrl:    ${BASE_URL}`);
    console.log(`model:      ${currentModel}`);
    console.log(`permission: ${permission}`);
    console.log(`workspace:  ${workspace}`);
    console.log("commands:   /exit, /model <name>, /list_models, /permission [readonly|approval|full]");
    console.log("            /save_session [path], /restore_session [path]");
    console.log("note:       /restore_session 会丢弃当前会话数据");
    console.log("");

    try {
        while (true) {
            let line: string;
            try {
                line = await rl.question("> ");
            } catch {
                break;
            }

            const userInput = line.trim();
            if (userInput.length === 0) continue;

            if (userInput.startsWith("/")) {
                const [rawCommand, ...args] = userInput.slice(1).split(/\s+/);
                const command = rawCommand.toLowerCase();

                if (command === "exit") {
                    break;
                }

                if (command === "model") {
                    const modelName = args.join(" ").trim();
                    if (modelName.length === 0) {
                        console.log(`usage: /model <model-name> (current: ${currentModel})`);
                    } else {
                        try {
                            session.switchModel(modelName);
                            currentModel = modelName;
                            console.log(`model switched to: ${currentModel}`);
                        } catch (error) {
                            console.error(`[model] ${errorMessage(error)}`);
                        }
                    }
                    continue;
                }

                if (command === "list_models" || command === "models") {
                    try {
                        const models = await provider.modelProvider.initModels();
                        console.log(`available models (${models.length}):`);
                        for (const [index, item] of models.entries()) {
                            const marks: string[] = [];
                            if (item.name === currentModel) marks.push("current");
                            if (item.supportToolCall) marks.push("tools");
                            if (item.supportThink) marks.push("thinking");
                            if (item.isVisionModel) marks.push("vision");
                            if (item.isEmbeddingModel) marks.push("embedding");
                            const suffix = marks.length > 0 ? ` [${marks.join(", ")}]` : "";
                            console.log(`  ${String(index + 1).padStart(2)}. ${item.name}${suffix}`);
                        }
                    } catch (error) {
                        console.error(`[list_models] ${errorMessage(error)}`);
                    }
                    continue;
                }

                if (command === "permission") {
                    const requested = args[0]?.toLowerCase();
                    if (requested === undefined) {
                        console.log(`permission: ${permission}`);
                    } else {
                        const next = parsePermission(requested);
                        if (next === null) {
                            console.log("usage: /permission [readonly|approval|full]");
                        } else if (session.isBusy) {
                            console.log("[permission] cannot change while running");
                        } else {
                            permission = next;
                            console.log(`permission switched to: ${permission}`);
                        }
                    }
                    continue;
                }

                if (command === "save_session" || command === "save") {
                    const rawPath = args.join(" ").trim();
                    const target = resolve(process.cwd(), rawPath.length > 0 ? rawPath : DEFAULT_SESSION_PATH);
                    const history = session.history;

                    if (history === undefined) {
                        console.log("[save_session] no active session");
                        continue;
                    }

                    try {
                        const data = SessionSerializer.serialize(history);
                        await mkdir(dirname(target), { recursive: true });
                        await writeFile(target, `${JSON.stringify(data, null, 2)}\n`, "utf8");
                        console.log(`[save_session] saved ${data.messages.length} messages to ${target}`);
                    } catch (error) {
                        console.error(`[save_session] ${errorMessage(error)}`);
                    }
                    continue;
                }

                if (command === "restore_session" || command === "restore") {
                    if (session.isBusy) {
                        console.log("[restore_session] session is busy");
                        continue;
                    }

                    const rawPath = args.join(" ").trim();
                    const target = resolve(process.cwd(), rawPath.length > 0 ? rawPath : DEFAULT_SESSION_PATH);

                    try {
                        // Windows 编辑器可能写入 UTF-8 BOM，先剥掉
                        const raw = (await readFile(target, "utf8")).replace(/^\uFEFF/, "");
                        const restored = SessionSerializer.deserialize(JSON.parse(raw) as unknown);
                        session.changeSession(restored);
                        console.log(`[restore_session] loaded ${restored.messages.length} messages from ${target}`);
                        console.log("[restore_session] current session data discarded");
                    } catch (error) {
                        console.error(`[restore_session] ${errorMessage(error)}`);
                    }
                    continue;
                }

                console.log(`unknown command: /${command}`);
                continue;
            }

            console.log("");
            try {
                const run = await session.run(userInput, { tools: registry, permission });

                if (run.status === RunStatus.Completed) {
                    process.stdout.write(
                        `\n[completed, ${run.pendingUsage.totalTokens} tokens, stop=${run.stopReason ?? "undefined"}]\n`,
                    );
                } else if (run.status === RunStatus.Failed) {
                    process.stderr.write(`\n[failed] ${errorMessage(run.error)}\n`);
                } else {
                    process.stdout.write(`\n[${run.status}]\n`);
                }
            } catch (error) {
                console.error(`[run] ${errorMessage(error)}`);
            }
        }
    } finally {
        rl.close();
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
