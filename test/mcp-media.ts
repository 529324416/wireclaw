import assert from "node:assert/strict";

import { McpToolProvider } from "../src/tool/mcp/provider";
import type { McpTool } from "../src/tool/mcp/type";
import { FakeTransport, isRequest, respond, setupHandshake } from "./mcp-fakes";

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeWav(): Uint8Array {
    const buffer = new Uint8Array(44);
    const view = new DataView(buffer.buffer);
    const write = (offset: number, text: string): void => {
        for (let index = 0; index < text.length; index += 1) {
            buffer[offset + index] = text.charCodeAt(index);
        }
    };
    write(0, "RIFF");
    view.setUint32(4, 36, true);
    write(8, "WAVE");
    write(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, "data");
    view.setUint32(40, 0, true);
    return buffer;
}

const wavBytes = makeWav();

function base64(data: Uint8Array): string {
    return Buffer.from(data).toString("base64");
}

const tools: McpTool[] = [{
    name: "media_tool",
    description: "returns multimodal content",
    inputSchema: { type: "object", properties: {} },
    adviceTimeout: 600_000,
    annotations: { readOnlyHint: true },
}];

function setupHandler(
    transport: FakeTransport,
    content: unknown[],
    isError = false,
): void {
    transport.handler = (message) => {
        if (!isRequest(message)) return;

        if (message.method === "tools/list") {
            respond(transport, message.id, { tools });
            return;
        }

        if (message.method === "tools/call") {
            respond(transport, message.id, { content, isError });
        }
    };
    setupHandshake(transport);
}

/* ---------------------------------------------------------------------------
 * 1. image / audio / resource / resource_link 映射
 * ------------------------------------------------------------------------- */
{
    const transport = new FakeTransport();
    const resourceBytes = new TextEncoder().encode("%PDF-1.4 example");
    setupHandler(transport, [
        { type: "text", text: "media result" },
        { type: "image", data: base64(pngBytes), mimeType: "image/png" },
        { type: "audio", data: base64(wavBytes), mimeType: "audio/wav" },
        {
            type: "resource",
            resource: {
                uri: "file:///tmp/report.pdf",
                mimeType: "application/pdf",
                blob: base64(resourceBytes),
            },
        },
        {
            type: "resource",
            resource: {
                uri: "file:///tmp/notes.txt",
                mimeType: "text/plain",
                text: "notes text",
            },
        },
        {
            type: "resource_link",
            uri: "https://example.test/image.png",
            mimeType: "image/png",
        },
    ]);

    const provider = new McpToolProvider({ id: "mcp" }, transport);
    const definitions = await provider.fetchTools();
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0]?.adviceTimeout, 600_000);

    const result = await provider.call({
        id: "call-1",
        name: definitions[0]!.name,
        params: {},
    });

    assert.equal(result.status.isSuccess, true);
    assert.match(String(result.content), /media result/);
    assert.match(String(result.content), /notes text/);
    assert.ok(!String(result.content).includes("[image"), "图片不应只留文本占位");

    assert.ok(result.attachments !== undefined);
    assert.equal(result.attachments.length, 4);

    const image = result.attachments.find((attachment) => attachment.mimeType === "image/png"
        && attachment.kind === "bytes");
    assert.ok(image !== undefined && image.kind === "bytes");
    assert.deepEqual([...image.data], [...pngBytes]);

    const audio = result.attachments.find((attachment) => attachment.mimeType === "audio/wav");
    assert.ok(audio !== undefined && audio.kind === "bytes");

    const resource = result.attachments.find((attachment) => attachment.mimeType === "application/pdf");
    assert.ok(resource !== undefined && resource.kind === "bytes");
    assert.deepEqual([...resource.data], [...resourceBytes]);

    const link = result.attachments.find((attachment) => attachment.kind === "url");
    assert.ok(link !== undefined && link.kind === "url");
    assert.equal(link.url, "https://example.test/image.png");

    console.log("PASS MCP image/audio/resource/resource_link 映射");
}

/* ---------------------------------------------------------------------------
 * 2. isError 结果不落盘媒体
 * ------------------------------------------------------------------------- */
{
    const transport = new FakeTransport();
    setupHandler(transport, [
        { type: "text", text: "tool failed" },
        { type: "image", data: base64(pngBytes), mimeType: "image/png" },
    ], true);

    const provider = new McpToolProvider({ id: "mcp" }, transport);
    const definitions = await provider.fetchTools();
    const result = await provider.call({
        id: "call-2",
        name: definitions[0]!.name,
        params: {},
    });

    assert.equal(result.status.isSuccess, false);
    assert.equal(result.attachments, undefined);
    assert.match(String(result.content), /tool failed/);
    console.log("PASS MCP error 结果不产出附件");
}

/* ---------------------------------------------------------------------------
 * 3. 非法 base64 转成工具错误结果
 * ------------------------------------------------------------------------- */
{
    const transport = new FakeTransport();
    setupHandler(transport, [
        { type: "image", data: "not-base64!!!", mimeType: "image/png" },
    ]);

    const provider = new McpToolProvider({ id: "mcp" }, transport);
    const definitions = await provider.fetchTools();
    await assert.rejects(
        () => provider.call({
            id: "call-3",
            name: definitions[0]!.name,
            params: {},
        }),
        /Invalid MCP image base64/,
    );
    console.log("PASS MCP 非法媒体转成工具错误");
}

console.log("\nAll MCP media checks passed.");
