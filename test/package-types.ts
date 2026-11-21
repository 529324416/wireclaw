import { AttachmentFileManager, McpToolProvider, createNewSession } from "wireclaw";
import { LocalFileHost, readLocalSourcePath } from "wireclaw/node";
import {
    LocalToolProvider,
    McpStdioTransport,
    createMcpProvider,
} from "wireclaw/client";
import type { ClientMcpServerConfig, McpTransportConfig } from "wireclaw/client";
import { IndexedDbFileHost, MemoryFileHost, OpfsFileHost } from "wireclaw/browser";

void AttachmentFileManager;
void McpToolProvider;
void createNewSession;
void LocalFileHost;
void readLocalSourcePath;
void LocalToolProvider;
void McpStdioTransport;
void createMcpProvider;
void IndexedDbFileHost;
void MemoryFileHost;
void OpfsFileHost;

const transport: McpTransportConfig = { type: "http", url: "http://127.0.0.1:5000/mcp" };
const config: ClientMcpServerConfig = { id: "mcp", transport };
void config;

console.log("PASS package type declarations");
