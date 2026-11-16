/* Session模块协议定义 */

import type { AttachmentFile } from "./attachment";
import { handleSessionError } from "./error";
import type { GeneratedMedia } from "./media";
import type { AssistantMessage, Message } from "./message";
import type {
    AttachmentRef,
    AttachmentWireMap,
    ChatOptions,
    ChatResult,
    ModelThinkingLevel,
    RemoteFileRef,
    SessionRuntimeOptions,
    StreamChunk,
    ToolDefinition,
} from "./type";


/** 协议适配器，描述不同平台的协议差异
 * @note 附件必须由适配器按平台协议编码：Ollama 使用 images(base64)，OpenAI 可能使用
 *       image_url/data URL/file_id，其他平台可能使用 URL。Session 只提供 RemoteFileRef 映射。
 */
export abstract class ProtocolAdapter{

    /** 转换工具定义列表为该平台的请求格式。
     *  默认实现走 OpenAI 兼容格式（Ollama / OpenAI / DeepSeek 等都通用）。
     *  平台不同（如 Anthropic 用 input_schema）时覆写此方法。
     */
    toolDefinitionsToPayload(tools: readonly ToolDefinition[]): unknown {
        return tools.map((tool) => ({
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
            },
        }));
    }

    /** 转换消息列表为该平台的请求格式 
     * @param msgs 要转换的消息列表
     * @param attachmentRefs 内容指纹到 Provider 附件表示的映射
     * @returns 返回一个JSON对象数组，每个对象包含role和content字段
     * @note 默认使用单条消息的payload格式，如果目标平台的批量消息格式不同，需要覆写此方法
    */
    toPayloads(msgs: Message[], attachmentRefs?: AttachmentWireMap): unknown{
        return msgs.map(m => this.toPayload(m, attachmentRefs));
    }

    /** 将JSON格式的payload转换为Message对象
     * @param payload JSON对象，包含role和content字段
     * @returns 返回一个AssistantMessage对象
    */
    abstract toAssistantMessage(payload: any): AssistantMessage;

    /** 将Message转换为JSON格式的payload 
     * @param msg 要转换的Message对象
     * @param attachmentRefs 内容指纹到 Provider 附件表示的映射
     * @returns 返回一个JSON对象，包含role和content字段
     * @note Adapter 不访问 IFileHost；附件字节/远端ID由 Session 预先解析后经此映射传入。
     *       具体编码是平台职责，例如 base64 / data URL / file_id / URL。
    */
    abstract toPayload(msg: Message, attachmentRefs?: AttachmentWireMap): any;

    /** 将平台原始流式单元解析为归一化片段
     * @param raw 平台原始数据
     * @returns 返回零个或多个归一化片段
    */
    abstract parseStreamChunk(raw: unknown): StreamChunk[];
}

/** 模型输入/输出模态 */
export type ModelModality = "text" | "image" | "audio" | "video";

/** 对话模型的模型级能力 */
export type ChatModelCapabilities = {
    input?: readonly ModelModality[];
    output?: readonly ModelModality[];
    streaming?: boolean;
    tools?: boolean;
    context?: boolean;
};

/** 生成模型（生图/生语音/生视频）的模型级能力 */
export type GenerationModelCapabilities = {
    image?: boolean;
    audio?: boolean;
    video?: boolean;
    async?: boolean;
    context?: boolean;
};

/** 决策模型的模型级能力 */
export type DecisionModelCapabilities = {
    structuredOutput?: boolean;
};

/** 按模型声明的能力；Provider 只是模型容器 */
export type ModelCapabilities = {
    chat?: ChatModelCapabilities;
    generate?: GenerationModelCapabilities;
    decide?: DecisionModelCapabilities;
};

/** 模型信息 */
export type ModelInfo = {

    /* unique id */
    id: string;

    /** 模型名称 */
    name: string;

    /** 模型描述 */
    description: string;

    /** 模型大小(单位为byte，注意换算) */
    size: number;

    /** 模型是否支持对话 */
    supportCompletion: boolean;

    /** 模型是否支持工具调用 */
    supportToolCall: boolean;

    /** 模型是否支持思考 */
    supportThink: boolean;

    /** 模型支持的思考等级(不支持思考等级时为undefined) */
    thinkingLevels?: ModelThinkingLevel[];

    /** 是否为视觉模型 */
    isVisionModel: boolean;

    /** 是否为嵌入模型 */
    isEmbeddingModel: boolean;

    /** 模型级能力；未声明时由调用方按传统字段推断 */
    capabilities?: ModelCapabilities;

    /** 模型版本号 */
    version?: string;

    /** 额外的附加信息（如公司、作者等） */
    extraInfo?: Record<string, unknown>;
}

/** 模型简要信息 */
export type ModelBrief = {
    id: string;
    name: string;
};

/** 模型提供者
 * @note 默认不同的模型支持不同的参数而非根据平台来决定，比如Ollama的部分模型支持think参数而部分不支持，
 *       但它们都基于Ollama的基础协议
 * @description 提供不同平台的模型选择列表，以及该模型的支持细节，通过ProtocolAdapter提供的API来
 *              实现模型的拉取和初始化，初始化的模型信息会缓存起来，后续调用时直接返回缓存的模型信息
 */
export abstract class ModelProvider{

    /** 用于构造ModelProvider类型工厂 */
    static readonly TYPE_NAME = "ModelProvider";

    /** 类型名称，用于构造模型工厂 */
    get typeName(): string{ return (this.constructor as typeof ModelProvider).TYPE_NAME; }

    private _pendingModels: Promise<readonly ModelInfo[]> | null = null;
    private _availableModels: readonly ModelInfo[] | null = null;
    private _fetchCount: number = 0;    // 记录拉取模型的次数
    private _failedCount: number = 0;    // 记录拉取模型失败的次数(主要用于决定UI端是否显示重试按钮)

    /** 是否正在拉取模型 */
    get isPending(): boolean{ return this._pendingModels !== null; }
    /** 是否已初始化模型 */
    get isModelsInitialized(): boolean{ return this._availableModels !== null; }
    /** 所有可用的模型列表 */
    get availableModels(): readonly ModelInfo[] | null{ return this._availableModels; }
    /** 所有可用的模型ID和名称列表 */
    get availableModelBriefs(): readonly ModelBrief[] | null{
        return this._availableModels?.map(model => ({id: model.id, name: model.name})) || null;
    }
    /** 所有可用的模型数量 */
    get modelCount(): number{
        return this._availableModels?.length || 0;
    }
    /** 拉取模型的次数 */
    get fetchCount(): number{ return this._fetchCount; }
    /** 拉取模型失败的次数 */
    get failedCount(): number{ return this._failedCount; }

    
    /** 初始化模型/子类实现具体逻辑 */
    async initModels(onloaded?: (models: readonly ModelInfo[]) => void): Promise<readonly ModelInfo[]>{ 

        // 函数幂等处理：模型拉取已经完成，重复拉取时直接返回缓存的模型信息
        if (this._availableModels !== null){
            onloaded?.(this._availableModels);
            return this._availableModels;
        }

        // 函数幂等处理：模型尚未拉取完成，重复执行空过，等待拉取完成
        if (this.isPending){
            return this._pendingModels!;
        }

        // 验证网络连接是否正常（失败时直接抛出异常，由上游控制器捕捉，并取消拉取模型）
        this._fetchCount ++;
        this._pendingModels = (async () => {
            try {
                await this.validateNetwork();
                this._fetchCount++;
                const models = await this.fetchModels();
                this._availableModels = models;
                onloaded?.(models);
                return models;
            } catch (e) {
                this._failedCount++;
                throw e;
            } finally {
                this._pendingModels = null;
            }
        })();

        return this._pendingModels;
    }

    /** 验证网络连接是否正常 
     * @note 如果网络连接不可用，抛出SessionError异常
    */
    abstract validateNetwork(): Promise<void>;

    /** 异步拉取模型 */
    protected abstract fetchModels(): Promise<ModelInfo[]>;
}


/** 云文件管理器，描述不同平台如何把本地附件转换为可发送的远端/内联表示
 * @note 实现负责远端缓存、存在性校验、上传与过期处理；Session 只调用 ensureFile
 */
export abstract class CloudFileManager{

    /** 确保附件在当前 Provider 侧可用
     * @param file 本地附件快照
     * @param signal 取消信号
     * @returns 当前 Provider 可用的附件表示
     * @note 实现应保证同一 contentHash 的并发调用不会重复上传
     */
    abstract ensureFile(file: AttachmentFile, signal?: AbortSignal): Promise<RemoteFileRef>;

    /** 关闭并释放资源（可选） */
    async close(): Promise<void> {
        // 默认没有需要释放的资源
    }
}

/* ---------------------------------------------------------------------------
 * 能力契约
 *
 * AIProvider 只是在“平台/模型”这一层的统一门面；具体能力由独立接口表达。
 * Session 只绑定 ChatCapability，Generation/Decision 由独立运行时消费。
 * ------------------------------------------------------------------------- */

/** 媒体生成模态 */
export type GenerationModality = "image" | "audio" | "video";

/** 媒体生成请求
 * @note 具体参数由各 Provider 解释；公共字段只覆盖跨平台都需要的部分。
 */
export type GenerationRequest = {
    modality: GenerationModality;
    prompt: string;
    references?: readonly AttachmentRef[];
    context?: readonly Message[];
    parameters?: Record<string, unknown>;
};

/** 生成任务进度 */
export type GenerationProgress = {
    progress?: number;
    total?: number;
    message?: string;
    updatedAt?: number;
};

export type GenerationTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** 生成任务句柄；同步生成可以返回已完成任务，异步生成由上层轮询/等待 */
export interface GenerationTask {
    readonly id: string;
    readonly status: GenerationTaskStatus;
    readonly progress?: GenerationProgress;
    readonly result?: readonly GeneratedMedia[];
    readonly error?: Error;

    cancel(): Promise<void>;
    wait(options?: { signal?: AbortSignal }): Promise<readonly GeneratedMedia[]>;
}

export type GenerationOptions = {
    signal?: AbortSignal;
    onProgress?: (progress: GenerationProgress) => void;
};

/** 生图 / 生语音 / 生视频能力 */
export interface GenerationCapability {
    generate(request: GenerationRequest, options?: GenerationOptions): Promise<GenerationTask>;
}

/** 决策模型可选择的动作 */
export type DecisionAction = {
    id: string;
    description?: string;
    parameters?: Record<string, unknown>;
};

/** 决策模型输入；不强制复用 Message[] */
export type DecisionInput = {
    state: unknown;
    actions: readonly DecisionAction[];
    context?: readonly Message[];
    constraints?: Record<string, unknown>;
};

/** 决策模型输出 */
export type DecisionResult = {
    action: string;
    arguments?: Record<string, unknown>;
    confidence?: number;
    reason?: string;
};

/** 决策能力 */
export interface DecisionCapability {
    decide(input: DecisionInput, options?: { signal?: AbortSignal }): Promise<DecisionResult>;
}

/** 对话能力；Session 只依赖这一能力 */
export interface ChatCapability {
    chat(
        messages: readonly Message[],
        options: SessionRuntimeOptions,
        turn?: ChatOptions,
    ): Promise<ChatResult>;
}

/** Provider 当前实现的能力集合 */
export type ProviderCapability = "chat" | "generate" | "decide";

/** AI 服务提供者基类
 *
 * - 只负责平台/模型的公共元信息与生命周期
 * - 不强制实现 chat / generate / decide；由子类按能力实现对应接口
 * - ProtocolAdapter、鉴权、端点选择都属于 Provider 内部实现
 */
export abstract class AIProvider{

    static readonly TYPE: string = 'AIProvider';

    /** 类型名称，用于构造模型工厂 */
    get typeName(): string{ return (this.constructor as typeof AIProvider).TYPE; }

    abstract get title(): string;

    /** 当前 Provider 的模型管理器；null 表示不提供模型列表 */
    get modelProvider(): ModelProvider | null { return null; }

    /** 该 Provider 是否支持工具调用。UI 可据此禁用相关功能 */
    get supportsTools(): boolean { return false; }

    /** 当前 Provider 的云文件管理器；null 表示不支持附件 */
    get cloudFileManager(): CloudFileManager | null { return null; }

    /** 该 Provider 是否具备附件处理能力；模型级能力由具体实现进一步约束 */
    get supportsAttachments(): boolean { return this.cloudFileManager !== null; }

    /** 当前 Provider 实际实现的能力；由方法存在性推导，避免额外的布尔标志失配 */
    get capabilities(): readonly ProviderCapability[]{
        const capabilities: ProviderCapability[] = [];
        const candidate = this as AIProvider & Partial<
            ChatCapability & GenerationCapability & DecisionCapability
        >;

        if (typeof candidate.chat === "function") capabilities.push("chat");
        if (typeof candidate.generate === "function") capabilities.push("generate");
        if (typeof candidate.decide === "function") capabilities.push("decide");
        return capabilities;
    }

    /** 选择默认模型；返回 undefined 表示没有可选模型
     * @note 默认实现选择第一个支持 completion 且非 embedding 的模型；
     *       平台实现可以覆写以表达偏好
     */
    async resolveDefaultModel(): Promise<string | undefined>{
        const modelProvider = this.modelProvider;
        if (modelProvider === null) return undefined;

        const models = modelProvider.availableModels ?? await modelProvider.initModels();
        const candidate = models.find(
            (model) => model.supportCompletion && !model.isEmbeddingModel,
        );
        return candidate === undefined ? undefined : (candidate.name || candidate.id);
    }

    /** 尝试初始化当前的模型提供器 */
    async tryInitModelProvider(onError: (id: string, e: Error) => void): Promise<void>{

        const typeName = (this.constructor as typeof AIProvider).TYPE;
        try{
            if (!this.modelProvider || this.modelProvider.isModelsInitialized) return;
            await this.modelProvider.initModels();
        }catch(e){
            handleSessionError(e, (err) => {
                onError(typeName, err);
            });
        }
    }
}

/** 可被 Session 直接绑定的对话 Provider */
export type ChatProvider = AIProvider & ChatCapability;

export function isChatProvider(provider: AIProvider): provider is ChatProvider {
    return typeof (provider as Partial<ChatCapability>).chat === "function";
}

export type GenerationProvider = AIProvider & GenerationCapability;

export function isGenerationProvider(provider: AIProvider): provider is GenerationProvider {
    return typeof (provider as Partial<GenerationCapability>).generate === "function";
}

export type DecisionProvider = AIProvider & DecisionCapability;

export function isDecisionProvider(provider: AIProvider): provider is DecisionProvider {
    return typeof (provider as Partial<DecisionCapability>).decide === "function";
}