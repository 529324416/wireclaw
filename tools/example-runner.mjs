#!/usr/bin/env node

/**
 * 示例运行器：用 esbuild 原生二进制把 examples/ 下的 TS 打包成 ESM，
 * 再用当前 Node 运行；不通过管道捕获子进程输出，兼容受限沙箱。
 *
 * 用法：
 *   node tools/example-runner.mjs examples/harness/run-minimal.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];

if (target === undefined || target.length === 0) {
    console.error("usage: node tools/example-runner.mjs <examples/...ts>");
    process.exit(1);
}

const entry = path.resolve(repoRoot, target);
if (!existsSync(entry)) {
    console.error(`[example] entry not found: ${entry}`);
    process.exit(1);
}

const require = createRequire(import.meta.url);

function resolveEsbuildBinary() {
    const packageName = `@esbuild/${process.platform}-${process.arch}`;
    const packageRoot = path.dirname(require.resolve(`${packageName}/package.json`));
    const binary = process.platform === "win32"
        ? path.join(packageRoot, "esbuild.exe")
        : path.join(packageRoot, "bin", "esbuild");

    if (!existsSync(binary)) {
        throw new Error(`esbuild binary not found: ${binary}; run npm install first`);
    }
    return binary;
}

let esbuild;
try {
    esbuild = resolveEsbuildBinary();
} catch (error) {
    console.error(`[example] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}

const tempDir = mkdtempSync(path.join(tmpdir(), "wireclaw-example-"));
const bundlePath = path.join(tempDir, "example.mjs");

try {
    const bundle = spawnSync(esbuild, [
        entry,
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--target=node20",
        "--log-level=error",
        `--outfile=${bundlePath}`,
    ], {
        cwd: repoRoot,
        stdio: "inherit",
    });

    if (bundle.error !== undefined || bundle.status !== 0) {
        console.error(`[example] bundle failed: ${bundle.error?.message ?? `exit ${String(bundle.status)}`}`);
        process.exitCode = 1;
    } else {
        const run = spawnSync(process.execPath, [bundlePath], {
            cwd: repoRoot,
            stdio: "inherit",
            timeout: 120_000,
        });

        if (run.error !== undefined || run.status !== 0) {
            console.error(`[example] run failed: ${run.error?.message ?? `exit ${String(run.status)}`}`);
            process.exitCode = 1;
        }
    }
} finally {
    rmSync(tempDir, { recursive: true, force: true });
}
