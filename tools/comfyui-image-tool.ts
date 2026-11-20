import { fromBase64, uniqueId } from "../src/base";
import { detectImageMimeType, normalizeImageMimeType } from "../src/file";
import type { AttachmentFile } from "../src/session/attachment";
import { isContentHash } from "../src/session/attachment";
import { ToolError, ToolErrorType } from "../src/session/error";
import { extensionForMediaMimeType } from "../src/session/media";
import type { ToolCall, ToolCallResult, ToolDefinition } from "../src/session/type";
import type { ToolCallOptions, ToolProvider } from "../src/session/tool";

/** ComfyUI API 格式的工作流节点 */
export type ComfyUIWorkflowNode = {
    class_type: string;
    inputs: Record<string, unknown>;
    _meta?: Record<string, unknown>;
};

/** ComfyUI API 格式的工作流 */
export type ComfyUIWorkflow = Record<string, ComfyUIWorkflowNode>;

const MAX_REFERENCE_BYTES = 64 * 1024 * 1024;

export type ComfyUIImageToolOptions = {
    /** ComfyUI API 格式工作流（通常是 UI 导出的 API JSON） */
    workflow: ComfyUIWorkflow;

    /** ComfyUI 地址，默认 http://127.0.0.1:8188 */
    baseUrl?: string;

    /** ToolProvider ID，默认 comfyui-image */
    id?: string;

    /** ToolProvider 展示名称 */
    name?: string;

    /** ToolProvider 描述 */
    description?: string;

    /** 工具函数名，默认 generateImage */
    toolName?: string;

    /** 工具标题，默认 Generate Image */
    toolTitle?: string;

    /** 工具描述；默认使用生成描述 */
    toolDescription?: string;

    /** 至少需要的参考图数量，默认 0 */
    minReferences?: number;

    /** 工具建议超时，默认 600s */
    adviceTimeoutMs?: number;

    /** 单次生成总超时，默认 600s */
    timeoutMs?: number;

    /** 轮询间隔，默认 500ms */
    pollIntervalMs?: number;

    /** 参考图上限，默认 16 */
    maxReferences?: number;

    /** 自定义 fetch */
    fetch?: typeof fetch;

    /** 把 contentHash 解析为本会话附件 */
    resolveReference?: (contentHash: string) => Promise<AttachmentFile | undefined>;
};

/** 本地 ComfyUI Qwen-Image 生图工具
 *
 * 参数与 MiniMaxImageToolProvider 对齐：prompt / size / references / seed / negative_prompt。
 * 工具只返回 PendingAttachment，由 Session 统一落盘。
 */
export class ComfyUIImageToolProvider implements ToolProvider {

    readonly id: string;
    readonly name: string;
    readonly description: string;

    private readonly _workflow: ComfyUIWorkflow;
    private readonly _baseUrl: string;
    private readonly _timeoutMs: number;
    private readonly _pollIntervalMs: number;
    private readonly _maxReferences: number;
    private readonly _minReferences: number;
    private readonly _fetch: typeof fetch;
    private readonly _resolveReference: ComfyUIImageToolOptions["resolveReference"];
    private readonly _definition: ToolDefinition;

    constructor(options: ComfyUIImageToolOptions){
        if (options.workflow === undefined || options.workflow === null){
            throw new ToolError(
                ToolErrorType.ProviderError,
                false,
                "ComfyUIImageToolProvider requires a workflow",
            );
        }

        const adviceTimeoutMs = normalizeTimeout(options.adviceTimeoutMs, 600_000);
        this._workflow = cloneWorkflow(options.workflow);
        this._baseUrl = (options.baseUrl ?? "http://127.0.0.1:8188").replace(/\/+$/, "");
        this._timeoutMs = normalizeTimeout(options.timeoutMs, 600_000);
        this._pollIntervalMs = normalizePositive(options.pollIntervalMs ?? 500, "pollIntervalMs");
        this._maxReferences = normalizePositive(options.maxReferences ?? 16, "maxReferences");
        this._minReferences = options.minReferences ?? 0;
        if (!Number.isInteger(this._minReferences) || this._minReferences < 0
            || this._minReferences > this._maxReferences){
            throw new ToolError(
                ToolErrorType.InvalidParams,
                true,
                `minReferences must be an integer between 0 and ${this._maxReferences}`,
            );
        }
        this._fetch = options.fetch ?? fetch;
        this._resolveReference = options.resolveReference;
        this.id = options.id ?? "comfyui-image";
        this.name = options.name ?? "ComfyUI Image";
        this.description = options.description ?? "ComfyUI Qwen-Image 生图/参考图编辑工具";
        this._definition = {
            name: options.toolName ?? "generateImage",
            title: options.toolTitle ?? "Generate Image",
            description: options.toolDescription
                ?? "使用本地 ComfyUI Qwen-Image 工作流生成图片，或基于参考图片进行编辑；图片会作为工具媒体回传给模型。",
            inputSchema: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                        description: "图片生成/编辑提示词",
                    },
                    size: {
                        type: "string",
                        description: "可选尺寸，例如 1024x1024；不传时使用工作流默认分辨率",
                    },
                    references: {
                        type: "array",
                        description: "可选参考图，最多 16 张。每项为当前会话附件的 contentHash"
                            + "（来自 [media:<contentHash>] 或 [tool media reference: <contentHash>] 标记），"
                            + "或 http(s)/data:image 图片 URL。",
                        items: { type: "string" },
                        maxItems: 16,
                    },
                    seed: {
                        type: "integer",
                        description: "可选随机种子；不传时自动生成随机种子",
                    },
                    negative_prompt: {
                        type: "string",
                        description: "可选负向提示词",
                    },
                },
                required: ["prompt"],
            },
            annotations: {
                readOnlyHint: false,
                concurrencySafe: false,
                requiresApproval: true,
            },
            adviceTimeout: adviceTimeoutMs,
        };
    }

    async fetchTools(): Promise<ToolDefinition[]>{
        return [this._definition];
    }

    async call(call: ToolCall, options?: ToolCallOptions): Promise<ToolCallResult>{
        const prompt = call.params.prompt;
        if (typeof prompt !== "string" || prompt.trim().length === 0){
            throw new ToolError(
                ToolErrorType.InvalidParams,
                true,
                "generateImage requires a non-empty prompt",
            );
        }

        const size = parseSize(call.params.size);
        const seed = parseSeed(call.params.seed) ?? randomSeed();
        const negativePrompt = call.params.negative_prompt;
        if (negativePrompt !== undefined && typeof negativePrompt !== "string"){
            throw new ToolError(
                ToolErrorType.InvalidParams,
                true,
                "generateImage negative_prompt must be a string",
            );
        }

        const references = await this._loadReferences(call.params.references, options?.signal);
        if (references.length < this._minReferences){
            throw new ToolError(
                ToolErrorType.InvalidParams,
                true,
                `${this._definition.name} requires at least ${this._minReferences} reference image`,
            );
        }
        if (references.length > this._maxReferences){
            throw new ToolError(
                ToolErrorType.InvalidParams,
                true,
                `${this._definition.name} supports at most ${this._maxReferences} reference images`,
            );
        }

        const workflow = cloneWorkflow(this._workflow);
        const textNode = findNode(workflow, "TextEncodeQwenImage21");
        const latentNode = findNode(workflow, "EmptyLatentImage");
        const samplerNode = findNode(workflow, "KSampler");

        if (textNode === undefined || latentNode === undefined || samplerNode === undefined){
            throw new ToolError(
                ToolErrorType.ProviderError,
                false,
                "ComfyUI workflow must contain TextEncodeQwenImage21 / EmptyLatentImage / KSampler",
            );
        }

        textNode.node.inputs.prompt = prompt.trim();
        if (negativePrompt !== undefined){
            textNode.node.inputs.negative_prompt = negativePrompt;
        }
        samplerNode.node.inputs.seed = seed;

        if (size !== undefined){
            latentNode.node.inputs.width = size.width;
            latentNode.node.inputs.height = size.height;
            enableLatentSizeSwitch(workflow, samplerNode.node.inputs, latentNode.id);
        }

        if (references.length === 0){
            removeReferenceImages(textNode.node.inputs);
        }else{
            await this._applyReferences(workflow, textNode.node.inputs, references, options?.signal);
        }

        const promptId = await this._submit(workflow, options?.signal);
        const image = await this._waitForOutput(promptId, options?.signal);
        const imageResponse = await this._fetchImage(image, options?.signal);
        const mimeType = detectImageMimeType(imageResponse.data)
            ?? normalizeImageMimeType(imageResponse.mimeType)
            ?? "image/png";

        return {
            content: "Generated image.",
            status: { isSuccess: true, duration: 0 },
            attachments: [{
                kind: "bytes",
                data: imageResponse.data,
                name: image.filename,
                mimeType,
                origin: "tool",
            }],
        };
    }

    async close(): Promise<void>{
        // 没有常驻连接
    }

    /** 把参考图上传到 ComfyUI，并接到 TextEncodeQwenImage21 的 images.image_N
     * @note 优先复用工作流中已有的 image_N 槽位（缩放节点 + LoadImage）；
     *       工作流没有槽位时动态创建，因此旧版单槽位和 16 槽位工作流都能工作。
     */
    private async _applyReferences(
        workflow: ComfyUIWorkflow,
        textInputs: Record<string, unknown>,
        references: readonly ResolvedReference[],
        signal: AbortSignal | undefined,
    ): Promise<void>{
        const slots = collectReferenceSlots(workflow, textInputs);

        for (const key of Object.keys(textInputs)){
            if (key.startsWith("images.")) delete textInputs[key];
        }

        for (const [index, reference] of references.entries()){
            const uploaded = await this._uploadImage(reference, index, signal);
            const imageNumber = index + 1;
            const slot = slots.get(imageNumber);

            if (slot?.loadId !== undefined){
                const loadNode = workflow[slot.loadId];
                if (loadNode === undefined){
                    throw new ToolError(
                        ToolErrorType.ProviderError,
                        false,
                        `ComfyUI workflow reference slot ${imageNumber} points to a missing LoadImage`,
                    );
                }
                loadNode.inputs.image = uploaded;

                if (slot.scaleId !== undefined){
                    const scaleNode = workflow[slot.scaleId];
                    if (scaleNode === undefined){
                        throw new ToolError(
                            ToolErrorType.ProviderError,
                            false,
                            `ComfyUI workflow reference slot ${imageNumber} points to a missing scale node`,
                        );
                    }
                    scaleNode.inputs.image = [slot.loadId, 0];
                    textInputs[`images.image_${imageNumber}`] = [slot.scaleId, 0];
                }else{
                    textInputs[`images.image_${imageNumber}`] = [slot.loadId, 0];
                }
                continue;
            }

            const loadId = addLoadNode(workflow, uploaded, index);
            const scaleId = addScaleNode(workflow, loadId, index);
            textInputs[`images.image_${imageNumber}`] = [scaleId, 0];
        }
    }

    /** 读取并校验参考图 */
    private async _loadReferences(
        value: unknown,
        signal: AbortSignal | undefined,
    ): Promise<ResolvedReference[]>{
        if (value === undefined || value === null) return [];
        if (!Array.isArray(value)){
            throw new ToolError(
                ToolErrorType.InvalidParams,
                true,
                "generateImage references must be an array",
            );
        }
        if (value.length > this._maxReferences){
            throw new ToolError(
                ToolErrorType.InvalidParams,
                true,
                `generateImage supports at most ${this._maxReferences} reference images`,
            );
        }

        const references: ResolvedReference[] = [];
        for (const [index, item] of value.entries()){
            if (typeof item !== "string" || item.trim().length === 0){
                throw new ToolError(
                    ToolErrorType.InvalidParams,
                    true,
                    `generateImage references[${index}] must be a non-empty string`,
                );
            }

            const reference = item.trim();
            const contentHash = reference.length === 64 ? reference.toLowerCase() : reference;
            if (isContentHash(contentHash)){
                if (this._resolveReference === undefined){
                    throw new ToolError(
                        ToolErrorType.InvalidParams,
                        true,
                        "generateImage contentHash references require resolveReference",
                    );
                }
                const file = await this._resolveReference(contentHash);
                if (file === undefined){
                    throw new ToolError(
                        ToolErrorType.InvalidParams,
                        true,
                        `generateImage reference attachment not found: ${contentHash}`,
                    );
                }
                if (file.size > MAX_REFERENCE_BYTES){
                    throw new ToolError(
                        ToolErrorType.InvalidParams,
                        true,
                        `generateImage reference is too large: ${file.size} bytes`,
                    );
                }
                references.push({
                    data: file.content,
                    mimeType: file.mimeType,
                    name: file.name,
                });
                continue;
            }

            if (reference.startsWith("data:image/")){
                if (reference.length > Math.ceil(MAX_REFERENCE_BYTES * 4 / 3) + 64){
                    throw new ToolError(
                        ToolErrorType.InvalidParams,
                        true,
                        `generateImage reference data URI is too large at index ${index}`,
                    );
                }
                try{
                    references.push({
                        data: fromBase64(reference),
                        mimeType: reference.slice(5, reference.indexOf(";")),
                        name: `reference-${index}`,
                    });
                }catch(error){
                    throw new ToolError(
                        ToolErrorType.InvalidParams,
                        true,
                        `Invalid reference image data URI at index ${index}`,
                        error,
                    );
                }
                continue;
            }

            if (isHttpUrl(reference)){
                references.push(await this._downloadReference(reference, signal));
                continue;
            }

            throw new ToolError(
                ToolErrorType.InvalidParams,
                true,
                `generateImage references[${index}] is neither a contentHash nor a supported image URL`,
            );
        }

        return references;
    }

    private async _downloadReference(
        url: string,
        signal: AbortSignal | undefined,
    ): Promise<ResolvedReference>{
        let response: Response;
        try{
            response = await this._fetch(url, { method: "GET", signal });
        }catch(error){
            if (signal?.aborted === true) throw error;
            throw new ToolError(
                ToolErrorType.NetworkError,
                true,
                `Failed to download reference image: ${url}`,
                error,
            );
        }
        if (!response.ok){
            throw new ToolError(
                ToolErrorType.ProviderError,
                false,
                `Reference image download returned HTTP ${response.status}`,
            );
        }
        const data = new Uint8Array(await response.arrayBuffer());
        if (data.byteLength > MAX_REFERENCE_BYTES){
            throw new ToolError(
                ToolErrorType.InvalidParams,
                false,
                `Reference image is too large: ${data.byteLength} bytes`,
            );
        }
        const mimeType = detectImageMimeType(data)
            ?? response.headers.get("content-type")?.split(";")[0]?.trim();
        if (mimeType === undefined || normalizeImageMimeType(mimeType) === undefined){
            throw new ToolError(
                ToolErrorType.InvalidParams,
                false,
                `Reference URL is not a supported image: ${url}`,
            );
        }
        return {
            data,
            mimeType,
            name: nameFromUrl(url) ?? "reference",
        };
    }

    private async _uploadImage(
        reference: ResolvedReference,
        index: number,
        signal: AbortSignal | undefined,
    ): Promise<string>{
        const mimeType = detectImageMimeType(reference.data)
            ?? normalizeImageMimeType(reference.mimeType);
        if (mimeType === undefined){
            throw new ToolError(
                ToolErrorType.InvalidParams,
                false,
                `Reference image ${index} is not a supported image`,
            );
        }

        const extension = extensionForMediaMimeType(mimeType) ?? "png";
        const filename = `wireclaw-ref-${uniqueId()}-${index}.${extension}`;
        const bytes = new Uint8Array(reference.data.byteLength);
        bytes.set(reference.data);
        const form = new FormData();
        form.append("image", new Blob([bytes.buffer], { type: mimeType }), filename);
        form.append("overwrite", "true");

        let response: Response;
        try{
            response = await this._fetch(`${this._baseUrl}/upload/image`, {
                method: "POST",
                body: form,
                signal,
            });
        }catch(error){
            if (signal?.aborted === true) throw error;
            throw new ToolError(
                ToolErrorType.NetworkError,
                true,
                "Failed to upload reference image to ComfyUI",
                error,
            );
        }

        if (!response.ok){
            throw new ToolError(
                ToolErrorType.ProviderError,
                false,
                `ComfyUI image upload returned HTTP ${response.status}`,
            );
        }

        const payload: unknown = await response.json();
        if (!isRecord(payload) || typeof payload.name !== "string" || payload.name.length === 0){
            throw new ToolError(
                ToolErrorType.ProviderError,
                false,
                "ComfyUI image upload response is missing name",
            );
        }

        const subfolder = typeof payload.subfolder === "string" ? payload.subfolder : "";
        return subfolder.length > 0 ? `${subfolder}/${payload.name}` : payload.name;
    }

    private async _submit(
        workflow: ComfyUIWorkflow,
        signal: AbortSignal | undefined,
    ): Promise<string>{
        let response: Response;
        try{
            response = await this._fetch(`${this._baseUrl}/prompt`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    prompt: workflow,
                    client_id: `wireclaw-${uniqueId()}`,
                }),
                signal,
            });
        }catch(error){
            if (signal?.aborted === true) throw error;
            throw new ToolError(
                ToolErrorType.NetworkError,
                true,
                "Failed to submit prompt to ComfyUI",
                error,
            );
        }

        const text = await response.text();
        if (!response.ok){
            throw new ToolError(
                ToolErrorType.ProviderError,
                false,
                `ComfyUI /prompt returned HTTP ${response.status}: ${text.slice(0, 500)}`,
            );
        }

        let payload: unknown;
        try{
            payload = JSON.parse(text);
        }catch(error){
            throw new ToolError(
                ToolErrorType.ProviderError,
                false,
                "ComfyUI /prompt returned invalid JSON",
                error,
            );
        }

        if (!isRecord(payload) || typeof payload.prompt_id !== "string"){
            throw new ToolError(
                ToolErrorType.ProviderError,
                false,
                "ComfyUI /prompt response is missing prompt_id",
            );
        }
        if (isRecord(payload.node_errors) && Object.keys(payload.node_errors).length > 0){
            throw new ToolError(
                ToolErrorType.ProviderError,
                false,
                `ComfyUI workflow validation failed: ${JSON.stringify(payload.node_errors).slice(0, 800)}`,
            );
        }

        return payload.prompt_id;
    }

    private async _waitForOutput(
        promptId: string,
        signal: AbortSignal | undefined,
    ): Promise<ComfyUIImageRef>{
        const deadline = Date.now() + this._timeoutMs;

        while (Date.now() <= deadline){
            if (signal?.aborted === true) throw signal.reason;
            const history = await this._getHistory(promptId, signal);
            const entry = isRecord(history[promptId]) ? history[promptId] : undefined;

            if (entry !== undefined){
                const status = isRecord(entry.status) ? entry.status : undefined;
                if (status?.status_str === "error"){
                    throw new ToolError(
                        ToolErrorType.ProviderError,
                        false,
                        "ComfyUI workflow execution failed",
                        entry.status,
                    );
                }

                const outputs = isRecord(entry.outputs) ? entry.outputs : undefined;
                const image = findOutputImage(outputs);
                if (image !== undefined) return image;

                if (status?.completed === true){
                    throw new ToolError(
                        ToolErrorType.ProviderError,
                        false,
                        "ComfyUI workflow completed without an image output",
                    );
                }
            }

            await delay(this._pollIntervalMs, signal);
        }

        throw new ToolError(
            ToolErrorType.Timeout,
            true,
            `ComfyUI generation timed out after ${this._timeoutMs}ms`,
        );
    }

    private async _getHistory(
        promptId: string,
        signal: AbortSignal | undefined,
    ): Promise<Record<string, unknown>>{
        let response: Response;
        try{
            response = await this._fetch(`${this._baseUrl}/history/${encodeURIComponent(promptId)}`, {
                method: "GET",
                signal,
            });
        }catch(error){
            if (signal?.aborted === true) throw error;
            throw new ToolError(
                ToolErrorType.NetworkError,
                true,
                "Failed to query ComfyUI history",
                error,
            );
        }
        if (!response.ok){
            throw new ToolError(
                ToolErrorType.ProviderError,
                false,
                `ComfyUI /history returned HTTP ${response.status}`,
            );
        }
        const payload: unknown = await response.json();
        return isRecord(payload) ? payload : {};
    }

    private async _fetchImage(
        image: ComfyUIImageRef,
        signal: AbortSignal | undefined,
    ): Promise<{ data: Uint8Array; mimeType?: string }>{
        const params = new URLSearchParams({
            filename: image.filename,
            subfolder: image.subfolder,
            type: image.type,
        });
        let response: Response;
        try{
            response = await this._fetch(`${this._baseUrl}/view?${params.toString()}`, {
                method: "GET",
                signal,
            });
        }catch(error){
            if (signal?.aborted === true) throw error;
            throw new ToolError(
                ToolErrorType.NetworkError,
                true,
                "Failed to download ComfyUI output image",
                error,
            );
        }
        if (!response.ok){
            throw new ToolError(
                ToolErrorType.ProviderError,
                false,
                `ComfyUI /view returned HTTP ${response.status}`,
            );
        }
        return {
            data: new Uint8Array(await response.arrayBuffer()),
            mimeType: response.headers.get("content-type")?.split(";")[0]?.trim(),
        };
    }
}

type ResolvedReference = {
    data: Uint8Array;
    mimeType?: string;
    name: string;
};

type ComfyUIImageRef = {
    filename: string;
    subfolder: string;
    type: string;
};

function cloneWorkflow(workflow: ComfyUIWorkflow): ComfyUIWorkflow{
    return JSON.parse(JSON.stringify(workflow)) as ComfyUIWorkflow;
}

function findNode(
    workflow: ComfyUIWorkflow,
    classType: string,
): { id: string; node: ComfyUIWorkflowNode } | undefined{
    for (const [id, node] of Object.entries(workflow)){
        if (node.class_type === classType) return { id, node };
    }
    return undefined;
}

function removeReferenceImages(textInputs: Record<string, unknown>): void{
    for (const key of Object.keys(textInputs)){
        if (key.startsWith("images.")) delete textInputs[key];
    }
}

type ReferenceSlot = {
    loadId?: string;
    scaleId?: string;
};

/** 解析工作流已有的 images.image_N 槽位，支持单槽位和 16 槽位工作流 */
function collectReferenceSlots(
    workflow: ComfyUIWorkflow,
    textInputs: Record<string, unknown>,
): Map<number, ReferenceSlot>{
    const slots = new Map<number, ReferenceSlot>();

    for (let index = 1; index <= 16; index += 1){
        const link = asLink(textInputs[`images.image_${index}`]);
        if (link === undefined) continue;

        const target = workflow[link[0]];
        if (target === undefined) continue;

        if (target.class_type === "ImageScaleToTotalPixels"){
            const imageLink = asLink(target.inputs.image);
            const load = imageLink === undefined ? undefined : workflow[imageLink[0]];
            slots.set(index, {
                scaleId: link[0],
                loadId: load?.class_type === "LoadImage" ? imageLink?.[0] : undefined,
            });
            continue;
        }

        if (target.class_type === "LoadImage"){
            slots.set(index, { loadId: link[0] });
        }
    }

    return slots;
}

/** 编辑工作流通常用 ComfySwitchNode 在“参考图 latent”和 EmptyLatent 之间切换；
 * 指定 size 时切到 EmptyLatent，让尺寸参数生效。
 */
function enableLatentSizeSwitch(
    workflow: ComfyUIWorkflow,
    samplerInputs: Record<string, unknown>,
    latentNodeId: string,
): void{
    const latentLink = asLink(samplerInputs.latent_image);
    if (latentLink === undefined) return;

    const switchNode = workflow[latentLink[0]];
    if (switchNode?.class_type !== "ComfySwitchNode") return;

    const trueLink = asLink(switchNode.inputs.on_true);
    if (trueLink?.[0] === latentNodeId){
        switchNode.inputs.switch = true;
    }
}

function asLink(value: unknown): [string, number] | undefined{
    if (!Array.isArray(value) || value.length < 2) return undefined;
    return typeof value[0] === "string" && typeof value[1] === "number"
        ? [value[0], value[1]]
        : undefined;
}

function addLoadNode(workflow: ComfyUIWorkflow, image: string, index: number): string{
    const id = uniqueNodeId(workflow, `wireclaw_load_${index + 1}`);
    workflow[id] = {
        class_type: "LoadImage",
        inputs: { image },
        _meta: { title: `Wireclaw Reference ${index + 1}` },
    };
    return id;
}

function addScaleNode(workflow: ComfyUIWorkflow, loadNodeId: string, index: number): string{
    const id = uniqueNodeId(workflow, `wireclaw_scale_${index + 1}`);
    workflow[id] = {
        class_type: "ImageScaleToTotalPixels",
        inputs: {
            upscale_method: "nearest-exact",
            megapixels: 0.7,
            resolution_steps: 1,
            image: [loadNodeId, 0],
        },
        _meta: { title: `Wireclaw Reference Scale ${index + 1}` },
    };
    return id;
}

function uniqueNodeId(workflow: ComfyUIWorkflow, prefix: string): string{
    let id = prefix;
    let suffix = 2;
    while (workflow[id] !== undefined){
        id = `${prefix}_${suffix++}`;
    }
    return id;
}

function findOutputImage(outputs: Record<string, unknown> | undefined): ComfyUIImageRef | undefined{
    if (outputs === undefined) return undefined;

    for (const output of Object.values(outputs)){
        if (!isRecord(output) || !Array.isArray(output.images)) continue;
        for (const image of output.images){
            if (!isRecord(image) || typeof image.filename !== "string") continue;
            return {
                filename: image.filename,
                subfolder: typeof image.subfolder === "string" ? image.subfolder : "",
                type: typeof image.type === "string" ? image.type : "output",
            };
        }
    }
    return undefined;
}

function parseSize(value: unknown): { width: number; height: number } | undefined{
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string"){
        throw new ToolError(
            ToolErrorType.InvalidParams,
            true,
            "generateImage size must be a string like 1024x1024",
        );
    }
    const match = /^(\d+)\s*[x*]\s*(\d+)$/i.exec(value.trim());
    if (match === null){
        throw new ToolError(
            ToolErrorType.InvalidParams,
            true,
            `Invalid generateImage size: ${value}`,
        );
    }

    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0){
        throw new ToolError(
            ToolErrorType.InvalidParams,
            true,
            `Invalid generateImage size: ${value}`,
        );
    }
    if (width % 8 !== 0 || height % 8 !== 0){
        throw new ToolError(
            ToolErrorType.InvalidParams,
            true,
            `generateImage size must use multiples of 8, got ${value}`,
        );
    }
    return { width, height };
}

function parseSeed(value: unknown): number | undefined{
    if (value === undefined || value === null) return undefined;
    if (!Number.isInteger(value) || (value as number) < 0){
        throw new ToolError(
            ToolErrorType.InvalidParams,
            true,
            "generateImage seed must be a non-negative integer",
        );
    }
    return value as number;
}

function randomSeed(): number{
    return Math.floor(Math.random() * 2_147_483_647);
}

function normalizeTimeout(value: number | undefined, fallback: number): number{
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value <= 0){
        throw new ToolError(
            ToolErrorType.InvalidParams,
            true,
            `timeout must be a positive integer, got ${String(value)}`,
        );
    }
    return Math.min(value, 3_600_000);
}

function normalizePositive(value: number, field: string): number{
    if (!Number.isInteger(value) || value <= 0){
        throw new ToolError(
            ToolErrorType.InvalidParams,
            true,
            `${field} must be a positive integer, got ${String(value)}`,
        );
    }
    return value;
}

function isHttpUrl(value: string): boolean{
    try{
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    }catch{
        return false;
    }
}

function nameFromUrl(value: string): string | undefined{
    try{
        const pathname = new URL(value).pathname;
        const name = pathname.split("/").filter((part) => part.length > 0).pop();
        return name === undefined || name.length === 0 ? undefined : decodeURIComponent(name);
    }catch{
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown>{
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number, signal?: AbortSignal): Promise<void>{
    return new Promise((resolve, reject) => {
        if (signal?.aborted === true){
            reject(signal.reason);
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(signal?.reason);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
