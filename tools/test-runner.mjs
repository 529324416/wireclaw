#!/usr/bin/env node

/**
 * Wireclaw 离线测试聚合入口。
 *
 *  - 使用 esbuild 原生二进制把每个测试脚本打包成 ESM，再用当前 Node 运行；
 *  - 默认只跑不依赖外部服务/凭证的脚本，实机脚本用 --all 显式开启；
 *  - 不通过管道捕获子进程输出，兼容受限沙箱（spawn 管道可能被拒绝）。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/** 默认不跑：需要本地服务、外部 API key 或宿主子进程的脚本 */
const LIVE_TESTS = new Set([
    "comfyui-image-live.ts",
    "factory-live.ts",
    "factory-live-deepseek.ts",
    "live-services.ts",
    "mcp-flask.ts",
    "mcp-stdio.ts",
    "mcp-tool-media-deepseek-live.ts",
    "mcp-tool-media-ollama-live.ts",
    "minimax-image-reference-live.ts",
    "ollama-protocol.ts",
    "ollama-tools.ts",
    "qwen-image-live.ts",
    "qwen-live.ts",
    "qwen-media-live.ts",
    "qwen-omni-probe.ts",
    "qwen-probe.ts",
    "tool-media-ollama-live.ts",
    "tool-media-qwen-live.ts",
]);

const PACKAGE_ENTRY_TESTS = new Set(["entry-smoke.ts", "package-types.ts"]);

const args = process.argv.slice(2);
const includeLive = args.includes("--all");
const listOnly = args.includes("--list");
const filters = args.filter((arg) => !arg.startsWith("--"));

function resolveEsbuildBinary() {
    const packageName = `@esbuild/${process.platform}-${process.arch}`;
    const packageJson = require.resolve(`${packageName}/package.json`);
    const packageRoot = path.dirname(packageJson);
    const binary = process.platform === "win32"
        ? path.join(packageRoot, "esbuild.exe")
        : path.join(packageRoot, "bin", "esbuild");

    if (!existsSync(binary)) {
        throw new Error(`esbuild binary not found: ${binary}; run npm install first`);
    }
    return binary;
}

function packageEntryTestsReady() {
    return ["dist/browser/index.js", "dist/node/node.js", "dist/node/client.js"]
        .every((file) => existsSync(path.join(repoRoot, file)));
}

function collectTests() {
    const testDir = path.join(repoRoot, "test");
    if (!existsSync(testDir)) return [];

    return readdirSync(testDir)
        .filter((name) => name.endsWith(".ts") && name !== "mcp-fakes.ts")
        .filter((name) => includeLive || !LIVE_TESTS.has(name))
        .filter((name) => filters.length === 0 || filters.some((filter) => name.includes(filter)))
        .filter((name) => {
            if (!PACKAGE_ENTRY_TESTS.has(name)) return true;
            if (packageEntryTestsReady()) return true;
            console.warn(`[skip] ${name}: dist is missing; run the build first`);
            return false;
        })
        .sort();
}

function main() {
    const tests = collectTests();

    if (listOnly) {
        for (const test of tests) console.log(test);
        return 0;
    }

    if (tests.length === 0) {
        console.error("[test] no runnable test scripts found");
        return 1;
    }

    let esbuild;
    try {
        esbuild = resolveEsbuildBinary();
    } catch (error) {
        console.error(`[test] ${error instanceof Error ? error.message : String(error)}`);
        return 1;
    }

    if (includeLive) {
        console.warn("[test] --all: live tests may call external services and consume API quota");
    }

    const tempDir = mkdtempSync(path.join(tmpdir(), "wireclaw-tests-"));
    const failures = [];

    try {
        for (const [index, test] of tests.entries()) {
            const name = path.basename(test, ".ts");
            const bundlePath = path.join(
                tempDir,
                `${String(index).padStart(2, "0")}-${name}.mjs`,
            );
            const label = `[${index + 1}/${tests.length}] ${name}`;

            console.log(`\n=== ${label} ===`);

            const bundle = spawnSync(esbuild, [
                path.join(repoRoot, "test", test),
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
                const reason = bundle.error?.message
                    ?? `bundle exited with ${String(bundle.status)}`;
                console.error(`[test] ${name}: ${reason}`);
                failures.push(`${name} (bundle)`);
                continue;
            }

            const run = spawnSync(process.execPath, [bundlePath], {
                cwd: repoRoot,
                stdio: "inherit",
                timeout: 120_000,
            });

            if (run.error !== undefined || run.status !== 0) {
                const reason = run.error?.message
                    ?? `exited with ${run.signal === null ? String(run.status) : `signal ${run.signal}`}`;
                console.error(`[test] ${name}: ${reason}`);
                failures.push(name);
            }
        }
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }

    console.log("\n" + "=".repeat(60));
    console.log(`[test] ${tests.length - failures.length}/${tests.length} passed`);
    if (failures.length > 0) {
        console.error(`[test] failed: ${failures.join(", ")}`);
        return 1;
    }
    return 0;
}

process.exitCode = main();
