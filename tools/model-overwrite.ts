import { readFile } from "node:fs/promises";

import type { AIProvider, ModelCapabilities, ModelInfo } from "../src/session/protocol";

/** modelOverwrite.json 中的单条模型能力覆盖 */
export type ModelOverwriteEntry = {
    id: string;
    info: Partial<ModelInfo>;
};

/** 读取本地模型静态能力配置
 * @param path JSON 文件路径
 * @returns 覆盖条目；文件不存在时返回空数组
 */
export async function loadModelOverwriteFile(path: string): Promise<ModelOverwriteEntry[]>{
    let raw: string;
    try{
        raw = await readFile(path, "utf8");
    }catch(error){
        if (isErrno(error, "ENOENT")) return [];
        throw error;
    }

    let parsed: unknown;
    try{
        parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    }catch(error){
        throw new Error(`Invalid modelOverwrite JSON: ${errorMessage(error)}`, { cause: error });
    }

    return parseModelOverwrite(parsed);
}

/** 解析模型能力配置
 * 支持两种写法：
 *   [{ "id": "qwen4-max", "capabilities": { ... } }]
 *   { "qwen4-max": { "capabilities": { ... } } }
 */
export function parseModelOverwrite(data: unknown): ModelOverwriteEntry[]{
    if (Array.isArray(data)){
        return data.map((item, index) => {
            if (!isRecord(item)){
                throw new Error(`modelOverwrite[${index}] must be an object`);
            }
            const id = typeof item.id === "string" ? item.id.trim() : "";
            if (id.length === 0){
                throw new Error(`modelOverwrite[${index}] requires a non-empty id`);
            }
            const { id: _id, ...info } = item;
            return { id, info: info as Partial<ModelInfo> };
        });
    }

    if (isRecord(data)){
        return Object.entries(data).map(([id, value]) => {
            const trimmed = id.trim();
            if (trimmed.length === 0){
                throw new Error("modelOverwrite model id must be non-empty");
            }
            if (!isRecord(value)){
                throw new Error(`modelOverwrite["${id}"] must be an object`);
            }
            return { id: trimmed, info: value as Partial<ModelInfo> };
        });
    }

    throw new Error("modelOverwrite must be an array or an object map");
}

/** 将文件覆盖应用到 Provider 已初始化的模型目录
 * @returns 实际应用的模型数量；模型不在该 Provider 目录时跳过。
 */
export async function applyModelOverwrites(
    provider: AIProvider,
    entries: readonly ModelOverwriteEntry[],
): Promise<number>{
    if (entries.length === 0) return 0;

    const modelProvider = provider.modelProvider;
    if (modelProvider === null) return 0;

    if (!modelProvider.isModelsInitialized){
        try{
            await modelProvider.initModels();
        }catch{
            // 无法初始化时没有默认 ModelInfo 可合并；不污染模型目录
            return 0;
        }
    }

    const models = modelProvider.availableModels ?? [];
    let applied = 0;

    for (const entry of entries){
        const base = models.find((model) => model.id === entry.id || model.name === entry.id);
        if (base === undefined) continue;

        provider.overwrite(base.id, mergeModelInfo(base, entry.info));
        applied += 1;
    }

    return applied;
}

/** 以模型初始化后的默认值为底，递归合并文件中的字段
 * @note 数组整体替换；对象递归合并；文件未出现的字段保留默认值。
 */
export function mergeModelInfo(base: ModelInfo, override: Partial<ModelInfo>): ModelInfo{
    const merged = mergeValue(cloneValue(base), override) as ModelInfo;

    // ModelInfo 的 bool 字段是派生值；若文件只写了 isVisionModel / supportToolCall 等，
    // 需要把它们翻译回 capabilities，否则 normalizeModelInfo 会再次按旧 capabilities 派生。
    if (override.capabilities === undefined){
        applyLegacyFlags(merged, override);
    }

    return {
        ...merged,
        id: base.id,
        name: override.name ?? base.name,
    };
}

function applyLegacyFlags(info: ModelInfo, override: Partial<ModelInfo>): void{
    const hasFlag = override.isVisionModel !== undefined
        || override.supportToolCall !== undefined
        || override.supportThink !== undefined
        || override.supportCompletion !== undefined;
    if (!hasFlag) return;

    const capabilities = cloneValue(info.capabilities);

    if (override.supportCompletion === false){
        if (capabilities !== undefined) delete capabilities.chat;
        info.capabilities = capabilities;
        return;
    }

    const needsChat = override.supportCompletion === true
        || override.isVisionModel !== undefined
        || override.supportToolCall !== undefined
        || override.supportThink !== undefined;
    if (!needsChat) return;

    const chat = capabilities?.chat ?? {
        input: ["text"],
        output: ["text"],
        streaming: true,
        tools: false,
        thinking: false,
    };
    const input = [...chat.input];

    if (override.isVisionModel !== undefined){
        const index = input.indexOf("image");
        if (override.isVisionModel && index < 0) input.push("image");
        if (!override.isVisionModel && index >= 0) input.splice(index, 1);
    }

    const next: ModelCapabilities = {
        ...capabilities,
        chat: {
            ...chat,
            input,
            output: (chat.output.length > 0 ? chat.output : ["text"]) as typeof chat.output,
            tools: override.supportToolCall ?? chat.tools,
            thinking: override.supportThink ?? chat.thinking,
        },
    };
    info.capabilities = next;
}

function cloneValue<T>(value: T): T{
    if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
    if (isRecord(value)){
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)){
            result[key] = cloneValue(item);
        }
        return result as T;
    }
    return value;
}

function mergeValue(base: unknown, override: unknown): unknown{
    if (override === undefined) return base;
    if (base === undefined) return override;
    if (!isRecord(base) || !isRecord(override)) return override;

    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)){
        if (value === undefined) continue;
        result[key] = mergeValue(base[key], value);
    }
    return result;
}

function isRecord(value: unknown): value is Record<string, unknown>{
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean{
    return typeof error === "object"
        && error !== null
        && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string{
    return error instanceof Error ? error.message : String(error);
}
