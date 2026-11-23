# Wireclaw

English | [简体中文](./README.zh-CN.md)

Wireclaw is an embeddable AI harness module.

It turns the conversation loop, tool calling, approval and permissions, attachment management, session serialization, and multi-provider adaptation into a composable `Session`. The host supplies the concrete LLM, tools, and attachment storage.

> Architecture, provider, MCP, attachment internals, build, and test details: [architecture.md](./architecture.md) (currently in Chinese).

## Status

- Version: `0.1.1` (early release; APIs may still change)
- Module format: ESM
- Node: `>=20.3.0`
- The core entry is browser-safe; Node-only capabilities live behind subpaths
- License: MIT, see [LICENSE](./LICENSE)

## Install

```bash
npm install wireclaw
```

## Entry points

| Entry | Contents |
|---|---|
| `wireclaw` | Browser-safe core: Session, attachment manager, providers, MCP core |
| `wireclaw/browser` | Explicit browser-safe entry, identical to the root entry |
| `wireclaw/node` | Core plus `LocalFileHost` / `readLocalSourcePath` |
| `wireclaw/client` | Node-only reference client: local tools, MCP stdio, `createMcpProvider` |

## Quick start: Node + Ollama

```ts
import { createNewSession, OllamaProvider } from "wireclaw";

const session = createNewSession(new OllamaProvider());

const run = await session.run("Hello, introduce yourself");
console.log(run.status);
```

`createNewSession` creates a session with an empty history. If no model is supplied explicitly, the first run asks the provider for its default model (Ollama prefers `qwen3.5:9b`).

DeepSeek:

```ts
import { DeepSeekProvider, createNewSession } from "wireclaw";

const llm = new DeepSeekProvider({
  apiKey: process.env.DEEPSEEK_API_KEY!,
});

const session = createNewSession(llm);
await session.run("Hello");
```

MiniMax (mainland China endpoint):

```ts
import { MiniMaxChatProvider, createNewSession } from "wireclaw";

const provider = new MiniMaxChatProvider({
  apiKey: process.env.MINIMAX_API_KEY!,
  baseUrl: "https://api.minimax.cn",
  model: "MiniMax-M3.1-Flash",
});

const session = createNewSession(provider);
await session.run("Hello");
```

Qwen (DashScope, OpenAI-compatible):

```ts
import { QwenChatProvider, createNewSession } from "wireclaw";

const provider = new QwenChatProvider({
  apiKey: process.env.DASHSCOPE_API_KEY!,
  model: "qwen-plus",
});

const session = createNewSession(provider);
await session.run("Hello");
```

Qwen `/models` does not expose input modalities. The reference client applies `applyQwenReferenceModelOverrides` from `wireclaw/client`; library hosts should call `provider.overwriteMany(...)` with their own capability data. Omni models accept text, images, audio, and video via the session attachment pipeline (audio/video are sent as data URIs). Image-generation models (`qwen-image-*`) are separate `GenerationCapability` providers, not chat models; use `QwenImageProvider` when you need direct generation.

`Session` enforces the active model's media input limits (MIME, raw/encoded size, count, and duration) before upload. Qwen inline audio/video is capped at 10 MB after base64 encoding.

## Attachments: local files on Node

```ts
import { readFile } from "node:fs/promises";

import { AttachmentFileManager, OllamaProvider, createNewSession } from "wireclaw";
import { LocalFileHost, readLocalSourcePath } from "wireclaw/node";

const path = "/absolute/path/photo.png";
const bytes = new Uint8Array(await readFile(path));

const host = new LocalFileHost("./.wireclaw-files");
const attachmentManager = new AttachmentFileManager(host, {
  readSourcePath: readLocalSourcePath,
});

const session = createNewSession(new OllamaProvider(), attachmentManager);
const file = await attachmentManager.put("photo.png", bytes, "image/png", [path]);

await session.run([
  { type: "text", text: "Describe this image" },
  { type: "attachment", attachment: { contentHash: file.contentHash } },
]);
```

`sourcePaths` are stored with the attachment metadata. If the host loses the bytes, the manager tries to recover them from the original paths. A missing **historical** attachment is sent to the model as `[attachment unavailable: <contentHash>]` instead of blocking the session; a missing attachment in the current turn still fails the run.

## Browser / Electron renderer

```ts
import {
  AttachmentFileManager,
  createNewSession,
  OllamaProvider,
  OpfsFileHost,
} from "wireclaw/browser";

const host = new OpfsFileHost();
const attachmentManager = new AttachmentFileManager(host);
const session = createNewSession(new OllamaProvider(), attachmentManager);

await session.run("Hello");
```

- Do not import `wireclaw/node` or `wireclaw/client` in the browser; they contain `node:fs` / `node:child_process`.
- Direct requests to Ollama or DeepSeek from a renderer may hit CORS. Usually you want a host proxy or forwarding through the main process.
- Electron: use `wireclaw/node` in the main process and `wireclaw/browser` in the renderer.

## Tools and MCP

The core package provides an MCP client and an HTTP transport:

```ts
import { McpHttpTransport, McpToolProvider, ToolRegistry } from "wireclaw";

const registry = new ToolRegistry();
registry.registerProvider(new McpToolProvider(
  { id: "mcp" },
  new McpHttpTransport({ url: "http://127.0.0.1:5000/mcp" }),
));

await session.run("Check the current Python environment", { tools: registry });
```

Node hosts can also use the reference implementations:

```ts
import { ToolRegistry } from "wireclaw";
import { LocalToolProvider, createMcpProvider } from "wireclaw/client";

const registry = new ToolRegistry();
registry.registerProvider(new LocalToolProvider(process.cwd()));
registry.registerProvider(createMcpProvider({
  id: "mcp",
  transport: { type: "http", url: "http://127.0.0.1:5000/mcp" },
}));
```

Tool results carry a trust marker (`ToolCallResult.trust` / `ToolMessage.trust`): tools and providers declare defaults, and a host can pass `new ToolRegistry({ trustHandle })` to override them per call. Trust never changes permissions, so `full` still means full; hosts can use the marker for prompt framing, UI badges, or audit.

Tool results can carry media through `ToolCallResult.attachments`. `Session` stores them in the attachment manager and, when the active model accepts that media input, forwards them as a synthetic user message for the next turn. MCP `image` / `audio` / `resource` results use the same pipeline. The reference MiniMax H3-Image and ComfyUI Qwen-Image tools also accept optional `references` (session `contentHash` or image URL), `seed`, and `negative_prompt`.

The reference Node client registers two local ComfyUI Qwen-Image tools when their workflows exist: `comfyui-image__generateImage` and `comfyui-edit__editImage` (requires at least one reference image). Set `COMFYUI_BASE_URL`, `WIRECLAW_COMFYUI_WORKFLOW`, and `WIRECLAW_COMFYUI_EDIT_WORKFLOW` to point at another ComfyUI instance/workflow. These test tools live in `tools/` and are not part of the published `wireclaw/client` entry.

The reference client can also merge local static model capabilities from `modelOverwrite.json` (override with `WIRECLAW_MODEL_OVERWRITE_FILE`). Entries use the `ModelInfo` shape and are merged over the initialized model catalog; omitted fields keep their defaults. Copy `modelOverwrite.example.json` to `modelOverwrite.json` and edit the copy; the default file is intentionally git-ignored.

Permission levels:

```ts
await session.run("Read-only query", {
  tools: registry,
  permission: "readonly",
});
```

See [architecture.md](./architecture.md) for the full semantics of `readonly` / `approval` / `full`.

## Real local pipeline facade

[`harness.ts`](./harness.ts) is the runnable facade for the harness designer. It uses the real
Qwen chat provider and the local ComfyUI Qwen-Image workflow:

```text
topic
  → Qwen: write an English image prompt
  → B node + ComfyUI generateImage tool: create the image
  → Qwen-VL: caption the generated image
  → output text + image attachment
```

Prerequisites:

- ComfyUI at `http://127.0.0.1:8188` with the workflow from
  `examples/comfyui/qwen-image-2.1-t2i.json`;
- a working `apikey-qwen.txt` (or `DASHSCOPE_API_KEY` / `QWEN_API_KEY`).

```bash
npm run harness
npm run harness -- "a small robot tending a rooftop garden at sunrise"
```

Generated files are written under `harness-output/` (ignored by git):

- `<timestamp>-image.png`
- `<timestamp>-caption.txt` (topic, prompt, caption)

Useful environment variables: `HARNESS_PROMPT_MODEL`, `HARNESS_IMAGE_MODEL`,
`HARNESS_VISION_MODEL`, `QWEN_BASE_URL`, `COMFYUI_BASE_URL`,
`WIRECLAW_COMFYUI_WORKFLOW`, `WIRECLAW_COMFYUI_TIMEOUT_MS`.

### Four-panel comic pipeline

[`harness-comic.ts`](./harness-comic.ts) plans a four-panel story, generates each panel through
ComfyUI, has Qwen-VL review every panel, regenerates failed panels with review feedback, and
creates a 2×2 contact sheet:

```bash
npm run comic
npm run comic -- "a small robot caring for the last sunflower on a rooftop"
```

- Planner: Qwen creates exactly four panel briefs.
- Per panel: LoopNode runs generate → review → feedback/retry, up to 3 attempts.
- `retryOnError` retries transient provider failures as well.
- Passed images are aggregated by ForEach and merged into `comic-output/<timestamp>-comic.png`.
- If a panel still fails review after the retry budget, the sheet is still written but the
  pipeline exits non-zero and reports the failed panel.

Set `COMIC_FORCE_RETRY_PANEL=<index>` to rehearse the retry path for one panel.
Generated files are ignored under `comic-output/`.

## Development

```bash
npm install
npm run typecheck        # source, browser-safe surface, tools and tests
npm test                 # offline suite; excludes live/local-service scripts
npm run test:live        # live scripts; needs local services or API keys
npm run example:harness  # minimal runnable Harness graph (no provider needed)
npm run example:preset   # preset -> tool dependency -> remove -> restore
npm run example:branch   # branch -> implicit join / skipped / ambiguity
npm run example:composite # subgraph + foreach + loop + checkpoint
npm run harness          # real Qwen + local ComfyUI image pipeline
npm run build
```

Build output:

```
dist/
  browser/index.js
  node/node.js
  node/client.js
  types/
```

## Documentation

- [architecture.md](./architecture.md): architecture, providers, MCP, attachments, build and tests
- [harness.md](./harness.md): Harness goals, use cases, current capabilities, gaps and roadmap
- [todo.md](./todo.md): task backlog
- [README.zh-CN.md](./README.zh-CN.md): Chinese README
- [LICENSE](./LICENSE): MIT

## License

MIT © 2026 biscuit

<!-- Maintenance note: keep README focused on the introduction and basic usage; put implementation details in architecture.md. -->
