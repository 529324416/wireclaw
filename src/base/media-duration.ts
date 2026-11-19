/* 媒体容器时长解析
 *
 * 只读取容器元数据，不依赖 DOM / Node，也不解码音视频内容。
 * 用于在发送前执行模型级 maxDurationSeconds 限制；无法确定时返回 undefined。
 */

/** 读取媒体时长（秒）；无法从容器中确定时返回 undefined
 * @param data 媒体原始字节
 * @param mimeType 已知 MIME；仅作为容器识别的补充提示
 */
export function readMediaDuration(data: Uint8Array, mimeType?: string): number | undefined{
    if (data.byteLength < 4) return undefined;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    try{
        switch (detectContainer(data)){
            case "wav":
                return readWavDuration(data, view);
            case "avi":
                return readAviDuration(data, view);
            case "mp3":
                return readMp3Duration(data, view);
            case "aac":
                return readAdtsDuration(data);
            case "amr":
                return readAmrDuration(data);
            case "mp4":
                return readIsoBmffDuration(data, view);
            case "matroska":
                return readMatroskaDuration(data, view);
            case "flv":
                return readFlvDuration(data, view);
            case "asf":
                return readAsfDuration(data, view);
            default:
                return readByMimeType(data, view, mimeType);
        }
    }catch{
        // 损坏/截断的容器不应让整个运行失败；由调用方按“无法确定时长”处理
        return undefined;
    }
}

type ContainerKind =
    | "wav" | "avi" | "mp3" | "aac" | "amr"
    | "mp4" | "matroska" | "flv" | "asf";

function detectContainer(data: Uint8Array): ContainerKind | undefined{
    if (ascii(data, 0, 4) === "RIFF"){
        const form = ascii(data, 8, 4);
        if (form === "WAVE") return "wav";
        if (form === "AVI ") return "avi";
    }

    if (ascii(data, 0, 3) === "ID3") return "mp3";

    if (data[0] === 0xff && data.byteLength >= 2){
        // ADTS：12-bit syncword + layer=00；MP3：layer!=00
        if ((data[1] & 0xf6) === 0xf0) return "aac";
        if ((data[1] & 0xe0) === 0xe0) return "mp3";
    }

    if (ascii(data, 0, 5) === "#!AMR") return "amr";
    if (ascii(data, 0, 3) === "FLV") return "flv";

    if (matches(data, 0, [0x1a, 0x45, 0xdf, 0xa3])) return "matroska";
    if (matches(data, 0, ASF_HEADER_GUID)) return "asf";

    // ISO BMFF：ftyp 位于首个 box 的 type 位置
    if (data.byteLength >= 8 && ascii(data, 4, 4) === "ftyp") return "mp4";

    return undefined;
}

function readByMimeType(
    data: Uint8Array,
    view: DataView,
    mimeType: string | undefined,
): number | undefined{
    switch (normalizeMimeType(mimeType)){
        case "audio/wav":
        case "audio/x-wav":
            return readWavDuration(data, view);
        case "audio/mpeg":
        case "audio/mp3":
            return readMp3Duration(data, view);
        case "audio/aac":
            return readAdtsDuration(data);
        case "audio/amr":
            return readAmrDuration(data);
        case "audio/3gpp":
        case "video/mp4":
        case "video/quicktime":
        case "video/3gpp":
            return readIsoBmffDuration(data, view);
        case "video/x-msvideo":
            return readAviDuration(data, view);
        case "video/webm":
        case "video/x-matroska":
            return readMatroskaDuration(data, view);
        case "video/x-flv":
            return readFlvDuration(data, view);
        case "video/x-ms-wmv":
            return readAsfDuration(data, view);
        default:
            return undefined;
    }
}

/* ---------------------------------------------------------------------------
 * WAV / AVI：RIFF 容器
 * ------------------------------------------------------------------------- */

function readWavDuration(data: Uint8Array, view: DataView): number | undefined{
    if (ascii(data, 0, 4) !== "RIFF" || ascii(data, 8, 4) !== "WAVE") return undefined;

    let byteRate = 0;
    let sampleRate = 0;
    let blockAlign = 0;
    let dataSize: number | undefined;

    let offset = 12;
    while (offset + 8 <= data.byteLength){
        const id = ascii(data, offset, 4);
        const size = view.getUint32(offset + 4, true);
        const payload = offset + 8;
        if (size > data.byteLength - payload) break;

        if (id === "fmt " && size >= 12){
            byteRate = view.getUint32(payload + 8, true);
            blockAlign = view.getUint16(payload + 12, true);
            sampleRate = view.getUint32(payload + 4, true);
        } else if (id === "data"){
            dataSize = size;
            break;
        }

        offset = payload + size + (size & 1);
    }

    if (dataSize === undefined || dataSize <= 0) return undefined;

    const rate = byteRate > 0 ? byteRate : sampleRate * blockAlign;
    if (rate <= 0) return undefined;
    return dataSize / rate;
}

function readAviDuration(data: Uint8Array, view: DataView): number | undefined{
    if (ascii(data, 0, 4) !== "RIFF" || ascii(data, 8, 4) !== "AVI ") return undefined;

    let duration = 0;

    walkRiffChunks(data, view, 12, data.byteLength, (id, payload) => {
        if (id === "avih" && payload + 20 <= data.byteLength){
            const microSecondsPerFrame = view.getUint32(payload, true);
            const totalFrames = view.getUint32(payload + 16, true);
            if (microSecondsPerFrame > 0 && totalFrames > 0){
                duration = Math.max(duration, (microSecondsPerFrame * totalFrames) / 1_000_000);
            }
            return;
        }

        if (id === "strh" && payload + 36 <= data.byteLength){
            const scale = view.getUint32(payload + 20, true);
            const rate = view.getUint32(payload + 24, true);
            const length = view.getUint32(payload + 32, true);
            if (scale > 0 && rate > 0 && length > 0){
                duration = Math.max(duration, (length * scale) / rate);
            }
        }
    });

    return duration > 0 ? duration : undefined;
}

function walkRiffChunks(
    data: Uint8Array,
    view: DataView,
    start: number,
    end: number,
    visit: (id: string, payload: number, chunkEnd: number) => void,
    depth = 0,
): void{
    if (depth > 8) return;

    let offset = start;
    while (offset + 8 <= end){
        const id = ascii(data, offset, 4);
        const size = view.getUint32(offset + 4, true);
        const payload = offset + 8;
        const chunkEnd = payload + size;
        if (chunkEnd > end) return;

        if (id === "LIST" && payload + 4 <= chunkEnd){
            walkRiffChunks(data, view, payload + 4, chunkEnd, visit, depth + 1);
        } else {
            visit(id, payload, chunkEnd);
        }

        offset = chunkEnd + (size & 1);
    }
}

/* ---------------------------------------------------------------------------
 * MP3
 * ------------------------------------------------------------------------- */

const MP3_BITRATES_MPEG1: readonly (readonly number[])[] = [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], // Layer I
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],    // Layer II
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],     // Layer III
];

const MP3_BITRATES_MPEG2: readonly (readonly number[])[] = [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
];

const MP3_SAMPLE_RATES: readonly (readonly number[])[] = [
    [11025, 12000, 8000],   // MPEG 2.5
    [0, 0, 0],              // reserved
    [22050, 24000, 16000],  // MPEG 2
    [44100, 48000, 32000],  // MPEG 1
];

type Mp3Frame = {
    frameLength: number;
    sampleRate: number;
    samplesPerFrame: number;
    sideInfoSize: number;
    hasCrc: boolean;
    isMono: boolean;
};

function readMp3Duration(data: Uint8Array, view: DataView): number | undefined{
    let offset = skipId3v2(data);
    const searchEnd = Math.min(data.byteLength - 4, offset + 64 * 1024);
    let firstFrameOffset: number | undefined;

    for (let position = offset; position <= searchEnd; position += 1){
        if (parseMp3FrameHeader(data, position) !== undefined){
            firstFrameOffset = position;
            break;
        }
    }
    if (firstFrameOffset === undefined) return undefined;

    const firstFrame = parseMp3FrameHeader(data, firstFrameOffset);
    if (firstFrame === undefined) return undefined;

    const xing = readMp3XingDuration(data, view, firstFrameOffset, firstFrame);
    if (xing !== undefined) return xing;

    const vbri = readMp3VbriDuration(data, view, firstFrameOffset, firstFrame);
    if (vbri !== undefined) return vbri;

    // 逐帧累计，作为没有 Xing/VBRI 信息的兜底
    let seconds = 0;
    let frames = 0;
    offset = firstFrameOffset;

    while (offset + 4 <= data.byteLength && frames < 10_000_000){
        const frame = parseMp3FrameHeader(data, offset);
        if (frame === undefined || frame.frameLength <= 0) break;

        const available = data.byteLength - offset;
        if (available < frame.frameLength){
            seconds += (available / frame.frameLength) * (frame.samplesPerFrame / frame.sampleRate);
            break;
        }

        seconds += frame.samplesPerFrame / frame.sampleRate;
        offset += frame.frameLength;
        frames += 1;
    }

    return seconds > 0 ? seconds : undefined;
}

function skipId3v2(data: Uint8Array): number{
    if (ascii(data, 0, 3) !== "ID3" || data.byteLength < 10) return 0;
    const size = ((data[6] & 0x7f) << 21)
        | ((data[7] & 0x7f) << 14)
        | ((data[8] & 0x7f) << 7)
        | (data[9] & 0x7f);
    return Math.min(data.byteLength, 10 + size);
}

function parseMp3FrameHeader(
    data: Uint8Array,
    offset: number,
): Mp3Frame | undefined{
    if (offset + 4 > data.byteLength) return undefined;
    if (data[offset] !== 0xff || (data[offset + 1] & 0xe0) !== 0xe0) return undefined;

    const versionBits = (data[offset + 1] >> 3) & 0x03;
    const layerBits = (data[offset + 1] >> 1) & 0x03;
    if (versionBits === 1 || layerBits === 0) return undefined;

    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
    const layer = 4 - layerBits;
    const bitrateIndex = (data[offset + 2] >> 4) & 0x0f;
    const sampleRateIndex = (data[offset + 2] >> 2) & 0x03;
    const padding = (data[offset + 2] >> 1) & 0x01;
    const channelMode = (data[offset + 3] >> 6) & 0x03;

    if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return undefined;

    const bitrateTable = version === 1 ? MP3_BITRATES_MPEG1 : MP3_BITRATES_MPEG2;
    const bitrate = bitrateTable[layer - 1]?.[bitrateIndex];
    const sampleRate = MP3_SAMPLE_RATES[versionBits]?.[sampleRateIndex];
    if (bitrate === undefined || bitrate <= 0 || sampleRate === undefined || sampleRate <= 0){
        return undefined;
    }

    const bitrateBps = bitrate * 1000;
    let frameLength: number;
    let samplesPerFrame: number;

    if (layer === 1){
        frameLength = Math.floor((12 * bitrateBps / sampleRate + padding) * 4);
        samplesPerFrame = 384;
    } else if (layer === 2){
        frameLength = Math.floor(144 * bitrateBps / sampleRate + padding);
        samplesPerFrame = 1152;
    } else {
        const coefficient = version === 1 ? 144 : 72;
        frameLength = Math.floor(coefficient * bitrateBps / sampleRate + padding);
        samplesPerFrame = version === 1 ? 1152 : 576;
    }

    if (frameLength <= 0 || offset + frameLength > data.byteLength) return undefined;

    const isMono = channelMode === 3;
    const hasCrc = (data[offset + 1] & 0x01) === 0;
    const sideInfoSize = layer === 3
        ? version === 1
            ? (isMono ? 17 : 32)
            : (isMono ? 9 : 17)
        : 0;

    return {
        frameLength,
        sampleRate,
        samplesPerFrame,
        sideInfoSize,
        hasCrc,
        isMono,
    };
}

function readMp3XingDuration(
    data: Uint8Array,
    view: DataView,
    frameOffset: number,
    frame: Mp3Frame,
): number | undefined{
    if (frame.sideInfoSize === 0) return undefined;

    const xingOffset = frameOffset + 4 + (frame.hasCrc ? 2 : 0) + frame.sideInfoSize;
    if (xingOffset + 12 > data.byteLength) return undefined;

    const tag = ascii(data, xingOffset, 4);
    if (tag !== "Xing" && tag !== "Info") return undefined;

    const flags = view.getUint32(xingOffset + 4);
    if ((flags & 0x0001) === 0) return undefined;

    const frames = view.getUint32(xingOffset + 8);
    if (frames <= 0) return undefined;
    return (frames * frame.samplesPerFrame) / frame.sampleRate;
}

function readMp3VbriDuration(
    data: Uint8Array,
    view: DataView,
    frameOffset: number,
    frame: Mp3Frame,
): number | undefined{
    const vbriOffset = frameOffset + 36;
    if (vbriOffset + 18 > data.byteLength) return undefined;
    if (ascii(data, vbriOffset, 4) !== "VBRI") return undefined;

    const frames = view.getUint32(vbriOffset + 14);
    if (frames <= 0) return undefined;
    return (frames * frame.samplesPerFrame) / frame.sampleRate;
}

/* ---------------------------------------------------------------------------
 * AAC / ADTS
 * ------------------------------------------------------------------------- */

const AAC_SAMPLE_RATES: readonly number[] = [
    96000, 88200, 64000, 48000, 44100, 32000,
    24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

function readAdtsDuration(data: Uint8Array): number | undefined{
    let offset = 0;
    let seconds = 0;
    let frames = 0;

    while (offset + 7 <= data.byteLength && frames < 10_000_000){
        if (data[offset] !== 0xff || (data[offset + 1] & 0xf6) !== 0xf0) break;

        const sampleRateIndex = (data[offset + 2] >> 2) & 0x0f;
        const sampleRate = AAC_SAMPLE_RATES[sampleRateIndex];
        if (sampleRate === undefined || sampleRate <= 0) break;

        const frameLength = ((data[offset + 3] & 0x03) << 11)
            | (data[offset + 4] << 3)
            | (data[offset + 5] >> 5);
        const headerLength = (data[offset + 1] & 0x01) === 1 ? 7 : 9;
        if (frameLength < headerLength) break;

        const blockCount = (data[offset + 6] & 0x03) + 1;
        const available = data.byteLength - offset;
        const effectiveLength = Math.min(frameLength, available);

        seconds += (effectiveLength / frameLength) * (1024 * blockCount) / sampleRate;
        if (available < frameLength) break;

        offset += frameLength;
        frames += 1;
    }

    return seconds > 0 ? seconds : undefined;
}

/* ---------------------------------------------------------------------------
 * AMR / AMR-WB（IF1 存储格式）
 * ------------------------------------------------------------------------- */

const AMR_NB_FRAME_SIZES: readonly number[] = [13, 14, 16, 18, 20, 21, 27, 32];
const AMR_WB_FRAME_SIZES: readonly number[] = [18, 24, 33, 37, 41, 47, 51, 59, 61];

function readAmrDuration(data: Uint8Array): number | undefined{
    const isWideband = ascii(data, 0, 9) === "#!AMR-WB\n";
    if (!isWideband && ascii(data, 0, 6) !== "#!AMR\n") return undefined;

    let offset = isWideband ? 9 : 6;
    let frames = 0;

    while (offset < data.byteLength && frames < 10_000_000){
        // AMR / AMR-WB IF1 使用相同的 1 字节帧头：P + FT(4) + Q + PP
        const mode = (data[offset] >> 3) & 0x0f;

        let frameSize: number | undefined;
        if (isWideband){
            if (mode <= 8) frameSize = AMR_WB_FRAME_SIZES[mode];
            else if (mode === 9) frameSize = 6;
            else if (mode === 15) frameSize = 1;
        } else {
            if (mode <= 7) frameSize = AMR_NB_FRAME_SIZES[mode];
            else if (mode === 8) frameSize = 6;
            else if (mode === 15) frameSize = 1;
        }

        if (frameSize === undefined || frameSize <= 0) break;
        if (offset + frameSize > data.byteLength) break;

        offset += frameSize;
        frames += 1;
    }

    return frames > 0 ? frames * 0.02 : undefined;
}

/* ---------------------------------------------------------------------------
 * ISO BMFF：MP4 / MOV / 3GP
 * ------------------------------------------------------------------------- */

type IsoBox = {
    type: string;
    payload: number;
    end: number;
};

const ISO_CONTAINER_TYPES = new Set([
    "moov", "trak", "mdia", "minf", "stbl", "mvex", "edts", "dinf",
]);

function readIsoBmffDuration(data: Uint8Array, view: DataView): number | undefined{
    let movieHeader: { timescale: number; duration: number } | undefined;
    let fragmentDuration: number | undefined;
    let best = 0;

    const walk = (start: number, end: number, depth: number): void => {
        if (depth > 8) return;

        for (const box of readIsoBoxes(data, view, start, end)){
            if (box.type === "mvhd"){
                const header = readIsoMediaHeader(view, box);
                if (header !== undefined){
                    movieHeader = header;
                    if (isUsableDuration(header.duration) && header.timescale > 0){
                        best = Math.max(best, header.duration / header.timescale);
                    }
                }
                continue;
            }

            if (box.type === "mdhd"){
                const header = readIsoMediaHeader(view, box);
                if (header !== undefined
                    && isUsableDuration(header.duration)
                    && header.timescale > 0){
                    best = Math.max(best, header.duration / header.timescale);
                }
                continue;
            }

            if (box.type === "mehd"){
                const duration = readIsoFragmentDuration(view, box);
                if (duration !== undefined) fragmentDuration = duration;
                continue;
            }

            if (ISO_CONTAINER_TYPES.has(box.type)){
                walk(box.payload, box.end, depth + 1);
            }
        }
    };

    walk(0, data.byteLength, 0);

    if (best <= 0
        && fragmentDuration !== undefined
        && movieHeader !== undefined
        && movieHeader.timescale > 0){
        best = fragmentDuration / movieHeader.timescale;
    }

    return best > 0 ? best : undefined;
}

function readIsoBoxes(
    data: Uint8Array,
    view: DataView,
    start: number,
    end: number,
): IsoBox[]{
    const boxes: IsoBox[] = [];
    let offset = start;

    while (offset + 8 <= end){
        const size32 = view.getUint32(offset);
        const type = ascii(data, offset + 4, 4);
        let headerSize = 8;
        let size = size32;

        if (size32 === 1){
            if (offset + 16 > end) break;
            size = toSafeNumber(view.getBigUint64(offset + 8));
            headerSize = 16;
        } else if (size32 === 0){
            size = end - offset;
        }

        if (!Number.isFinite(size) || size < headerSize) break;

        const boxEnd = Math.min(end, offset + size);
        boxes.push({ type, payload: offset + headerSize, end: boxEnd });
        offset += size;
    }

    return boxes;
}

function readIsoMediaHeader(
    view: DataView,
    box: IsoBox,
): { timescale: number; duration: number } | undefined{
    if (box.payload + 1 > box.end) return undefined;

    const version = view.getUint8(box.payload);
    if (version === 0){
        if (box.payload + 20 > box.end) return undefined;
        return {
            timescale: view.getUint32(box.payload + 12),
            duration: view.getUint32(box.payload + 16),
        };
    }

    if (version === 1){
        if (box.payload + 32 > box.end) return undefined;
        return {
            timescale: view.getUint32(box.payload + 20),
            duration: toSafeNumber(view.getBigUint64(box.payload + 24)),
        };
    }

    return undefined;
}

function readIsoFragmentDuration(
    view: DataView,
    box: IsoBox,
): number | undefined{
    if (box.payload + 4 > box.end) return undefined;

    const version = view.getUint8(box.payload);
    if (version === 0){
        if (box.payload + 8 > box.end) return undefined;
        return view.getUint32(box.payload + 4);
    }
    if (version === 1){
        if (box.payload + 12 > box.end) return undefined;
        return toSafeNumber(view.getBigUint64(box.payload + 4));
    }

    return undefined;
}

function isUsableDuration(value: number): boolean{
    return Number.isFinite(value) && value > 0 && value < 1e15;
}

/* ---------------------------------------------------------------------------
 * Matroska / WebM
 * ------------------------------------------------------------------------- */

const EBML_HEADER_ID = 0x1a45dfa3;
const EBML_SEGMENT_ID = 0x18538067;
const EBML_INFO_ID = 0x1549a966;
const EBML_TIMECODE_SCALE_ID = 0x2ad7b1;
const EBML_DURATION_ID = 0x4489;

type EbmlElement = {
    id: number;
    payload: number;
    end: number;
};

function readMatroskaDuration(data: Uint8Array, view: DataView): number | undefined{
    const header = readEbmlElement(data, 0, data.byteLength);
    if (header === undefined || header.id !== EBML_HEADER_ID) return undefined;

    let offset = header.end;
    while (offset < data.byteLength){
        const element = readEbmlElement(data, offset, data.byteLength);
        if (element === undefined) return undefined;

        if (element.id === EBML_SEGMENT_ID){
            return readMatroskaSegment(data, view, element.payload, element.end);
        }
        offset = element.end;
    }

    return undefined;
}

function readMatroskaSegment(
    data: Uint8Array,
    view: DataView,
    start: number,
    end: number,
): number | undefined{
    let offset = start;

    while (offset < end){
        const element = readEbmlElement(data, offset, end);
        if (element === undefined) return undefined;

        if (element.id === EBML_INFO_ID){
            let timecodeScale = 1_000_000;
            let duration: number | undefined;
            let cursor = element.payload;

            while (cursor < element.end){
                const child = readEbmlElement(data, cursor, element.end);
                if (child === undefined) break;

                if (child.id === EBML_TIMECODE_SCALE_ID){
                    timecodeScale = readEbmlUint(data, child.payload, child.end) ?? timecodeScale;
                } else if (child.id === EBML_DURATION_ID){
                    duration = readEbmlFloat(view, child.payload, child.end);
                }

                cursor = child.end;
            }

            if (duration !== undefined && timecodeScale > 0){
                return (duration * timecodeScale) / 1_000_000_000;
            }
            return undefined;
        }

        offset = element.end;
    }

    return undefined;
}

function readEbmlElement(
    data: Uint8Array,
    offset: number,
    limit: number,
): EbmlElement | undefined{
    const id = readEbmlId(data, offset);
    if (id === undefined) return undefined;

    const sizeOffset = offset + id.length;
    const size = readEbmlVint(data, sizeOffset, 8);
    if (size === undefined) return undefined;

    const payload = sizeOffset + size.length;
    if (payload > limit) return undefined;

    if (size.unknown){
        return { id: id.value, payload, end: limit };
    }

    const end = payload + size.value;
    if (end > limit) return undefined;
    return { id: id.value, payload, end };
}

/** EBML ID 的 marker bit 属于 ID 值本身，不能像 size 那样剥离 */
function readEbmlId(
    data: Uint8Array,
    offset: number,
): { value: number; length: number } | undefined{
    if (offset >= data.byteLength) return undefined;

    const first = data[offset];
    if (first === 0) return undefined;

    let length = 1;
    let marker = 0x80;
    while (length <= 4 && (first & marker) === 0){
        marker >>= 1;
        length += 1;
    }
    if (length > 4 || length > data.byteLength - offset) return undefined;

    let value = first;
    for (let index = 1; index < length; index += 1){
        value = value * 256 + data[offset + index];
    }
    return { value, length };
}

function readEbmlVint(
    data: Uint8Array,
    offset: number,
    maxLength: number,
): { value: number; length: number; unknown: boolean } | undefined{
    if (offset >= data.byteLength) return undefined;

    const first = data[offset];
    if (first === 0) return undefined;

    let length = 1;
    let marker = 0x80;
    while (length <= maxLength && (first & marker) === 0){
        marker >>= 1;
        length += 1;
    }
    if (length > maxLength || length > data.byteLength - offset) return undefined;

    let value = first & (marker - 1);
    let allOnes = value === marker - 1;

    for (let index = 1; index < length; index += 1){
        const byte = data[offset + index];
        value = value * 256 + byte;
        if (byte !== 0xff) allOnes = false;
    }

    return { value, length, unknown: allOnes };
}

function readEbmlUint(data: Uint8Array, start: number, end: number): number | undefined{
    if (end <= start || end - start > 8) return undefined;

    let value = 0;
    for (let offset = start; offset < end; offset += 1){
        value = value * 256 + data[offset];
    }
    return value;
}

function readEbmlFloat(
    view: DataView,
    start: number,
    end: number,
): number | undefined{
    const size = end - start;
    if (size === 4) return view.getFloat32(start);
    if (size === 8) return view.getFloat64(start);
    return undefined;
}

/* ---------------------------------------------------------------------------
 * FLV（AMF0 onMetaData）
 * ------------------------------------------------------------------------- */

type AmfValue = number | string | boolean | null | AmfValue[] | { [key: string]: AmfValue };

function readFlvDuration(data: Uint8Array, view: DataView): number | undefined{
    if (ascii(data, 0, 3) !== "FLV" || data.byteLength < 9) return undefined;

    const headerSize = view.getUint32(5);
    if (headerSize < 9) return undefined;

    let offset = headerSize;
    let maxTimestamp = 0;
    let metadataDuration: number | undefined;

    while (offset + 11 <= data.byteLength){
        const tagType = data[offset];
        const dataSize = (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
        const timestamp = (((data[offset + 7] << 24)
            | (data[offset + 4] << 16)
            | (data[offset + 5] << 8)
            | data[offset + 6]) >>> 0);
        const payload = offset + 11;
        const payloadEnd = payload + dataSize;
        if (payloadEnd > data.byteLength) break;

        if (tagType === 18){
            metadataDuration = readFlvMetadataDuration(data, view, payload, payloadEnd)
                ?? metadataDuration;
        } else if (tagType === 8 || tagType === 9){
            maxTimestamp = Math.max(maxTimestamp, timestamp);
        }

        offset = payloadEnd + 4;
    }

    if (metadataDuration !== undefined && Number.isFinite(metadataDuration) && metadataDuration > 0){
        return metadataDuration;
    }
    return maxTimestamp > 0 ? maxTimestamp / 1000 : undefined;
}

function readFlvMetadataDuration(
    data: Uint8Array,
    view: DataView,
    start: number,
    end: number,
): number | undefined{
    let offset = start;
    const first = readAmf0Value(data, view, offset, end);
    if (first === undefined) return undefined;

    offset = first.offset;
    if (typeof first.value === "string" && first.value !== "onMetaData") return undefined;

    const second = readAmf0Value(data, view, offset, end);
    if (second === undefined) return undefined;
    return findAmfDuration(second.value);
}

function findAmfDuration(value: AmfValue, depth = 0): number | undefined{
    if (depth > 8 || value === null || typeof value !== "object") return undefined;
    if (Array.isArray(value)){
        for (const item of value){
            const found = findAmfDuration(item, depth + 1);
            if (found !== undefined) return found;
        }
        return undefined;
    }

    const duration = value.duration;
    if (typeof duration === "number" && Number.isFinite(duration)) return duration;

    for (const item of Object.values(value)){
        const found = findAmfDuration(item, depth + 1);
        if (found !== undefined) return found;
    }
    return undefined;
}

function readAmf0Value(
    data: Uint8Array,
    view: DataView,
    offset: number,
    end: number,
    depth = 0,
): { value: AmfValue; offset: number } | undefined{
    if (depth > 8 || offset >= end) return undefined;

    const type = data[offset];
    offset += 1;

    switch (type){
        case 0x00: { // number
            if (offset + 8 > end) return undefined;
            return { value: view.getFloat64(offset), offset: offset + 8 };
        }

        case 0x01: { // boolean
            if (offset + 1 > end) return undefined;
            return { value: data[offset] !== 0, offset: offset + 1 };
        }

        case 0x02: { // string
            const result = readAmf0String(data, view, offset, end);
            return result === undefined ? undefined : { value: result.value, offset: result.offset };
        }

        case 0x03: { // object
            return readAmf0Properties(data, view, offset, end, depth);
        }

        case 0x05: // null
        case 0x06: // undefined
            return { value: null, offset };

        case 0x08: { // ECMA array
            if (offset + 4 > end) return undefined;
            return readAmf0Properties(data, view, offset + 4, end, depth);
        }

        case 0x0a: { // strict array
            if (offset + 4 > end) return undefined;
            const count = view.getUint32(offset);
            offset += 4;
            const values: AmfValue[] = [];
            for (let index = 0; index < count; index += 1){
                const item = readAmf0Value(data, view, offset, end, depth + 1);
                if (item === undefined) return undefined;
                values.push(item.value);
                offset = item.offset;
            }
            return { value: values, offset };
        }

        case 0x0b: { // date
            if (offset + 10 > end) return undefined;
            return { value: view.getFloat64(offset), offset: offset + 10 };
        }

        case 0x0c: { // long string
            if (offset + 4 > end) return undefined;
            const length = view.getUint32(offset);
            offset += 4;
            if (offset + length > end) return undefined;
            return { value: decodeUtf8(data, offset, offset + length), offset: offset + length };
        }

        case 0x10: { // typed object
            const className = readAmf0String(data, view, offset, end);
            if (className === undefined) return undefined;
            return readAmf0Properties(data, view, className.offset, end, depth);
        }

        default:
            return undefined;
    }
}

function readAmf0String(
    data: Uint8Array,
    view: DataView,
    offset: number,
    end: number,
): { value: string; offset: number } | undefined{
    if (offset + 2 > end) return undefined;
    const length = view.getUint16(offset);
    const start = offset + 2;
    if (start + length > end) return undefined;
    return { value: decodeUtf8(data, start, start + length), offset: start + length };
}

function readAmf0Properties(
    data: Uint8Array,
    view: DataView,
    offset: number,
    end: number,
    depth: number,
): { value: AmfValue; offset: number } | undefined{
    const record: { [key: string]: AmfValue } = {};

    while (offset + 3 <= end){
        const keyLength = view.getUint16(offset);
        offset += 2;

        if (keyLength === 0){
            const marker = data[offset];
            offset += 1;
            if (marker === 0x09) return { value: record, offset };
            return undefined;
        }

        if (offset + keyLength > end) return undefined;
        const key = decodeUtf8(data, offset, offset + keyLength);
        offset += keyLength;

        const value = readAmf0Value(data, view, offset, end, depth + 1);
        if (value === undefined) return undefined;

        record[key] = value.value;
        offset = value.offset;
    }

    return undefined;
}

function decodeUtf8(data: Uint8Array, start: number, end: number): string{
    return new TextDecoder().decode(data.subarray(start, end));
}

/* ---------------------------------------------------------------------------
 * ASF / WMV
 * ------------------------------------------------------------------------- */

const ASF_HEADER_GUID = [
    0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11,
    0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c,
] as const;

const ASF_FILE_PROPERTIES_GUID = [
    0xa1, 0xdc, 0xab, 0x8c, 0x47, 0xa9, 0xcf, 0x11,
    0x8e, 0xe4, 0x00, 0xc0, 0x0c, 0x20, 0x53, 0x65,
] as const;

function readAsfDuration(data: Uint8Array, view: DataView): number | undefined{
    if (!matches(data, 0, ASF_HEADER_GUID) || data.byteLength < 24) return undefined;

    const headerSize = toSafeNumber(view.getBigUint64(16, true));
    if (!Number.isFinite(headerSize) || headerSize < 24) return undefined;

    const limit = Math.min(data.byteLength, headerSize);
    let offset = 24;

    while (offset + 24 <= limit){
        const size = toSafeNumber(view.getBigUint64(offset + 16, true));
        if (!Number.isFinite(size) || size < 24 || offset + size > limit) break;

        if (matches(data, offset, ASF_FILE_PROPERTIES_GUID)){
            const payload = offset + 24;
            if (payload + 80 <= offset + size){
                const playDuration = toSafeNumber(view.getBigUint64(payload + 40, true));
                const preroll = toSafeNumber(view.getBigUint64(payload + 56, true));
                if (Number.isFinite(playDuration) && playDuration > 0){
                    const seconds = playDuration / 10_000_000 - preroll / 1000;
                    return seconds > 0 ? seconds : undefined;
                }
            }
        }

        offset += size;
    }

    return undefined;
}

/* ---------------------------------------------------------------------------
 * 通用辅助
 * ------------------------------------------------------------------------- */

function ascii(data: Uint8Array, offset: number, length: number): string{
    if (offset < 0 || offset + length > data.byteLength) return "";

    let text = "";
    for (let index = 0; index < length; index += 1){
        text += String.fromCharCode(data[offset + index]);
    }
    return text;
}

function matches(data: Uint8Array, offset: number, pattern: readonly number[]): boolean{
    if (offset + pattern.length > data.byteLength) return false;

    for (let index = 0; index < pattern.length; index += 1){
        if (data[offset + index] !== pattern[index]) return false;
    }
    return true;
}

function normalizeMimeType(mimeType: string | undefined): string | undefined{
    if (mimeType === undefined) return undefined;
    const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
    return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function toSafeNumber(value: bigint): number{
    const number = Number(value);
    return Number.isFinite(number) && number <= Number.MAX_SAFE_INTEGER ? number : Number.POSITIVE_INFINITY;
}
