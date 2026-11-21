import assert from "node:assert/strict";

import { readMediaDuration } from "../src/base/media-duration";

function concat(...parts: readonly Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}

function ascii(text: string): Uint8Array {
    const out = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) {
        out[index] = text.charCodeAt(index) & 0xff;
    }
    return out;
}

function u16be(value: number): Uint8Array {
    const out = new Uint8Array(2);
    new DataView(out.buffer).setUint16(0, value, false);
    return out;
}

function u32be(value: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, false);
    return out;
}

function u64le(value: bigint): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, value, true);
    return out;
}

function f64be(value: number): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, value, false);
    return out;
}

function makeWav(seconds: number, sampleRate = 8000): Uint8Array {
    const samples = Math.round(seconds * sampleRate);
    const dataSize = samples * 2;
    const out = new Uint8Array(44 + dataSize);
    const view = new DataView(out.buffer);
    out.set(ascii("RIFF"), 0);
    view.setUint32(4, 36 + dataSize, true);
    out.set(ascii("WAVE"), 8);
    out.set(ascii("fmt "), 12);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    out.set(ascii("data"), 36);
    view.setUint32(40, dataSize, true);
    return out;
}

function makeMp3(frames: number): Uint8Array {
    const frameLength = Math.floor((144 * 128_000) / 44_100);
    const frame = new Uint8Array(frameLength);
    frame[0] = 0xff;
    frame[1] = 0xfb;
    frame[2] = 0x90;
    frame[3] = 0x00;

    return concat(...Array.from({ length: frames }, () => frame));
}

function isoBox(type: string, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(8 + payload.byteLength);
    new DataView(out.buffer).setUint32(0, out.byteLength, false);
    out.set(ascii(type), 4);
    out.set(payload, 8);
    return out;
}

function makeMp4(durationMs: number): Uint8Array {
    const mvhd = new Uint8Array(20);
    const view = new DataView(mvhd.buffer);
    view.setUint32(12, 1000, false);
    view.setUint32(16, durationMs, false);

    return concat(
        isoBox("ftyp", ascii("isom")),
        isoBox("moov", isoBox("mvhd", mvhd)),
    );
}

function ebmlSize(value: number): Uint8Array {
    for (let length = 1; length <= 8; length += 1) {
        const max = 2 ** (7 * length) - 1;
        if (value < max) {
            const out = new Uint8Array(length);
            let remaining = value;
            for (let index = length - 1; index >= 0; index -= 1) {
                out[index] = remaining & 0xff;
                remaining = Math.floor(remaining / 256);
            }
            out[0] |= 1 << (8 - length);
            return out;
        }
    }
    throw new Error("value is too large for EBML size");
}

function ebml(id: readonly number[], payload: Uint8Array): Uint8Array {
    return concat(new Uint8Array(id), ebmlSize(payload.byteLength), payload);
}

function ebmlUint(value: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, false);
    return out;
}

function makeWebm(duration: number): Uint8Array {
    const header = ebml([0x1a, 0x45, 0xdf, 0xa3], ebml([0x42, 0x82], ascii("webm")));
    const info = ebml([0x15, 0x49, 0xa9, 0x66], concat(
        ebml([0x2a, 0xd7, 0xb1], ebmlUint(1_000_000)),
        ebml([0x44, 0x89], f64be(duration)),
    ));
    return concat(header, ebml([0x18, 0x53, 0x80, 0x67], info));
}

function riffChunk(id: string, payload: Uint8Array): Uint8Array {
    const padding = payload.byteLength % 2;
    const out = new Uint8Array(8 + payload.byteLength + padding);
    out.set(ascii(id), 0);
    new DataView(out.buffer).setUint32(4, payload.byteLength, true);
    out.set(payload, 8);
    return out;
}

function makeAvi(seconds: number): Uint8Array {
    const frames = 25;
    const avih = new Uint8Array(56);
    const avihView = new DataView(avih.buffer);
    avihView.setUint32(0, Math.round((seconds * 1_000_000) / frames), true);
    avihView.setUint32(16, frames, true);

    const hdrl = riffChunk("LIST", concat(ascii("hdrl"), riffChunk("avih", avih)));
    return riffChunk("RIFF", concat(ascii("AVI "), hdrl));
}

function amfString(value: string): Uint8Array {
    return concat(new Uint8Array([0x02]), u16be(value.length), ascii(value));
}

function amfNumber(value: number): Uint8Array {
    return concat(new Uint8Array([0x00]), f64be(value));
}

function makeFlv(seconds: number): Uint8Array {
    const metadata = concat(
        amfString("onMetaData"),
        new Uint8Array([0x08]),
        u32be(1),
        u16be("duration".length),
        ascii("duration"),
        amfNumber(seconds),
        new Uint8Array([0x00, 0x00, 0x09]),
    );

    const header = new Uint8Array(9);
    header.set(ascii("FLV"), 0);
    header[3] = 0x01;
    new DataView(header.buffer).setUint32(5, 9, false);

    const tagHeader = new Uint8Array(11);
    tagHeader[0] = 18;
    const dataSize = metadata.byteLength;
    tagHeader[1] = (dataSize >> 16) & 0xff;
    tagHeader[2] = (dataSize >> 8) & 0xff;
    tagHeader[3] = dataSize & 0xff;

    return concat(header, tagHeader, metadata, u32be(0));
}

const ASF_HEADER_GUID = new Uint8Array([
    0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11,
    0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c,
]);

const ASF_FILE_PROPERTIES_GUID = new Uint8Array([
    0xa1, 0xdc, 0xab, 0x8c, 0x47, 0xa9, 0xcf, 0x11,
    0x8e, 0xe4, 0x00, 0xc0, 0x0c, 0x20, 0x53, 0x65,
]);

function makeAsf(seconds: number): Uint8Array {
    const payload = new Uint8Array(80);
    const payloadView = new DataView(payload.buffer);
    payloadView.setBigUint64(40, BigInt(Math.round(seconds * 10_000_000)), true);
    payloadView.setBigUint64(56, 0n, true);

    const properties = concat(
        ASF_FILE_PROPERTIES_GUID,
        u64le(BigInt(24 + payload.byteLength)),
        payload,
    );

    const header = new Uint8Array(24);
    header.set(ASF_HEADER_GUID, 0);
    new DataView(header.buffer).setBigUint64(16, BigInt(24 + properties.byteLength), true);

    return concat(header, properties);
}

function makeAmr(seconds: number): Uint8Array {
    const frames = Math.round(seconds / 0.02);
    const frame = new Uint8Array(32);
    frame[0] = 0x38; // AMR-NB mode 7（12.2 kbps）
    return concat(ascii("#!AMR\n"), ...Array.from({ length: frames }, () => frame));
}

function makeAmrWb(seconds: number): Uint8Array {
    const frames = Math.round(seconds / 0.02);
    const frame = new Uint8Array(61);
    frame[0] = 0x40; // AMR-WB mode 8（23.85 kbps）
    return concat(ascii("#!AMR-WB\n"), ...Array.from({ length: frames }, () => frame));
}

function makeAac(seconds: number): Uint8Array {
    const frameCount = Math.round((seconds * 44_100) / 1024);
    const frame = new Uint8Array(7);
    frame[0] = 0xff;
    frame[1] = 0xf1;
    frame[2] = 0x50; // AAC-LC / 44.1kHz / mono
    frame[3] = 0x40;
    frame[4] = 0x00;
    frame[5] = 0xe0; // frame length = 7
    frame[6] = 0xfc; // 1 raw data block
    return concat(...Array.from({ length: frameCount }, () => frame));
}

function assertDuration(label: string, data: Uint8Array, expected: number): void {
    const actual = readMediaDuration(data);
    assert.ok(actual !== undefined, `${label}: duration should be readable`);
    assert.ok(
        Math.abs(actual - expected) < 0.02,
        `${label}: expected ${expected}s, got ${actual}s`,
    );
    console.log(`PASS ${label} duration ${actual.toFixed(3)}s`);
}

assertDuration("WAV", makeWav(1), 1);
assertDuration("MP3", makeMp3(10), (10 * 1152) / 44_100);
assertDuration("MP4", makeMp4(2500), 2.5);
assertDuration("WebM", makeWebm(2500), 2.5);
assertDuration("AVI", makeAvi(1), 1);
assertDuration("FLV", makeFlv(3.5), 3.5);
assertDuration("ASF", makeAsf(2), 2);
assertDuration("AMR", makeAmr(1), 1);
assertDuration("AMR-WB", makeAmrWb(1), 1);
assertDuration("AAC", makeAac(1), 1);

assert.equal(
    readMediaDuration(new Uint8Array([0x00, 0x01, 0x02, 0x03]), "audio/wav"),
    undefined,
    "未知容器应返回 undefined",
);

console.log("\nAll media duration checks passed.");
