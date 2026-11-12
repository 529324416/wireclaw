import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { McpTransportError } from "./error";
import { isRecord } from "./type";
import type { JsonRpcMessage } from "./type";
import type { McpSendOptions, McpTransport } from "./transport";

export type McpStdioTransportOptions = {

    /** 要启动的可执行文件（例如 python / node / npx） */
    command: string;

    /** 命令行参数 */
    args?: string[];

    /** 追加的环境变量 */
    env?: Record<string, string>;

    /** 子进程工作目录 */
    cwd?: string;

    /** 子进程 stderr 输出（MCP 规定日志走 stderr） */
    onStderr?: (chunk: string) => void;

    /** 收到无法解析的输出时回调 */
    onProtocolError?: (error: Error) => void;
};

/** 标准输入输出传输：每行一个 JSON-RPC 消息 */
export class McpStdioTransport implements McpTransport {

    private readonly _options: McpStdioTransportOptions;
    private readonly _messageListeners = new Set<(message: JsonRpcMessage) => void>();
    private readonly _closeListeners = new Set<(error?: Error) => void>();

    private _child: ChildProcessWithoutNullStreams | null = null;
    private _buffer = "";
    private _closed = false;
    private _closeEmitted = false;

    constructor(options: McpStdioTransportOptions) {
        this._options = options;
    }

    async start(): Promise<void> {
        if (this._child !== null) return;
        if (this._options.command.trim().length === 0) {
            throw new McpTransportError("MCP stdio command must not be empty");
        }

        // 允许重连：重置关闭标记
        this._closed = false;
        this._closeEmitted = false;

        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawn(this._options.command, this._options.args ?? [], {
                cwd: this._options.cwd,
                env: { ...process.env, ...(this._options.env ?? {}) },
                shell: false,
            });
        } catch (error) {
            throw new McpTransportError(
                `Failed to spawn MCP server "${this._options.command}": ${errorMessage(error)}`,
                { cause: error },
            );
        }

        this._child = child;

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            this._onStdout(chunk);
        });

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            this._options.onStderr?.(chunk);
        });

        child.on("error", (error: Error) => {
            this._emitClose(new McpTransportError(
                `MCP stdio process error: ${error.message}`,
                { cause: error },
            ));
        });

        child.on("exit", (code, signal) => {
            if (this._closed) return;
            this._emitClose(new McpTransportError(
                `MCP stdio process exited (code=${String(code)}, signal=${String(signal)})`,
            ));
        });

        await new Promise<void>((resolve, reject) => {
            child.once("spawn", () => resolve());
            child.once("error", (error: Error) => reject(new McpTransportError(
                `Failed to spawn MCP server "${this._options.command}": ${error.message}`,
                { cause: error },
            )));
        });
    }

    async send(message: JsonRpcMessage, _options?: McpSendOptions): Promise<void> {
        const child = this._child;
        if (child === null || child.stdin.destroyed) {
            throw new McpTransportError("MCP stdio transport is not running");
        }

        child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    onMessage(listener: (message: JsonRpcMessage) => void): () => void {
        this._messageListeners.add(listener);
        return () => {
            this._messageListeners.delete(listener);
        };
    }

    onClose(listener: (error?: Error) => void): () => void {
        this._closeListeners.add(listener);
        return () => {
            this._closeListeners.delete(listener);
        };
    }

    async close(): Promise<void> {
        if (this._closed && this._child === null) return;
        this._closed = true;

        const child = this._child;
        this._child = null;
        if (child === null) return;

        try {
            child.stdin.end();
        } catch {
            // 忽略 stdin 已关闭
        }

        child.kill();

        await new Promise<void>((resolve) => {
            if (child.exitCode !== null) {
                resolve();
                return;
            }

            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                resolve();
            }, 2_000);

            child.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    private _onStdout(chunk: string): void {
        this._buffer += chunk;

        let index = this._buffer.indexOf("\n");
        while (index >= 0) {
            const line = this._buffer.slice(0, index).replace(/\r$/, "").trim();
            this._buffer = this._buffer.slice(index + 1);
            if (line.length > 0) this._onLine(line);
            index = this._buffer.indexOf("\n");
        }
    }

    private _onLine(line: string): void {
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch (error) {
            this._options.onProtocolError?.(new McpTransportError(
                `Invalid JSON from MCP server: ${line.slice(0, 120)}`,
                { cause: error },
            ));
            return;
        }

        if (!isRecord(value)) {
            this._options.onProtocolError?.(new McpTransportError(
                `MCP message must be an object: ${line.slice(0, 120)}`,
            ));
            return;
        }

        for (const listener of [...this._messageListeners]) {
            listener(value as JsonRpcMessage);
        }
    }

    private _emitClose(error?: Error): void {
        if (this._closeEmitted) return;
        this._closeEmitted = true;
        this._child = null;

        for (const listener of [...this._closeListeners]) {
            listener(error);
        }
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
