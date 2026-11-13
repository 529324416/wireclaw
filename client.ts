import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { sanitizePathInput } from "./src/base";
import { detectImageMimeType } from "./src/file";
import { LocalFileHost } from "./src/file/local";
import {
    DEEPSEEK_DEFAULT_BASE_URL,
    DeepSeekLLMProvider,
    OllamaLLMProvider,
} from "./src/platform/index";
import { createMcpProvider, LocalToolProvider } from "./src/tool/index";
import {
    DEFAULT_SESSION_PERMISSION,
    HOST_TOOL_DEFINITIONS,
    RunStatus,
    Session,
    SessionHistory,
    SessionPermission,
    SessionSerializer,
    ToolRegistry,
} from "./src/session/index";
import type { LLMProvider } from "./src/session/protocol";
import { SessionEventType } from "./src/session/type";
import type {
    SessionEvent,
    SessionRuntimeOptions,
    UserInputAnswer,
    UserInputResult,
} from "./src/session/type";

/**
 * Rotom 控制台客户端。
 *
 * 用法：
 *   npx tsx client.ts
 *
 * 环境变量：
 *   ROTOM_PROVIDER      启动时使用的 Provider：ollama / deepseek，默认 ollama
 *   OLLAMA_BASE_URL    默认 http://127.0.0.1:11434
 *   OLLAMA_MODEL       不填时优先选择 qwen3.5 9b，否则选择第一个支持 completion 的非 embedding 模型
 *   DEEPSEEK_API_KEY   直接指定 DeepSeek API key（优先于文件）
 *   DEEPSEEK_API_KEY_FILE 默认 ./ds-apikey.txt
 *   DEEPSEEK_BASE_URL  默认 https://api.deepseek.com
 *   DEEPSEEK_MODEL     默认 deepseek-flash
 *   ROTOM_MCP_URL      默认 http://127.0.0.1:5000/mcp
 *   ROTOM_MCP_ID       MCP 工具名前缀，默认 mcp
 *   ROTOM_MCP_DISABLE  设为 1 时不注册 MCP Provider
 *
 * 命令：
 *   /exit                                退出
 *   /provider [providerId]               查看/切换 LLM Provider（ollama / deepseek）
 *   /model <model-name>                  切换当前 Provider 的模型
 *   /list_models                         列出当前 Provider 的可用模型及能力
 *   /tools                               列出当前可用的工具（含 MCP）
 *   /permission [readonly|approval|full] 查看/切换会话权限等级
 *   /upload <image-path>                 追加一个图片附件（jpg/jpeg/png/webp/gif）
 *   /save_session [path]                 保存当前会话数据（默认 ./rotom-session.json）
 *   /restore_session [path]              读取会话数据并覆盖当前会话（会丢弃当前数据）
 */

const BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const DEFAULT_SESSION_PATH = "./rotom-session.json";
const MCP_URL = process.env.ROTOM_MCP_URL ?? "http://127.0.0.1:5000/mcp";
const MCP_ID = process.env.ROTOM_MCP_ID ?? "mcp";
const MCP_DISABLED = process.env.ROTOM_MCP_DISABLE === "1";
const FILES_DIR = process.env.ROTOM_FILES_DIR ?? "./.rotom-files";
const SUPPORTED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_DEFAULT_BASE_URL;
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-flash";
const DEEPSEEK_API_KEY_FILE = process.env.DEEPSEEK_API_KEY_FILE ?? "./ds-apikey.txt";

const PROVIDER_IDS = ["ollama", "deepseek"] as const;
type ProviderId = (typeof PROVIDER_IDS)[number];

type ProviderRuntime = {
    id: ProviderId;
    label: string;
    endpoint: string;
    llm: LLMProvider;
    model: string;
};

type ApprovalEvent = Extract<
    SessionEvent,
    { type: typeof SessionEventType.TOOL_APPROVAL_REQUIRED }
>;

type InputEvent = Extract<
    SessionEvent,
    { type: typeof SessionEventType.TOOL_INPUT_REQUIRED }
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

function normalizeProviderId(value: string): ProviderId | null {
    switch (value.trim().toLowerCase()) {
        case "ollama":
            return "ollama";
        case "deepseek":
        case "ds":
            return "deepseek";
        default:
            return null;
    }
}

function providerLabel(id: ProviderId): string {
    return id === "ollama" ? "Ollama" : "DeepSeek";
}

async function readDeepSeekApiKey(): Promise<string> {
    const configured = process.env.DEEPSEEK_API_KEY?.trim();
    if (configured !== undefined && configured.length > 0) return configured;

    const keyPath = resolve(process.cwd(), sanitizePathInput(DEEPSEEK_API_KEY_FILE));
    let raw: string;
    try {
        raw = await readFile(keyPath, "utf8");
    } catch {
        throw new Error(`DeepSeek API key file is not readable: ${keyPath}`);
    }

    let key = raw.replace(/^\uFEFF/, "").trim();
    const assignment = /^DEEPSEEK_API_KEY\s*=\s*(.+)$/m.exec(key);
    if (assignment !== null) key = assignment[1]?.trim() ?? "";
    key = key.replace(/^["']|["']$/g, "").trim();

    if (key.length === 0) {
        throw new Error(`DeepSeek API key file is empty: ${keyPath}`);
    }
    return key;
}

async function createProvider(id: ProviderId): Promise<ProviderRuntime> {
    switch (id) {
        case "ollama": {
            const llm = new OllamaLLMProvider(BASE_URL);
            const model = await resolveInitialModel(llm);
            return {
                id,
                label: providerLabel(id),
                endpoint: BASE_URL,
                llm,
                model,
            };
        }

        case "deepseek": {
            const apiKey = await readDeepSeekApiKey();
            const llm = new DeepSeekLLMProvider({
                apiKey,
                baseUrl: DEEPSEEK_BASE_URL,
            });
            return {
                id,
                label: providerLabel(id),
                endpoint: DEEPSEEK_BASE_URL,
                llm,
                model: DEEPSEEK_MODEL,
            };
        }
    }
}

/** Provider 实例缓存：切换回来时复用同一个 LLMProvider 与其 CloudFileManager 缓存 */
const providerCache = new Map<ProviderId, Promise<ProviderRuntime>>();

async function getProvider(id: ProviderId): Promise<ProviderRuntime> {
    const cached = providerCache.get(id);
    if (cached !== undefined) return await cached;

    const pending = createProvider(id).catch((error: unknown) => {
        providerCache.delete(id);
        throw error;
    });
    providerCache.set(id, pending);
    return await pending;
}

async function resolveStartupProvider(): Promise<ProviderRuntime> {
    const requestedRaw = process.env.ROTOM_PROVIDER ?? "ollama";
    const requested = normalizeProviderId(requestedRaw);
    if (requested === null) {
        throw new Error(`Unknown provider "${requestedRaw}"; expected one of: ${PROVIDER_IDS.join(", ")}`);
    }

    const order: ProviderId[] = [
        requested,
        ...PROVIDER_IDS.filter((id) => id !== requested),
    ];
    let lastError: unknown;

    for (const id of order) {
        try {
            const runtime = await getProvider(id);
            if (runtime.id !== requested) {
                console.log(`[provider] "${requested}" unavailable, fallback to "${runtime.id}"`);
            }
            return runtime;
        } catch (error) {
            lastError = error;
            console.error(`[provider:${id}] ${errorMessage(error)}`);
        }
    }

    throw lastError ?? new Error("No LLM provider is available");
}

async function main(): Promise<void> {
    let currentProviderRuntime = await resolveStartupProvider();
    let currentModel = currentProviderRuntime.model;

    const history = new SessionHistory();
    const runtimeOptions: SessionRuntimeOptions = {
        model: currentModel,
        think: false,
    };
    const fileHost = new LocalFileHost(resolve(process.cwd(), FILES_DIR));
    const session = new Session(currentProviderRuntime.llm, history, runtimeOptions, fileHost);

    const registry = new ToolRegistry({
        onProviderError: (providerId, error) => {
            process.stderr.write(`\n[provider:${providerId}] ${errorMessage(error)}\n`);
        },
    });
    registry.registerProvider(new LocalToolProvider(process.cwd(), { id: "local" }));

    if (!MCP_DISABLED) {
        registry.registerProvider(createMcpProvider({
            id: MCP_ID,
            name: "MCP",
            transport: { type: "http", url: MCP_URL },
        }));
    }

    const workspace = process.cwd();

    let permission: SessionPermission = DEFAULT_SESSION_PERMISSION;
    let outputStarted = false;
    let thinkingStarted = false;
    let pendingAttachments: string[] = [];

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

    const askUserInput = async (event: InputEvent): Promise<void> => {
        const { request } = event;
        process.stdout.write(`\n[input] ${request.title ?? "需要你的选择"}\n`);

        const answers: UserInputAnswer[] = [];

        for (const question of request.questions) {
            process.stdout.write(`\n  ${question.header ? `[${question.header}] ` : ""}${question.question}\n`);
            question.options.forEach((option, index) => {
                process.stdout.write(
                    `    ${index + 1}) ${option.label}${option.description ? ` - ${option.description}` : ""}\n`,
                );
            });

            let selected: string[] = [];
            while (true) {
                let line = "";
                try {
                    line = await rl.question(
                        question.multiSelect === true ? "  选择（逗号分隔）: " : "  选择: ",
                    );
                } catch {
                    line = "";
                }

                const trimmed = line.trim();
                if (trimmed.length === 0) {
                    const cancelled = session.respondUserInput({
                        requestId: request.id,
                        answers: [],
                        cancelled: true,
                    });
                    process.stdout.write(
                        cancelled ? "  cancelled\n" : "  (run is no longer waiting for input)\n",
                    );
                    return;
                }

                const indexes = trimmed.split(",").map((part) => Number.parseInt(part.trim(), 10));
                const valid = indexes.length > 0
                    && indexes.every((index) => Number.isInteger(index) && index >= 1 && index <= question.options.length)
                    && (question.multiSelect === true || indexes.length === 1);

                if (!valid) {
                    process.stdout.write("  无效选择\n");
                    continue;
                }

                selected = indexes.map((index) => question.options[index - 1].id);
                break;
            }

            answers.push({ questionId: question.id, selected });
        }

        const result: UserInputResult = { requestId: request.id, answers };
        const resumed = session.respondUserInput(result);
        process.stdout.write(resumed ? "  submitted\n" : "  (run is no longer waiting for input)\n");
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

            case SessionEventType.TOOL_PROGRESS:
                process.stdout.write(
                    `\n[progress] ${event.call.name} ${event.progress.progress}`
                    + (event.progress.total !== undefined ? `/${event.progress.total}` : "")
                    + (event.progress.message !== undefined ? ` ${event.progress.message}` : "")
                    + "\n",
                );
                break;

            case SessionEventType.TOOL_INPUT_REQUIRED:
                void askUserInput(event);
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
    });

    console.log("Rotom console");
    console.log(`provider:   ${currentProviderRuntime.id} (${currentProviderRuntime.label})`);
    console.log(`endpoint:   ${currentProviderRuntime.endpoint}`);
    console.log(`model:      ${currentModel}`);
    console.log(`permission: ${permission}`);
    console.log(`workspace:  ${workspace}`);
    console.log(`files:      ${fileHost.rootDir}`);
    console.log(`mcp:        ${MCP_DISABLED ? "disabled" : MCP_URL}`);
    console.log("commands:   /exit, /provider [id], /model <name>, /list_models, /tools, /permission [readonly|approval|full]");
    console.log("            /upload <image-path>, /save_session [path], /restore_session [path]");
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

                if (command === "provider") {
                    const requestedRaw = args[0]?.trim() ?? "";
                    if (requestedRaw.length === 0) {
                        console.log(`provider: ${currentProviderRuntime.id} (${currentProviderRuntime.label})`);
                        for (const id of PROVIDER_IDS) {
                            const marks: string[] = [];
                            if (id === currentProviderRuntime.id) marks.push("current");
                            if (providerCache.has(id)) marks.push("initialized");
                            const suffix = marks.length > 0 ? ` [${marks.join(", ")}]` : "";
                            console.log(`  - ${id} (${providerLabel(id)})${suffix}`);
                        }
                        console.log("usage: /provider <ollama|deepseek>");
                        continue;
                    }

                    const requested = normalizeProviderId(requestedRaw);
                    if (requested === null) {
                        console.log(`usage: /provider <ollama|deepseek> (current: ${currentProviderRuntime.id})`);
                        continue;
                    }
                    if (session.isBusy) {
                        console.log("[provider] cannot change while running");
                        continue;
                    }
                    if (requested === currentProviderRuntime.id) {
                        console.log(`provider already: ${currentProviderRuntime.id} (${currentModel})`);
                        continue;
                    }

                    try {
                        const next = await getProvider(requested);
                        session.setLLM(next.llm);
                        session.switchModel(next.model);
                        currentProviderRuntime = next;
                        currentModel = next.model;
                        console.log(`provider switched to: ${next.id} (${next.label})`);
                        console.log(`model: ${currentModel}`);
                    } catch (error) {
                        console.error(`[provider] ${errorMessage(error)}`);
                    }
                    continue;
                }

                if (command === "model") {
                    const modelName = args.join(" ").trim();
                    if (modelName.length === 0) {
                        console.log(`usage: /model <model-name> (current: ${currentModel})`);
                    } else {
                        try {
                            session.switchModel(modelName);
                            currentModel = modelName;
                            currentProviderRuntime.model = modelName;
                            console.log(`model switched to: ${currentModel}`);
                        } catch (error) {
                            console.error(`[model] ${errorMessage(error)}`);
                        }
                    }
                    continue;
                }

                if (command === "list_models" || command === "models") {
                    const modelProvider = currentProviderRuntime.llm.modelProvider;
                    if (modelProvider === null) {
                        console.log("[list_models] current provider has no model provider");
                        continue;
                    }

                    try {
                        const models = await modelProvider.initModels();
                        console.log(`available models (${models.length}):`);
                        for (const [index, item] of models.entries()) {
                            const marks: string[] = [];
                            if (item.id === currentModel || item.name === currentModel) marks.push("current");
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

                if (command === "tools") {
                    try {
                        const tools = [...await registry.listTools(), ...HOST_TOOL_DEFINITIONS];
                        console.log(`available tools (${tools.length}):`);
                        for (const tool of tools) {
                            const marks: string[] = [];
                            if (tool.annotations?.readOnlyHint === true) marks.push("readonly");
                            if (tool.annotations?.requiresApproval === true) marks.push("approval");
                            if (tool.annotations?.concurrencySafe === true) marks.push("concurrent");
                            const suffix = marks.length > 0 ? ` [${marks.join(", ")}]` : "";
                            console.log(`  - ${tool.name} (${tool.source?.providerId ?? "host"})${suffix}`);
                        }
                    } catch (error) {
                        console.error(`[tools] ${errorMessage(error)}`);
                    }
                    continue;
                }

                if (command === "upload") {
                    if (session.isBusy) {
                        console.log("[upload] cannot upload while running");
                        continue;
                    }

                    const rawPath = sanitizePathInput(args.join(" "));
                    if (rawPath.length === 0) {
                        console.log("usage: /upload <image-path>");
                        continue;
                    }

                    const target = resolve(process.cwd(), rawPath);
                    const extension = extname(target).toLowerCase();
                    if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
                        console.log(`[upload] unsupported image extension: ${extension || "(none)"}; supported: ${[...SUPPORTED_IMAGE_EXTENSIONS].join(", ")}`);
                        continue;
                    }

                    try {
                        const modelProvider = currentProviderRuntime.llm.modelProvider;
                        if (modelProvider !== null) {
                            try {
                                const models = modelProvider.availableModels
                                    ?? await modelProvider.initModels();
                                const modelInfo = models.find(item => item.id === currentModel || item.name === currentModel);
                                if (modelInfo !== undefined && !modelInfo.isVisionModel) {
                                    console.log(`[upload] note: model "${currentModel}" is not marked as vision; switch model before sending`);
                                }
                            } catch (error) {
                                console.log(`[upload] model capability check skipped: ${errorMessage(error)}`);
                            }
                        }

                        const bytes = new Uint8Array(await readFile(target));
                        const mimeType = detectImageMimeType(bytes);
                        if (mimeType === undefined) {
                            console.log("[upload] file content is not a supported image");
                            continue;
                        }

                        const file = await fileHost.put(basename(target), bytes, mimeType);
                        if (!pendingAttachments.includes(file.contentHash)) {
                            pendingAttachments.push(file.contentHash);
                        }

                        console.log(`[upload] ${file.name} (${mimeType}, ${file.size} bytes) hash=${file.contentHash}`);
                        console.log(`[upload] pending attachments: ${pendingAttachments.length}`);
                    } catch (error) {
                        console.error(`[upload] ${errorMessage(error)}`);
                    }
                    continue;
                }

                if (command === "save_session" || command === "save") {
                    const rawPath = sanitizePathInput(args.join(" "));
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

                    const rawPath = sanitizePathInput(args.join(" "));
                    const target = resolve(process.cwd(), rawPath.length > 0 ? rawPath : DEFAULT_SESSION_PATH);

                    try {
                        // Windows 编辑器可能写入 UTF-8 BOM，先剥掉
                        const raw = (await readFile(target, "utf8")).replace(/^\uFEFF/, "");
                        const restored = SessionSerializer.deserialize(JSON.parse(raw) as unknown);
                        session.changeSession(restored);
                        pendingAttachments = [];
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
                const attachments = pendingAttachments;
                pendingAttachments = [];

                const content = attachments.length === 0
                    ? userInput
                    : [
                        { type: "text" as const, text: userInput },
                        ...attachments.map(contentHash => ({
                            type: "attachment" as const,
                            attachment: { contentHash },
                        })),
                    ];

                const run = await session.run(content, { tools: registry, permission });

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
        await registry.closeAll();
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
