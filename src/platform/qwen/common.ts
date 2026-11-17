/** Qwen / DashScope 默认配置 */

/** 国内站 OpenAI 兼容入口 */
export const QWEN_DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

/** 国际站 OpenAI 兼容入口 */
export const QWEN_INTL_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

/** 默认对话模型 */
export const QWEN_DEFAULT_CHAT_MODEL = "qwen-plus";

/** 默认视觉模型 */
export const QWEN_DEFAULT_VISION_MODEL = "qwen3-vl-plus";

/** 默认会话级生图模型 */
export const QWEN_DEFAULT_IMAGE_MODEL = "qwen-image-2.0";

/** 默认生图尺寸 */
export const QWEN_DEFAULT_IMAGE_SIZE = "1024*1024";

/** 默认生图数量 */
export const QWEN_DEFAULT_IMAGE_COUNT = 1;

/** 判断是否会话级生图模型 */
export function isQwenImageModel(model: string | undefined): boolean{
    if (model === undefined) return false;
    return model.toLowerCase().startsWith("qwen-image");
}

/** 由 OpenAI 兼容 base URL 推导 DashScope 原生生图端点 */
export function resolveQwenImageEndpoint(baseUrl: string): string{
    const normalized = baseUrl.replace(/\/+$/, "");
    const compatibleIndex = normalized.indexOf("/compatible-mode/");
    if (compatibleIndex >= 0){
        return `${normalized.slice(0, compatibleIndex)}/api/v1/services/aigc/multimodal-generation/generation`;
    }

    if (normalized.endsWith("/api/v1")){
        return `${normalized}/services/aigc/multimodal-generation/generation`;
    }

    return `${normalized}/api/v1/services/aigc/multimodal-generation/generation`;
}
