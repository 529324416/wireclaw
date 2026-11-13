import { defineConfig } from "tsup";

export default defineConfig([
    {
        entry: { index: "src/browser.ts" },
        outDir: "dist/browser",
        format: ["esm"],
        platform: "browser",
        target: "es2022",
        dts: false,
        sourcemap: false,
        clean: true,
        splitting: false,
        treeshake: true,
    },
    {
        entry: {
            node: "src/node.ts",
            client: "src/client/index.ts",
        },
        outDir: "dist/node",
        format: ["esm"],
        platform: "node",
        target: "node20",
        dts: false,
        sourcemap: false,
        clean: true,
        splitting: false,
        treeshake: true,
    },
]);
