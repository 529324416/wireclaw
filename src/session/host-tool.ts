import type {
    ToolCall,
    ToolDefinition,
    ToolParamSchema,
    UserInputAnswer,
    UserInputRequest,
    UserInputResult,
    UserQuestion,
    UserQuestionOption,
} from "./type";

/** host 内置工具的 Provider 前缀 */
export const HOST_PROVIDER_ID = "host";

/** 询问用户的选择题工具 */
export const ASK_USER_TOOL_ID = "ask_user";

/** 模型侧完整工具名 */
export const ASK_USER_TOOL_NAME = `${HOST_PROVIDER_ID}__${ASK_USER_TOOL_ID}`;

const ASK_USER_INPUT_SCHEMA: ToolParamSchema = {
    type: "object",
    properties: {
        title: { type: "string", description: "表单标题" },
        questions: {
            type: "array",
            description: "一个或多个选择题",
            items: {
                type: "object",
                properties: {
                    id: { type: "string", description: "问题 ID，回答时回传" },
                    header: { type: "string", description: "简短标题" },
                    question: { type: "string", description: "问题正文" },
                    multiSelect: { type: "boolean", description: "是否允许多选" },
                    allowOther: { type: "boolean", description: "是否允许自由输入" },
                    options: {
                        type: "array",
                        description: "至少两个选项",
                        items: {
                            type: "object",
                            properties: {
                                id: { type: "string" },
                                label: { type: "string" },
                                description: { type: "string" },
                            },
                            required: ["id", "label"],
                        },
                    },
                },
                required: ["id", "question", "options"],
            },
        },
    },
    required: ["questions"],
};

/** 内置的“询问用户”工具定义 */
export const ASK_USER_TOOL_DEFINITION: ToolDefinition = {
    name: ASK_USER_TOOL_NAME,
    title: "Ask User",
    description: "向用户提出一个或多个选择题，并等待用户作答；适用于需要用户做决定、选择方案或补充关键信息的场景。",
    inputSchema: ASK_USER_INPUT_SCHEMA,
    defaultTrust: "trusted",
    annotations: {
        readOnlyHint: true,
        requiresApproval: false,
        concurrencySafe: false,
    },
    source: {
        providerId: HOST_PROVIDER_ID,
    },
};

/** 查看 assistant 历史媒体的工具 */
export const VIEW_MEDIA_TOOL_ID = "view_media";

/** 模型侧完整工具名 */
export const VIEW_MEDIA_TOOL_NAME = `${HOST_PROVIDER_ID}__${VIEW_MEDIA_TOOL_ID}`;

const VIEW_MEDIA_INPUT_SCHEMA: ToolParamSchema = {
    type: "object",
    properties: {
        contentHash: {
            type: "string",
            description: "assistant 历史媒体标记 [media:<contentHash>] 中的内容指纹",
        },
    },
    required: ["contentHash"],
};

/** 内置的“查看 assistant 历史媒体”工具定义
 * @note 只在模型同时支持媒体输入和媒体输出时由 Session 注入
 */
export const VIEW_MEDIA_TOOL_DEFINITION: ToolDefinition = {
    name: VIEW_MEDIA_TOOL_NAME,
    title: "View Media",
    description: "重新查看当前会话中 assistant 之前生成的媒体（图片/音频/视频）。"
        + "参数 contentHash 来自 assistant 消息中的 [media:<contentHash>] 标记。",
    inputSchema: VIEW_MEDIA_INPUT_SCHEMA,
    defaultTrust: "trusted",
    annotations: {
        readOnlyHint: true,
        requiresApproval: false,
        concurrencySafe: true,
    },
    source: {
        providerId: HOST_PROVIDER_ID,
    },
};

/** 所有 host 内置工具（由 Session 自动注入，不需要注册到 ToolRegistry）
 * @note view_media 是条件注入，不包含在这个静态列表里
 */
export const HOST_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
    ASK_USER_TOOL_DEFINITION,
];

export type ParsedUserInput =
    | { ok: true; request: UserInputRequest }
    | { ok: false; message: string };

/** 校验并解析 ask_user 的参数 */
export function parseUserInputRequest(call: ToolCall): ParsedUserInput {
    const rawQuestions = call.params.questions;
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
        return { ok: false, message: "params.questions must be a non-empty array" };
    }

    const questions: UserQuestion[] = [];
    const questionIds = new Set<string>();

    for (const [index, raw] of rawQuestions.entries()) {
        const prefix = `params.questions[${index}]`;
        if (!isRecord(raw)) {
            return { ok: false, message: `${prefix} must be an object` };
        }

        const id = readString(raw.id);
        if (id === undefined || id.length === 0) {
            return { ok: false, message: `${prefix}.id must be a non-empty string` };
        }
        if (questionIds.has(id)) {
            return { ok: false, message: `${prefix}.id "${id}" is duplicated` };
        }
        questionIds.add(id);

        const question = readString(raw.question);
        if (question === undefined || question.length === 0) {
            return { ok: false, message: `${prefix}.question must be a non-empty string` };
        }

        if (!Array.isArray(raw.options) || raw.options.length < 2) {
            return { ok: false, message: `${prefix}.options must contain at least 2 options` };
        }

        const options: UserQuestionOption[] = [];
        const optionIds = new Set<string>();

        for (const [optionIndex, rawOption] of raw.options.entries()) {
            const optionPrefix = `${prefix}.options[${optionIndex}]`;
            if (!isRecord(rawOption)) {
                return { ok: false, message: `${optionPrefix} must be an object` };
            }

            const optionId = readString(rawOption.id);
            if (optionId === undefined || optionId.length === 0) {
                return { ok: false, message: `${optionPrefix}.id must be a non-empty string` };
            }
            if (optionIds.has(optionId)) {
                return { ok: false, message: `${optionPrefix}.id "${optionId}" is duplicated` };
            }
            optionIds.add(optionId);

            const label = readString(rawOption.label);
            if (label === undefined || label.length === 0) {
                return { ok: false, message: `${optionPrefix}.label must be a non-empty string` };
            }

            options.push({
                id: optionId,
                label,
                description: readString(rawOption.description),
            });
        }

        questions.push({
            id,
            header: readString(raw.header),
            question,
            options,
            multiSelect: raw.multiSelect === true ? true : undefined,
            allowOther: raw.allowOther === true ? true : undefined,
        });
    }

    return {
        ok: true,
        request: {
            id: call.id,
            title: readString(call.params.title),
            questions,
        },
    };
}

/** 校验用户回答是否合法；返回问题列表，空数组表示通过 */
export function validateUserInputResult(
    request: UserInputRequest,
    result: UserInputResult,
): string[] {
    const problems: string[] = [];

    if (result.requestId !== request.id) {
        problems.push("requestId does not match the pending request");
    }

    const answers = new Map<string, UserInputAnswer>();
    for (const answer of result.answers) {
        answers.set(answer.questionId, answer);
    }

    for (const question of request.questions) {
        const answer = answers.get(question.id);
        if (answer === undefined) {
            problems.push(`missing answer for "${question.id}"`);
            continue;
        }

        const selected = Array.isArray(answer.selected) ? answer.selected : [];
        if (selected.length === 0 && answer.other === undefined) {
            problems.push(`no selection for "${question.id}"`);
        }
        if (selected.length > 1 && question.multiSelect !== true) {
            problems.push(`multiple selections for single-select question "${question.id}"`);
        }
        for (const selectedId of selected) {
            if (!question.options.some((option) => option.id === selectedId)) {
                problems.push(`unknown option "${selectedId}" for "${question.id}"`);
            }
        }
        if (answer.other !== undefined) {
            if (typeof answer.other !== "string") {
                problems.push(`"other" for "${question.id}" must be a string`);
            } else if (answer.other.trim().length === 0) {
                problems.push(`"other" for "${question.id}" must be non-empty`);
            }
            if (question.allowOther !== true) {
                problems.push(`"other" is not allowed for "${question.id}"`);
            }
        }
    }

    return problems;
}

/** 把回答格式化成模型可读的文本 */
export function formatUserInputResult(
    request: UserInputRequest,
    result: UserInputResult,
): string {
    const lines: string[] = [];

    for (const question of request.questions) {
        const answer = result.answers.find((item) => item.questionId === question.id);
        const title = question.header ?? question.id;

        if (answer === undefined) {
            lines.push(`${title}: (no answer)`);
            continue;
        }

        const labels = answer.selected.map((id) => {
            return question.options.find((option) => option.id === id)?.label ?? id;
        });
        const other = typeof answer.other === "string" ? answer.other.trim() : undefined;
        if (other !== undefined && other.length > 0) {
            labels.push(`其他: ${other}`);
        }

        lines.push(`${title}: ${labels.length > 0 ? labels.join(", ") : "(empty)"}`);
    }

    return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}
