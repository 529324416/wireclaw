import {
    AttachmentFileManager,
    Graph,
    GraphRun,
    McpToolProvider,
    NodePresetLibrary,
    NodeTypeRegistry,
    ToolSet,
    createBuiltinNodeRegistry,
    createEditorCatalog,
    createNewSession,
    instantiateNodePreset,
    serializeNodePreset,
} from "wireclaw";
import type {
    GraphCheckpoint,
    GraphDocument,
    GraphEditorCatalog,
    GraphHost,
    GraphRunResult,
    NodePresetDocument,
    NodePresetLibraryDocument,
} from "wireclaw";
import { LocalFileHost, readLocalSourcePath } from "wireclaw/node";
import {
    LocalToolProvider,
    McpStdioTransport,
    createMcpProvider,
} from "wireclaw/client";
import type { ClientMcpServerConfig, McpTransportConfig } from "wireclaw/client";
import { IndexedDbFileHost, MemoryFileHost, OpfsFileHost } from "wireclaw/browser";

void AttachmentFileManager;
void Graph;
void GraphRun;
void McpToolProvider;
void NodePresetLibrary;
void NodeTypeRegistry;
void ToolSet;
void createBuiltinNodeRegistry;
void createEditorCatalog;
void createNewSession;
void instantiateNodePreset;
void serializeNodePreset;
void (null as unknown as GraphCheckpoint);
void (null as unknown as GraphDocument);
void (null as unknown as GraphEditorCatalog);
void (null as unknown as GraphHost);
void (null as unknown as GraphRunResult);
void (null as unknown as NodePresetDocument);
void (null as unknown as NodePresetLibraryDocument);
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

const graphDocument: GraphDocument = { version: 1, id: "demo", nodes: [], edges: [] };
void graphDocument;

console.log("PASS package type declarations");
