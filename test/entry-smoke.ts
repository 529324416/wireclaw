import assert from "node:assert/strict";

import * as root from "wireclaw";
import * as browser from "wireclaw/browser";
import * as node from "wireclaw/node";
import * as client from "wireclaw/client";

assert.equal("LocalFileHost" in root, false, "root entry must stay browser-safe");
assert.equal("LocalFileHost" in browser, false, "browser entry must not expose LocalFileHost");
assert.equal("LocalFileHost" in node, true, "node entry must expose LocalFileHost");
assert.equal("AttachmentFileManager" in root, true);
assert.equal("McpToolProvider" in root, true);
assert.equal("createNewSession" in root, true);
assert.equal("createNewSession" in browser, true);
assert.equal("createNewSession" in node, true);
assert.equal("LocalToolProvider" in root, false, "core must not expose local tools");
assert.equal("McpStdioTransport" in root, false, "core must not expose stdio transport");

assert.equal("LocalToolProvider" in client, true, "client entry must expose local tools");
assert.equal("McpStdioTransport" in client, true, "client entry must expose stdio transport");
assert.equal("createMcpProvider" in client, true, "client entry must expose the MCP factory");
assert.equal("McpTransportConfig" in client, false, "transport configs are types only");

console.log("PASS package entries: root/browser/node/client");
