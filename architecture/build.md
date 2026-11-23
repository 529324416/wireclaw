# Build and Publish

## 构建与发布

```bash
npm run build
```

构建产物：

```
dist/
  browser/index.js    浏览器安全核心（无 node:* 依赖）
  node/node.js        Node 核心 + LocalFileHost
  node/client.js      Node 参考客户端（本地工具 / MCP stdio）
  types/              tsc 生成的 .d.ts
```

- `package.json` 的 `exports` 指向 `dist`，`files` 只发布 `dist`；
- `prepublishOnly` 会在发布前自动执行构建；
- `tsup` 负责 ESM bundle，`tsc` 负责声明文件；
- 浏览器构建使用 `platform: "browser"`，如果误引入 `node:fs` / `node:child_process` 会直接构建失败；
- Node 构建使用 `platform: "node"`，内置模块保持外部依赖。

发布前可用：

```bash
npm pack --dry-run
```

检查包内文件是否符合预期。


