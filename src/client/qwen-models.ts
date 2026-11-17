import type { AIProvider, MediaInputLimit, ModelInfo } from "../session/protocol";

/** Qwen / DashScope 不通过 /models 返回模态；这里给参考客户端提供一份可覆盖的目录
 *
 * 这是 harness 层的参考实现，不是 wireclaw 核心能力探测逻辑。
 * 宿主应使用自己的探测/配置结果调用 AIProvider.overwriteMany 覆盖它。
 */
const MIB = 1024 * 1024;

const AUDIO_MIME_TYPES = ["audio/amr", "audio/wav", "audio/3gpp", "audio/aac", "audio/mpeg"] as const;
const VIDEO_MIME_TYPES = ["video/mp4", "video/3gpp", "video/x-msvideo", "video/x-matroska", "video/quicktime", "video/x-flv", "video/x-ms-wmv"] as const;

function audioLimit(maxDurationSeconds: number, maxCount = 250): MediaInputLimit{
    return {
        maxEncodedBytes: 10 * MIB,
        maxDurationSeconds,
        mimeTypes: [...AUDIO_MIME_TYPES],
        maxCount,
        allowedTransports: ["inline", "url"],
    };
}

function videoLimit(maxDurationSeconds: number, maxCount = 250): MediaInputLimit{
    return {
        maxEncodedBytes: 10 * MIB,
        maxDurationSeconds,
        mimeTypes: [...VIDEO_MIME_TYPES],
        maxCount,
        allowedTransports: ["inline", "url"],
    };
}

const OMNI_INPUT = ["text", "image", "audio", "video"] as const;

export const QWEN_REFERENCE_MODEL_OVERRIDES: readonly {
    id: string;
    info: Partial<ModelInfo>;
}[] = [
    {
        id: "qwen3.8-omni-flash",
        info: {
            capabilities: {
                chat: {
                    input: [...OMNI_INPUT],
                    output: ["text"],
                    streaming: true,
                    tools: true,
                    thinking: true,
                },
            },
            limits: {
                input: {
                    audio: audioLimit(3 * 60 * 60),
                    video: videoLimit(2 * 60 * 60),
                },
            },
        },
    },
    {
        id: "qwen3.5-omni-plus",
        info: {
            capabilities: {
                chat: {
                    input: [...OMNI_INPUT],
                    // 音频输出尚未实现，参考 harness 只声明文本输出
                    output: ["text"],
                    streaming: true,
                    tools: true,
                },
            },
            limits: {
                input: {
                    audio: audioLimit(3 * 60 * 60),
                    video: videoLimit(60 * 60),
                },
            },
        },
    },
    {
        id: "qwen3.5-omni-flash",
        info: {
            capabilities: {
                chat: {
                    input: [...OMNI_INPUT],
                    output: ["text"],
                    streaming: true,
                    tools: true,
                },
            },
            limits: {
                input: {
                    audio: audioLimit(3 * 60 * 60),
                    video: videoLimit(60 * 60),
                },
            },
        },
    },
    {
        id: "qwen3-omni-flash",
        info: {
            capabilities: {
                chat: {
                    input: [...OMNI_INPUT],
                    output: ["text"],
                    streaming: true,
                    tools: false,
                },
            },
            limits: {
                input: {
                    audio: audioLimit(20 * 60, 1),
                    video: videoLimit(150, 1),
                },
            },
        },
    },
    {
        id: "qwen3-vl-plus",
        info: {
            capabilities: {
                chat: {
                    input: ["text", "image"],
                    output: ["text"],
                    streaming: true,
                    tools: true,
                },
            },
        },
    },
    {
        id: "qwen-image-2.0",
        info: {
            supportCompletion: false,
            capabilities: {
                generate: {
                    input: ["text"],
                    output: ["image"],
                    image: true,
                    audio: false,
                    video: false,
                    async: false,
                },
            },
        },
    },
    {
        id: "qwen-image-3.0",
        info: {
            supportCompletion: false,
            capabilities: {
                generate: {
                    input: ["text"],
                    output: ["image"],
                    image: true,
                    audio: false,
                    video: false,
                    async: false,
                },
            },
        },
    },
];

/** 把参考目录注入 Provider；宿主可以替换为自己探测到覆盖表 */
export function applyQwenReferenceModelOverrides(provider: AIProvider): void{
    provider.overwriteMany(QWEN_REFERENCE_MODEL_OVERRIDES);
}
