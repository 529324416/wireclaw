import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { readMediaDuration, sanitizePathInput } from "./src/base";

import { LocalFileHost, readLocalSourcePath } from "./src/file/local";
import {
    DEEPSEEK_DEFAULT_BASE_URL,
    DeepSeekProvider,
    MiniMaxChatProvider,
    OllamaProvider,
    QWEN_DEFAULT_BASE_URL,
    QWEN_DEFAULT_CHAT_MODEL,
    QwenChatProvider,
} from "./src/platform/index";
import {
    applyQwenReferenceModelOverrides,
    createMcpProvider,
    LocalToolProvider,
} from "./src/client";
import {
    AttachmentFileManager,
    DEFAULT_SESSION_PERMISSION,
    detectMediaMimeType,
    extensionForMediaMimeType,
    HOST_TOOL_DEFINITIONS,
    mediaModalityFromMimeType,
    RunStatus,
    Session,
    SessionHistory,
    SessionPermission,
    SessionSerializer,
    ToolRegistry,
    validateMediaInputLimit,
} from "./src/session/index";
import type { ChatProvider, ModelInfo } from "./src/session/protocol";
import { SessionEventType } from "./src/session/type";
import type { Message } from "./src/session/message";
import type {
    SessionEvent,
    SessionRuntimeOptions,
    UserInputAnswer,
    UserInputResult,
} from "./src/session/type";

/**
 * Wireclaw 控制台客户端。
 *
 * 用法：
 *   npx tsx client.ts
 *
 * 环境变量：
 *   WIRECLAW_PROVIDER      启动时使用的 Provider：ollama / deepseek / minimax / qwen，默认 ollama
 *   OLLAMA_BASE_URL    默认 http://127.0.0.1:11434
 *   OLLAMA_MODEL       不填时优先选择 qwen3.5 9b，否则选择第一个支持 completion 的非 embedding 模型
 *   DEEPSEEK_API_KEY   直接指定 DeepSeek API key（优先于文件）
 *   DEEPSEEK_API_KEY_FILE 默认 ./apikey-ds.txt
 *   DEEPSEEK_BASE_URL  默认 https://api.deepseek.com
 *   DEEPSEEK_MODEL     默认 deepseek-flash
 *   MINIMAX_API_KEY    直接指定 MiniMax API key（优先于文件）
 *   MINIMAX_API_KEY_FILE 默认 ./apikey-minimax-h3.txt
 *   MINIMAX_BASE_URL   默认 https://api.minimax.cn
 *   MINIMAX_MODEL      默认 MiniMax-M3.1-Flash
 *   DASHSCOPE_API_KEY  直接指定 Qwen API key（优先于文件）
 *   QWEN_API_KEY_FILE  默认 ./apikey-qwen.txt
 *   QWEN_BASE_URL      默认 https://dashscope.aliyuncs.com/compatible-mode/v1
 *   QWEN_MODEL         默认 qwen-plus
 *   WIRECLAW_MCP_URL      默认 http://127.0.0.1:5000/mcp
 *   WIRECLAW_MCP_ID       MCP 工具名前缀，默认 mcp
 *   WIRECLAW_MCP_DISABLE  设为 1 时不注册 MCP Provider
 *
 * 命令：
 *   /exit                                退出
 *   /provider [providerId]               查看/切换 LLM Provider（ollama / deepseek / minimax / qwen）
 *   /model <model-name>                  切换当前 Provider 的模型
 *   /list_models                         列出当前 Provider 的可用模型及能力
 *   /tools                               列出当前可用的工具（含 MCP）
 *   /permission [readonly|approval|full] 查看/切换会话权限等级
 *   /upload <media-path>                 追加图片/音频/视频附件（按模型输入能力校验）
 *   /attachments                         列出会话附件并导出为 file:// 本地链接
 *   /save_session [path]                 保存当前会话数据（默认 ./wireclaw-session.json）
 *   /restore_session [path]              读取会话数据并覆盖当前会话（会丢弃当前数据）
 */

const BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const DEFAULT_SESSION_PATH = "./wireclaw-session.json";
const MCP_URL = process.env.WIRECLAW_MCP_URL ?? "http://127.0.0.1:5000/mcp";
const MCP_ID = process.env.WIRECLAW_MCP_ID ?? "mcp";
const MCP_DISABLED = process.env.WIRECLAW_MCP_DISABLE === "1";
const FILES_DIR = process.env.WIRECLAW_FILES_DIR ?? "./.wireclaw-files";
/** 控制台无法直接渲染媒体；把 assistant 生成的媒体导出为可点击的本地文件链接 */
const MEDIA_EXPORT_DIR = resolve(process.cwd(), FILES_DIR, "exports");
const SUPPORTED_MEDIA_EXTENSIONS = new Set([
    ".jpg", ".jpeg", ".png", ".webp", ".gif",
    ".mp3", ".wav", ".aac", ".amr", ".3gp", ".3gpp", ".m4a",
    ".mp4", ".avi", ".mkv", ".mov", ".flv", ".wmv", ".webm",
]);

const MEDIA_EXTENSION_MIME_TYPES = new Map<string, string>([
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".png", "image/png"],
    [".webp", "image/webp"],
    [".gif", "image/gif"],
    [".mp3", "audio/mpeg"],
    [".wav", "audio/wav"],
    [".aac", "audio/aac"],
    [".amr", "audio/amr"],
    [".3gp", "video/3gpp"],
    [".3gpp", "video/3gpp"],
    [".m4a", "audio/mp4"],
    [".mp4", "video/mp4"],
    [".avi", "video/x-msvideo"],
    [".mkv", "video/x-matroska"],
    [".mov", "video/quicktime"],
    [".flv", "video/x-flv"],
    [".wmv", "video/x-ms-wmv"],
    [".webm", "video/webm"],
]);

const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_DEFAULT_BASE_URL;
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-flash";
const DEEPSEEK_API_KEY_FILE = process.env.DEEPSEEK_API_KEY_FILE ?? "./apikey-ds.txt";
const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL ?? "https://api.minimax.cn";
const MINIMAX_MODEL = process.env.MINIMAX_MODEL ?? "MiniMax-M3.1-Flash";
const MINIMAX_API_KEY_FILE = process.env.MINIMAX_API_KEY_FILE ?? "./apikey-minimax-h3.txt";
const QWEN_BASE_URL = process.env.QWEN_BASE_URL ?? QWEN_DEFAULT_BASE_URL;
const QWEN_MODEL = process.env.QWEN_MODEL ?? QWEN_DEFAULT_CHAT_MODEL;
const QWEN_API_KEY_FILE = process.env.QWEN_API_KEY_FILE ?? "./apikey-qwen.txt";

const PROVIDER_IDS = ["ollama", "deepseek", "minimax", "qwen"] as const;
type ProviderId = (typeof PROVIDER_IDS)[number];

type ProviderRuntime = {
    id: ProviderId;
    label: string;
    endpoint: string;
    provider: ChatProvider;
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

type ExportedMedia = {
    path: string;
    url: string;
    name: string;
    mimeType?: string;
    size: number;
};

/** 收集会话历史中的唯一附件指纹 */
function collectAttachmentHashes(messages: readonly Message[]): string[] {
    const hashes = new Set<string>();
    for (const message of messages) {
        if (typeof message.content === "string") continue;
        for (const part of message.content) {
            if (part.type === "attachment") hashes.add(part.attachment.contentHash);
        }
    }
    return [...hashes];
}

/** 把附件从 IFileHost 导出为带扩展名的本地文件，供控制台点击打开 */
async function exportAttachmentFile(
    manager: AttachmentFileManager,
    contentHash: string,
): Promise<ExportedMedia | undefined> {
    const file = await manager.get(contentHash);
    if (file === undefined) return undefined;

    const rawName = basename(file.name.length > 0 ? file.name : `attachment-${contentHash.slice(0, 12)}`);
    const rawExtension = extname(rawName);
    const stem = (rawExtension.length > 0
        ? rawName.slice(0, -rawExtension.length)
        : rawName)
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
        .trim()
        .slice(0, 64) || "attachment";
    const suffix = (rawExtension.length > 0
        ? rawExtension.slice(1)
        : extensionForMediaMimeType(file.mimeType ?? "") ?? "bin")
        .replace(/[^A-Za-z0-9]+/g, "") || "bin";
    const fileName = `${contentHash.slice(0, 12)}-${stem}.${suffix}`;
    const target = resolve(MEDIA_EXPORT_DIR, fileName);

    await mkdir(MEDIA_EXPORT_DIR, { recursive: true });
    await writeFile(target, file.content);

    return {
        path: target,
        url: pathToFileURL(target).href,
        name: file.name.length > 0 ? file.name : fileName,
        mimeType: file.mimeType,
        size: file.size,
    };
}

function formatExportedMedia(media: ExportedMedia): string {
    return `${media.name} (${media.mimeType ?? "unknown"}, ${media.size} bytes)\n  ${media.url}`;
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

async function resolveInitialModel(provider: OllamaProvider): Promise<string> {
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
        case "minimax":
        case "mini":
            return "minimax";
        case "qwen":
        case "dashscope":
            return "qwen";
        default:
            return null;
    }
}

function providerLabel(id: ProviderId): string {
    switch (id) {
        case "ollama": return "Ollama";
        case "deepseek": return "DeepSeek";
        case "minimax": return "MiniMax";
        case "qwen": return "Qwen";
    }
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

async function readMiniMaxApiKey(): Promise<string> {
    const configured = process.env.MINIMAX_API_KEY?.trim();
    if (configured !== undefined && configured.length > 0) return configured;

    const keyPath = resolve(process.cwd(), sanitizePathInput(MINIMAX_API_KEY_FILE));
    let raw: string;
    try {
        raw = await readFile(keyPath, "utf8");
    } catch {
        throw new Error(`MiniMax API key file is not readable: ${keyPath}`);
    }

    let key = raw.replace(/^\uFEFF/, "").trim();
    const assignment = /^MINIMAX_API_KEY\s*=\s*(.+)$/m.exec(key);
    if (assignment !== null) key = assignment[1]?.trim() ?? "";
    key = key.replace(/^["']|["']$/g, "").trim();

    if (key.length === 0) {
        throw new Error(`MiniMax API key file is empty: ${keyPath}`);
    }
    return key;
}

async function readQwenApiKey(): Promise<string> {
    const configured = process.env.DASHSCOPE_API_KEY?.trim() ?? process.env.QWEN_API_KEY?.trim();
    if (configured !== undefined && configured.length > 0) return configured;

    const keyPath = resolve(process.cwd(), sanitizePathInput(QWEN_API_KEY_FILE));
    let raw: string;
    try {
        raw = await readFile(keyPath, "utf8");
    } catch {
        throw new Error(`Qwen API key file is not readable: ${keyPath}`);
    }

    let key = raw.replace(/^\uFEFF/, "").trim();
    const assignment = /^(?:DASHSCOPE_API_KEY|QWEN_API_KEY)\s*=\s*(.+)$/m.exec(key);
    if (assignment !== null) key = assignment[1]?.trim() ?? "";
    key = key.replace(/^["']|["']$/g, "").trim();

    if (key.length === 0) {
        throw new Error(`Qwen API key file is empty: ${keyPath}`);
    }
    return key;
}

async function createProvider(id: ProviderId): Promise<ProviderRuntime> {
    switch (id) {
        case "ollama": {
            const provider = new OllamaProvider(BASE_URL);
            const model = await resolveInitialModel(provider);
            return {
                id,
                label: providerLabel(id),
                endpoint: BASE_URL,
                provider,
                model,
            };
        }

        case "deepseek": {
            const apiKey = await readDeepSeekApiKey();
            const provider = new DeepSeekProvider({
                apiKey,
                baseUrl: DEEPSEEK_BASE_URL,
            });
            return {
                id,
                label: providerLabel(id),
                endpoint: DEEPSEEK_BASE_URL,
                provider,
                model: DEEPSEEK_MODEL,
            };
        }

        case "minimax": {
            const apiKey = await readMiniMaxApiKey();
            const provider = new MiniMaxChatProvider({
                apiKey,
                baseUrl: MINIMAX_BASE_URL,
                model: MINIMAX_MODEL,
            });
            return {
                id,
                label: providerLabel(id),
                endpoint: MINIMAX_BASE_URL,
                provider,
                model: MINIMAX_MODEL,
            };
        }

        case "qwen": {
            const apiKey = await readQwenApiKey();
            const provider = new QwenChatProvider({
                apiKey,
                baseUrl: QWEN_BASE_URL,
                model: QWEN_MODEL,
            });
            applyQwenReferenceModelOverrides(provider);
            return {
                id,
                label: providerLabel(id),
                endpoint: QWEN_BASE_URL,
                provider,
                model: QWEN_MODEL,
            };
        }
    }
}

/** Provider 实例缓存：切换回来时复用同一个 AIProvider 与其 CloudFileManager 缓存 */
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
    const requestedRaw = process.env.WIRECLAW_PROVIDER ?? "ollama";
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
    const attachmentManager = new AttachmentFileManager(fileHost, {
        readSourcePath: readLocalSourcePath,
    });
    const session = new Session(currentProviderRuntime.provider, history, runtimeOptions, attachmentManager);

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

            case SessionEventType.ASSISTANT_ATTACHMENT: {
                process.stdout.write(
                    `\n[attachment] ${event.name ?? event.attachment.contentHash}`
                    + (event.mimeType !== undefined ? ` (${event.mimeType})` : "")
                    + "\n",
                );
                // 控制台不能直接渲染图片/视频；导出到本地并打印可点击的 file:// 链接
                void exportAttachmentFile(attachmentManager, event.attachment.contentHash)
                    .then((media) => {
                        if (media === undefined) return;
                        process.stdout.write(`  ${media.url}\n`);
                    })
                    .catch((error: unknown) => {
                        process.stderr.write(
                            `[attachment] failed to export: ${errorMessage(error)}\n`,
                        );
                    });
                break;
            }

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

    console.log("Wireclaw console");
    console.log(`provider:   ${currentProviderRuntime.id} (${currentProviderRuntime.label})`);
    console.log(`endpoint:   ${currentProviderRuntime.endpoint}`);
    console.log(`model:      ${currentModel}`);
    console.log(`permission: ${permission}`);
    console.log(`workspace:  ${workspace}`);
    console.log(`files:      ${fileHost.rootDir}`);
    console.log(`mcp:        ${MCP_DISABLED ? "disabled" : MCP_URL}`);
    console.log("commands:   /exit, /provider [id], /model <name>, /list_models, /tools, /permission [readonly|approval|full]");
    console.log("            /upload <media-path>, /attachments, /save_session [path], /restore_session [path]");
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
                        console.log(`  endpoint: ${currentProviderRuntime.endpoint}`);
                        console.log(`  model:    ${currentModel}`);
                        for (const id of PROVIDER_IDS) {
                            const marks: string[] = [];
                            if (id === currentProviderRuntime.id) marks.push("current");
                            if (providerCache.has(id)) marks.push("initialized");
                            const suffix = marks.length > 0 ? ` [${marks.join(", ")}]` : "";
                            console.log(`  - ${id} (${providerLabel(id)})${suffix}`);
                        }
                        console.log("usage: /provider <ollama|deepseek|minimax|qwen>");
                        continue;
                    }

                    const requested = normalizeProviderId(requestedRaw);
                    if (requested === null) {
                        console.log(`usage: /provider <ollama|deepseek|minimax|qwen> (current: ${currentProviderRuntime.id})`);
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
                        session.setProvider(next.provider);
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
                        const modelProvider = currentProviderRuntime.provider.modelProvider;
                        let knownModels = modelProvider?.availableModels;
                        if (modelProvider !== null && knownModels === null) {
                            try {
                                knownModels = await modelProvider?.initModels();
                            } catch (error) {
                                console.log(`[model] capability check skipped: ${errorMessage(error)}`);
                            }
                        }
                        const modelInfo = knownModels?.find(
                            (item) => item.id === modelName || item.name === modelName,
                        );
                        if (modelInfo !== undefined && !modelInfo.supportCompletion) {
                            const kind = modelInfo.capabilities?.generate?.image === true
                                ? "an image generation model"
                                : "a non-chat model";
                            console.log(`[model] "${modelName}" is ${kind}, not a chat model`);
                            continue;
                        }

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
                    const modelProvider = currentProviderRuntime.provider.modelProvider;
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
                            for (const modality of item.capabilities?.chat?.output ?? []) {
                                if (modality !== "text") marks.push(modality);
                            }
                            if (item.capabilities?.generate?.image === true) marks.push("image");
                            if (item.capabilities?.generate?.audio === true) marks.push("audio");
                            if (item.capabilities?.generate?.video === true) marks.push("video");
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
                        console.log("usage: /upload <media-path>");
                        continue;
                    }

                    const target = resolve(process.cwd(), rawPath);
                    const extension = extname(target).toLowerCase();
                    if (!SUPPORTED_MEDIA_EXTENSIONS.has(extension)) {
                        console.log(
                            `[upload] unsupported media extension: ${extension || "(none)"}; `
                            + `supported: ${[...SUPPORTED_MEDIA_EXTENSIONS].join(", ")}`,
                        );
                        continue;
                    }

                    try {
                        const bytes = new Uint8Array(await readFile(target));
                        const mimeType = detectMediaMimeType(bytes)
                            ?? MEDIA_EXTENSION_MIME_TYPES.get(extension);
                        if (mimeType === undefined) {
                            console.log("[upload] file content is not a supported media type");
                            continue;
                        }

                        const modality = mediaModalityFromMimeType(mimeType);
                        if (modality === undefined) {
                            console.log(`[upload] unsupported media MIME type: ${mimeType}`);
                            continue;
                        }

                        const durationSeconds = modality === "audio" || modality === "video"
                            ? readMediaDuration(bytes, mimeType)
                            : undefined;

                        let modelInfo: ModelInfo | undefined;
                        const modelProvider = currentProviderRuntime.provider.modelProvider;
                        if (modelProvider !== null) {
                            try {
                                const models = modelProvider.availableModels
                                    ?? await modelProvider.initModels();
                                modelInfo = models.find(
                                    item => item.id === currentModel || item.name === currentModel,
                                );
                                const input = modelInfo?.capabilities?.chat?.input;
                                if (input !== undefined && !input.includes(modality)) {
                                    console.log(
                                        `[upload] model "${currentModel}" does not support ${modality} input`,
                                    );
                                    continue;
                                }
                            } catch (error) {
                                console.log(`[upload] model capability check skipped: ${errorMessage(error)}`);
                            }
                        }

                        const providerLimit = currentProviderRuntime
                            .provider.defaultModelLimits?.input?.[modality];
                        const modelLimit = modelInfo?.limits?.input?.[modality];
                        const limit = providerLimit === undefined
                            ? modelLimit
                            : modelLimit === undefined
                                ? providerLimit
                                : { ...providerLimit, ...modelLimit };
                        const problems = validateMediaInputLimit({
                            mimeType,
                            size: bytes.byteLength,
                            durationSeconds,
                        }, limit);
                        if (problems.length > 0) {
                            console.log(`[upload] ${modality} rejected: ${problems.join("; ")}`);
                            continue;
                        }

                        const file = await attachmentManager.put(
                            basename(target),
                            bytes,
                            mimeType,
                            [target],
                        );
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

                if (command === "attachments" || command === "media") {
                    const history = session.history;
                    if (history === undefined) {
                        console.log("[attachments] no active session");
                        continue;
                    }

                    const hashes = collectAttachmentHashes(history.messages);
                    if (hashes.length === 0) {
                        console.log("[attachments] no attachments in the current session");
                        continue;
                    }

                    console.log(`attachments (${hashes.length}):`);
                    for (const [index, contentHash] of hashes.entries()) {
                        try {
                            const media = await exportAttachmentFile(attachmentManager, contentHash);
                            if (media === undefined) {
                                console.log(`  ${index + 1}. ${contentHash} (missing in attachment store)`);
                                continue;
                            }
                            console.log(`  ${index + 1}. ${formatExportedMedia(media)}`);
                        } catch (error) {
                            console.error(`  ${index + 1}. ${contentHash}: ${errorMessage(error)}`);
                        }
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
                        await fileHost.flush();
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
        await attachmentManager.close();
        await registry.closeAll();
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
