import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { OllamaLLMProvider } from "./src/platform/index";
import { Session, SessionHistory, RunStatus } from "./src/session/index";
import { SessionEventType } from "./src/session/type";
import type { SessionEvent, SessionRuntimeOptions } from "./src/session/type";

/**
 * 控制台测试客户端。
 *
 * 用法：
 *   npx tsx client.ts
 *
 * 环境变量：
 *   OLLAMA_BASE_URL  默认 http://127.0.0.1:11434
 *   OLLAMA_MODEL     不填时自动选择第一个支持 completion 的非 embedding 模型
 *
 * 命令：
 *   /exit                 退出
 *   /model <model-name>   切换模型
 */

const BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";

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

    return candidates[0].name;
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

    let currentModel = model;
    let outputStarted = false;
    let thinkingStarted = false;

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

    const rl = createInterface({ input, output });
    let inputClosed = false;
    rl.on("close", () => {
        inputClosed = true;
    });

    const prompt = () => {
        if (!inputClosed) rl.prompt();
    };

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
    console.log(`baseUrl: ${BASE_URL}`);
    console.log(`model:   ${currentModel}`);
    console.log("commands: /exit, /model <model-name>");
    console.log("");

    rl.setPrompt("> ");
    prompt();

    try {
        for await (const line of rl) {
            const userInput = line.trim();
            if (userInput.length === 0) {
                prompt();
                continue;
            }

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
                    }else{
                        try {
                            session.switchModel(modelName);
                            currentModel = modelName;
                            console.log(`model switched to: ${currentModel}`);
                        } catch (error) {
                            console.error(`[model] ${error instanceof Error ? error.message : String(error)}`);
                        }
                    }
                    prompt();
                    continue;
                }

                console.log(`unknown command: /${command}`);
                prompt();
                continue;
            }

            console.log("");
            const run = await session.run(userInput);

            if (run.status === RunStatus.Completed) {
                process.stdout.write(
                    `\n[completed, ${run.pendingUsage.totalTokens} tokens, stop=${run.stopReason ?? "undefined"}]\n`,
                );
            } else if (run.status === RunStatus.Failed) {
                const message = run.error instanceof Error ? run.error.message : String(run.error);
                process.stderr.write(`\n[failed] ${message}\n`);
            } else {
                process.stdout.write(`\n[${run.status}]\n`);
            }

            prompt();
        }
    } finally {
        rl.close();
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
