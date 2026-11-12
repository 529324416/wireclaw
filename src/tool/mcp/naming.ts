import type { McpTool } from "./type";

/** 模型侧 tool_id 的最大长度（为 provider 前缀与 "__" 留余量） */
export const MAX_TOOL_ID_LENGTH = 48;

export type ToolNameMapping = {

    /** 送给模型的裸工具名 */
    safeName: string;

    /** MCP 服务端原始工具名 */
    originalName: string;
};

/**
 * 把任意 MCP 工具名转换成模型安全 id：
 * - 只保留 [A-Za-z0-9_-]
 * - 连续下划线折叠为一个（Registry 禁止 tool_id 含 "__"）
 * - 超长时截断并追加哈希
 */
export function sanitizeToolId(name: string): string {
    let id = name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/_{2,}/g, "_");

    if (id.length === 0) id = "tool";

    if (id.length > MAX_TOOL_ID_LENGTH) {
        const hash = hashToolName(name);
        id = `${id.slice(0, MAX_TOOL_ID_LENGTH - hash.length - 1)}_${hash}`;
    }

    return id;
}

/** 为一组 MCP 工具生成安全的工具名映射（保持服务端返回顺序，解决冲突） */
export function createToolNameMappings(tools: readonly McpTool[]): ToolNameMapping[] {
    const used = new Set<string>();

    return tools.map((tool) => {
        const base = sanitizeToolId(tool.name);
        let candidate = base;
        let suffix = 2;

        while (used.has(candidate)) {
            candidate = withNumericSuffix(base, suffix);
            suffix += 1;
        }

        used.add(candidate);
        return {
            safeName: candidate,
            originalName: tool.name,
        };
    });
}

function withNumericSuffix(base: string, index: number): string {
    const suffix = `_${index}`;
    const limit = Math.max(1, MAX_TOOL_ID_LENGTH - suffix.length);
    return `${base.slice(0, limit)}${suffix}`;
}

/** FNV-1a 32 位哈希，用于超长名称的稳定短后缀 */
function hashToolName(value: string): string {
    let hash = 0x811c9dc5;

    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    return hash.toString(16).padStart(8, "0");
}
