import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { InvalidParameterError } from "../base";
import { ToolError, ToolErrorType } from "../session/error";
import type { ToolCall, ToolCallResult, ToolDefinition } from "../session/type";
import type { ToolCallOptions, ToolProvider } from "../session/tool";

/** 默认单次读取上限：256 KiB */
const DEFAULT_MAX_READ_BYTES = 256 * 1024;

/** 本地工具 Provider 选项 */
export type LocalToolProviderOptions = {

    /** Provider ID，最终工具名为 `<id>__<tool>`，默认 "local" */
    id?: string;

    /** Provider 显示名称 */
    name?: string;

    /** Provider 描述 */
    description?: string;

    /** 单次读取的最大字节数，超出部分会被截断 */
    maxReadBytes?: number;
};

/** 读取文本文件（只读，可并发） */
const readFileDefinition: ToolDefinition = {
    name: "readFile",
    title: "Read File",
    description: "读取工作区内的 UTF-8 文本文件。超出读取上限时会截断并给出提示。",
    defaultTrust: "unknown",
    inputSchema: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "相对于工作区根目录的路径",
            },
        },
        required: ["path"],
    },
    annotations: {
        readOnlyHint: true,
        concurrencySafe: true,
    },
};

/** 写入文本文件（覆盖写入，需要审批） */
const writeFileDefinition: ToolDefinition = {
    name: "writeFile",
    title: "Write File",
    description: "写入工作区内的 UTF-8 文本文件（覆盖写入，父目录会自动创建）。调用前需要人工审批。",
    defaultTrust: "trusted",
    inputSchema: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "相对于工作区根目录的路径",
            },
            content: {
                type: "string",
                description: "要写入的完整文本内容",
            },
        },
        required: ["path", "content"],
    },
    annotations: {
        destructiveHint: true,
        concurrencySafe: false,
        requiresApproval: true,
    },
};

/**
 * 绑定到当前进程的本地工具集。
 *
 * 所有路径都被限制在构造时指定的 rootDir 内：
 * - 先做词法解析，拒绝 `..` 越界；
 * - 再对真实路径（realpath）做一次检查，避免软链逃逸；
 * - 写入时拒绝写穿符号链接。
 */
export class LocalToolProvider implements ToolProvider {

    readonly id: string;
    readonly name: string;
    readonly description: string;

    private readonly _rootDir: string;
    private readonly _maxReadBytes: number;

    /** 缓存 realpath 后的根目录 */
    private _realRoot: string | null = null;

    constructor(rootDir: string, options: LocalToolProviderOptions = {}) {
        if (typeof rootDir !== "string" || rootDir.trim().length === 0) {
            throw new InvalidParameterError("LocalToolProvider requires a non-empty root directory");
        }

        const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
        if (!Number.isInteger(maxReadBytes) || maxReadBytes < 1) {
            throw new InvalidParameterError(
                `maxReadBytes must be a positive integer, got ${String(options.maxReadBytes)}`,
            );
        }

        this._rootDir = resolve(rootDir);
        this._maxReadBytes = maxReadBytes;

        this.id = options.id ?? "local";
        this.name = options.name ?? "Local Tools";
        this.description = options.description ?? "进程内本地工具（文件读写）";
    }

    /** 工作区根目录（绝对路径） */
    get rootDir(): string {
        return this._rootDir;
    }

    async fetchTools(): Promise<ToolDefinition[]> {
        return [readFileDefinition, writeFileDefinition];
    }

    async call(call: ToolCall, options?: ToolCallOptions): Promise<ToolCallResult> {
        this._throwIfAborted(options);

        switch (call.name) {
            case "readFile":
                return await this._readFile(call.params, options);

            case "writeFile":
                return await this._writeFile(call.params, options);

            default:
                throw new ToolError(
                    ToolErrorType.NotFound,
                    false,
                    `Unknown local tool "${call.name}"`,
                );
        }
    }

    /** 读取文本文件 */
    private async _readFile(
        params: Record<string, unknown>,
        options?: ToolCallOptions,
    ): Promise<ToolCallResult> {
        const requestedPath = this._requireString(params, "path");

        try {
            const root = await this._root();
            const target = await this._resolveReadTarget(root, requestedPath);

            this._throwIfAborted(options);

            let handle: FileHandle | undefined;
            try {
                handle = await open(target, "r");
                const info = await handle.stat();
                if (!info.isFile()) {
                    throw new ToolError(
                        ToolErrorType.InvalidParams,
                        false,
                        `Not a file: ${requestedPath}`,
                    );
                }

                const length = Math.min(info.size, this._maxReadBytes);
                const buffer = Buffer.alloc(length);
                const { bytesRead } = await handle.read(buffer, 0, length, 0);

                let content = buffer.subarray(0, bytesRead).toString("utf8");
                const truncated = info.size > bytesRead;
                if (truncated) {
                    content += `\n\n[... truncated: ${info.size - bytesRead} bytes omitted ...]`;
                }

                return {
                    content,
                    status: { isSuccess: true, duration: 0 },
                    structuredContent: {
                        path: relative(root, target),
                        bytes: bytesRead,
                        truncated,
                    },
                };
            } finally {
                await handle?.close().catch(() => {
                    // 关闭失败不影响已读取的结果
                });
            }
        } catch (error) {
            throw this._mapFsError(error, requestedPath);
        }
    }

    /** 写入文本文件 */
    private async _writeFile(
        params: Record<string, unknown>,
        options?: ToolCallOptions,
    ): Promise<ToolCallResult> {
        const requestedPath = this._requireString(params, "path");
        if (typeof params.content !== "string") {
            throw new ToolError(
                ToolErrorType.InvalidParams,
                false,
                "params.content must be a string",
            );
        }

        try {
            const root = await this._root();

            // 词法检查：先把 `..` 越界挡在创建目录之前
            const lexicalTarget = resolve(this._rootDir, requestedPath);
            this._assertContained(this._rootDir, lexicalTarget);

            await mkdir(dirname(lexicalTarget), { recursive: true });

            // 真实路径检查：父目录可能通过软链指向 root 之外
            const realParent = await realpath(dirname(lexicalTarget));
            this._assertContained(root, realParent);

            const target = join(realParent, basename(lexicalTarget));

            // 拒绝写穿符号链接
            try {
                const info = await lstat(target);
                if (info.isSymbolicLink()) {
                    throw new ToolError(
                        ToolErrorType.Denied,
                        false,
                        `Refusing to write through a symbolic link: ${requestedPath}`,
                    );
                }
            } catch (error) {
                if (!isErrno(error, "ENOENT")) throw error;
            }

            this._throwIfAborted(options);

            const content = params.content;
            await writeFile(target, content, "utf8");
            const bytes = Buffer.byteLength(content, "utf8");

            return {
                content: `Wrote ${bytes} bytes to ${relative(root, target)}`,
                status: { isSuccess: true, duration: 0 },
                structuredContent: {
                    path: relative(root, target),
                    bytes,
                },
            };
        } catch (error) {
            throw this._mapFsError(error, requestedPath);
        }
    }

    /** 确保根目录存在，并返回 realpath 后的根目录 */
    private async _root(): Promise<string> {
        if (this._realRoot !== null) return this._realRoot;

        await mkdir(this._rootDir, { recursive: true });
        this._realRoot = await realpath(this._rootDir);
        return this._realRoot;
    }

    /** 解析读取目标：词法检查 + realpath 检查 */
    private async _resolveReadTarget(root: string, requestedPath: string): Promise<string> {
        const lexicalTarget = resolve(this._rootDir, requestedPath);
        this._assertContained(this._rootDir, lexicalTarget);

        const realTarget = await realpath(lexicalTarget);
        this._assertContained(root, realTarget);
        return realTarget;
    }

    /** 校验目标路径位于 root 内 */
    private _assertContained(root: string, target: string): void {
        const rel = relative(root, target);
        if (rel === "") return;

        const segments = rel.split(sep);
        if (segments[0] === ".." || isAbsolute(rel)) {
            throw new ToolError(
                ToolErrorType.Denied,
                false,
                `Path escapes the workspace root: ${target}`,
            );
        }
    }

    /** 读取必填字符串参数 */
    private _requireString(params: Record<string, unknown>, key: string): string {
        const value = params[key];
        if (typeof value !== "string" || value.trim().length === 0) {
            throw new ToolError(
                ToolErrorType.InvalidParams,
                false,
                `params.${key} must be a non-empty string`,
            );
        }
        return value;
    }

    /** 已取消时直接抛出 */
    private _throwIfAborted(options?: ToolCallOptions): void {
        if (options?.signal?.aborted === true) {
            throw new ToolError(ToolErrorType.AbortError, false, "Tool call aborted");
        }
    }

    /** 把 fs 错误映射为工具错误 */
    private _mapFsError(error: unknown, target: string): ToolError {
        if (error instanceof ToolError) return error;

        if (isErrno(error, "ENOENT")) {
            return new ToolError(ToolErrorType.NotFound, false, `File not found: ${target}`);
        }
        if (isErrno(error, "EACCES") || isErrno(error, "EPERM")) {
            return new ToolError(ToolErrorType.Denied, false, `Permission denied: ${target}`);
        }
        if (isErrno(error, "EISDIR") || isErrno(error, "ENOTDIR")) {
            return new ToolError(ToolErrorType.InvalidParams, false, `Not a file: ${target}`);
        }

        return new ToolError(
            ToolErrorType.ProviderError,
            false,
            `Failed to access "${target}": ${errorMessage(error)}`,
            error,
        );
    }
}

/** 判断是否为指定 errno 的异常 */
function isErrno(error: unknown, code: string): boolean {
    return typeof error === "object"
        && error !== null
        && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
