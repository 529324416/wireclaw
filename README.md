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

`sourcePaths` are stored with the attachment metadata. If the host loses the bytes, the manager tries to recover them from the original paths.

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

Permission levels:

```ts
await session.run("Read-only query", {
  tools: registry,
  permission: "readonly",
});
```

See [architecture.md](./architecture.md) for the full semantics of `readonly` / `approval` / `full`.

## Development

```bash
npm install
npm run typecheck
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
- [README.zh-CN.md](./README.zh-CN.md): Chinese README
- [LICENSE](./LICENSE): MIT

## License

MIT © 2026 biscuit

<!-- Maintenance note: keep README focused on the introduction and basic usage; put implementation details in architecture.md. -->
