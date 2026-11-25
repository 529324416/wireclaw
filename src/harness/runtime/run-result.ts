import { collectAttachmentHashes } from "../../session/attachment";
import { SessionSerializer } from "../../session/serialize";
import type {
    AttachmentRef,
    ChatUsage,
    SessionData,
} from "../../session/type";
import { HarnessError, HarnessErrorCode } from "../base/error";
import { cloneJson, isRecord } from "../base/utils";
import type { GraphRunStatus } from "../graph/event";
import { isHarnessValue } from "../graph/type";
import type {
    GraphRunInput,
    GraphRunResult,
    RunResult,
    RunResultEntry,
    RunResultEntryDraft,
    RunResultModelCallEntry,
    RunResultSessionEntry,
} from "./types";

const RUN_RESULT_VERSION = 1;
const RUN_RESULT_STATUSES: readonly GraphRunStatus[] = [
    "running",
    "completed",
    "failed",
    "cancelled",
    "paused",
];
const ENTRY_STATUSES: readonly RunResultEntry["status"][] = ["completed", "failed"];

/**
 * 一次运行期间的条目采集器。
 *
 * 顶层 GraphRun 自行创建；Subgraph / Loop / ForEach 把同一个采集器传给内层图，
 * 内层节点通过 NodeContext.collect 提交草稿，由采集器统一补齐 id / nodeId / graphPath。
 */
export class RunResultCollector{

    private readonly _entries: RunResultEntry[] = [];
    private _sequence = 0;

    get size(): number{
        return this._entries.length;
    }

    add(
        node: { id: string; type: string },
        graphPath: readonly string[],
        draft: RunResultEntryDraft,
    ): void{
        this._sequence += 1;
        const base = {
            id: `entry-${String(this._sequence)}`,
            nodeId: node.id,
            nodeType: node.type,
            ...(graphPath.length === 0 ? {} : { graphPath: [...graphPath] }),
        };

        // 草稿已带判别字段（kind），补齐运行期字段后即为完整 entry。
        this._entries.push({ ...draft, ...base } as RunResultEntry);
    }

    snapshot(): RunResultEntry[]{
        return this._entries.map((entry) => cloneJson(entry));
    }
}

/** 把一次运行结果聚合为版本化 RunResult 文档；input 由宿主显式传入。 */
export function createRunResult(
    result: GraphRunResult,
    input?: GraphRunInput,
): RunResult{
    return {
        version: RUN_RESULT_VERSION,
        runId: result.runId,
        graphId: result.graphId,
        status: result.status,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        ...(input === undefined ? {} : { input: cloneJson(input) }),
        outputs: cloneJson(result.outputs),
        entries: result.entries.map((entry) => cloneJson(entry)),
        ...(result.error === undefined ? {} : { error: errorText(result.error) }),
    };
}

/** RunResult 的 JSON 校验 / 序列化。 */
export class RunResultSerializer{

    /** 校验并返回深拷贝；非法输入抛 HarnessError(deserialization_failed)。 */
    static serialize(result: RunResult): RunResult{
        return parseRunResult(cloneJson(result), "runResult");
    }

    /** 校验并规范化一个未信任的 JSON 值。 */
    static deserialize(value: unknown): RunResult{
        return parseRunResult(value, "runResult");
    }

    static isRunResult(value: unknown): value is RunResult{
        try{
            parseRunResult(value, "runResult");
            return true;
        }catch{
            return false;
        }
    }
}

/** RunResult 引用的全部附件内容指纹（去重）。 */
export function collectRunResultAttachmentHashes(result: RunResult): string[]{
    const hashes = new Set<string>();

    for (const entry of result.entries){
        if (entry.kind === "model-call"){
            for (const ref of entry.input.attachments ?? []){
                hashes.add(ref.contentHash);
            }
            for (const ref of entry.output?.attachments ?? []){
                hashes.add(ref.contentHash);
            }
            continue;
        }

        const messages = SessionSerializer.deserialize(entry.session).messages;
        for (const hash of collectAttachmentHashes(messages)){
            hashes.add(hash);
        }
    }

    return [...hashes];
}

function parseRunResult(value: unknown, field: string): RunResult{
    const record = asRecord(value, field);
    const version = asInteger(record.version, `${field}.version`);
    if (version !== RUN_RESULT_VERSION){
        throw invalid(`${field}.version must be ${String(RUN_RESULT_VERSION)}`);
    }

    const runId = asString(record.runId, `${field}.runId`);
    const graphId = asString(record.graphId, `${field}.graphId`);
    const status = asEnum(record.status, RUN_RESULT_STATUSES, `${field}.status`);
    const startedAt = asTimestamp(record.startedAt, `${field}.startedAt`);
    const endedAt = asTimestamp(record.endedAt, `${field}.endedAt`);
    if (endedAt < startedAt){
        throw invalid(`${field}.endedAt must not be earlier than startedAt`);
    }

    const outputs = asOutputValues(record.outputs, `${field}.outputs`);
    const entries = asEntries(record.entries, `${field}.entries`);
    const input = record.input === undefined
        ? undefined
        : asRunInput(record.input, `${field}.input`);
    const error = asOptionalString(record.error, `${field}.error`);

    return {
        version: RUN_RESULT_VERSION,
        runId,
        graphId,
        status,
        startedAt,
        endedAt,
        ...(input === undefined ? {} : { input }),
        outputs,
        entries,
        ...(error === undefined ? {} : { error }),
    };
}

function asEntries(value: unknown, field: string): RunResultEntry[]{
    if (!Array.isArray(value)){
        throw invalid(`${field} must be an array`);
    }
    return value.map((entry, index) => asEntry(entry, `${field}[${String(index)}]`));
}

function asEntry(value: unknown, field: string): RunResultEntry{
    const record = asRecord(value, field);
    const kind = record.kind;
    if (kind === "model-call"){
        return asModelCallEntry(record, field);
    }
    if (kind === "session"){
        return asSessionEntry(record, field);
    }
    throw invalid(`${field}.kind must be "model-call" or "session"`);
}

function asEntryBase(
    record: Record<string, unknown>,
    field: string,
): Pick<RunResultModelCallEntry, "id" | "nodeId" | "nodeType" | "status" | "startedAt" | "endedAt"> & {
    graphPath?: string[];
    error?: string;
}{
    const startedAt = asTimestamp(record.startedAt, `${field}.startedAt`);
    const endedAt = asTimestamp(record.endedAt, `${field}.endedAt`);
    if (endedAt < startedAt){
        throw invalid(`${field}.endedAt must not be earlier than startedAt`);
    }

    const graphPath = record.graphPath === undefined
        ? undefined
        : asStringArray(record.graphPath, `${field}.graphPath`);
    const error = asOptionalString(record.error, `${field}.error`);

    return {
        id: asString(record.id, `${field}.id`),
        nodeId: asString(record.nodeId, `${field}.nodeId`),
        nodeType: asString(record.nodeType, `${field}.nodeType`),
        status: asEnum(record.status, ENTRY_STATUSES, `${field}.status`),
        startedAt,
        endedAt,
        ...(graphPath === undefined ? {} : { graphPath }),
        ...(error === undefined ? {} : { error }),
    };
}

function asModelCallEntry(
    record: Record<string, unknown>,
    field: string,
): RunResultModelCallEntry{
    const base = asEntryBase(record, field);
    const mode = asEnum(record.mode, ["chat", "generate"] as const, `${field}.mode`);
    const input = asModelCallInput(record.input, `${field}.input`);
    const output = record.output === undefined
        ? undefined
        : asModelCallOutput(record.output, `${field}.output`);

    return {
        kind: "model-call",
        ...base,
        providerId: asString(record.providerId, `${field}.providerId`),
        modelId: asString(record.modelId, `${field}.modelId`),
        mode,
        input,
        ...(output === undefined ? {} : { output }),
    };
}

function asSessionEntry(
    record: Record<string, unknown>,
    field: string,
): RunResultSessionEntry{
    const base = asEntryBase(record, field);
    const session = normalizeSession(record.session, `${field}.session`);

    return {
        kind: "session",
        ...base,
        providerId: asString(record.providerId, `${field}.providerId`),
        modelId: asString(record.modelId, `${field}.modelId`),
        session,
    };
}

function asModelCallInput(
    value: unknown,
    field: string,
): RunResultModelCallEntry["input"]{
    const record = asRecord(value, field);
    const prompt = asString(record.prompt, `${field}.prompt`);
    const system = asOptionalString(record.system, `${field}.system`);
    const attachments = record.attachments === undefined
        ? undefined
        : asAttachmentRefs(record.attachments, `${field}.attachments`);

    return {
        prompt,
        ...(system === undefined ? {} : { system }),
        ...(attachments === undefined ? {} : { attachments }),
    };
}

function asModelCallOutput(
    value: unknown,
    field: string,
): NonNullable<RunResultModelCallEntry["output"]>{
    const record = asRecord(value, field);
    const output: NonNullable<RunResultModelCallEntry["output"]> = {
        text: asString(record.text, `${field}.text`),
    };

    const thinking = asOptionalString(record.thinking, `${field}.thinking`);
    if (thinking !== undefined) output.thinking = thinking;

    if (record.attachments !== undefined){
        output.attachments = asAttachmentRefs(
            record.attachments,
            `${field}.attachments`,
        );
    }

    if (record.usage !== undefined){
        output.usage = asUsage(record.usage, `${field}.usage`);
    }

    const stopReason = asOptionalString(record.stopReason, `${field}.stopReason`);
    if (stopReason !== undefined) output.stopReason = stopReason;

    const failureReason = asOptionalString(
        record.failureReason,
        `${field}.failureReason`,
    );
    if (failureReason !== undefined) output.failureReason = failureReason;

    return output;
}

function asRunInput(value: unknown, field: string): GraphRunInput{
    const record = asRecord(value, field);
    const input: GraphRunInput = {};

    if (record.text !== undefined){
        input.text = asString(record.text, `${field}.text`);
    }

    if (record.attachments !== undefined){
        input.attachments = asAttachmentRefs(
            record.attachments,
            `${field}.attachments`,
        );
    }

    if (record.values !== undefined){
        const values = asRecord(record.values, `${field}.values`);
        const normalized: Record<string, ReturnType<typeof asHarnessValue>> = {};
        for (const [key, item] of Object.entries(values)){
            normalized[key] = asHarnessValue(item, `${field}.values.${key}`);
        }
        input.values = normalized;
    }

    return input;
}

function asOutputValues(
    value: unknown,
    field: string,
): RunResult["outputs"]{
    const record = asRecord(value, field);
    const outputs: Record<string, ReturnType<typeof asHarnessValue>> = {};

    for (const [key, item] of Object.entries(record)){
        outputs[key] = asHarnessValue(item, `${field}.${key}`);
    }

    return outputs;
}

function asHarnessValue(
    value: unknown,
    field: string,
): NonNullable<RunResult["outputs"][string]>{
    if (!isHarnessValue(value)){
        throw invalid(`${field} is not a valid HarnessValue`);
    }
    return cloneJson(value);
}

function asAttachmentRefs(value: unknown, field: string): AttachmentRef[]{
    if (!Array.isArray(value)){
        throw invalid(`${field} must be an array`);
    }
    return value.map((item, index) => ({
        contentHash: asString(
            asRecord(item, `${field}[${String(index)}]`).contentHash,
            `${field}[${String(index)}].contentHash`,
        ),
    }));
}

function asUsage(value: unknown, field: string): ChatUsage{
    const record = asRecord(value, field);
    return {
        promptTokens: asNonNegativeNumber(record.promptTokens, `${field}.promptTokens`),
        completionTokens: asNonNegativeNumber(
            record.completionTokens,
            `${field}.completionTokens`,
        ),
        totalTokens: asNonNegativeNumber(record.totalTokens, `${field}.totalTokens`),
    };
}

function normalizeSession(value: unknown, field: string): SessionData{
    try{
        return SessionSerializer.serialize(SessionSerializer.deserialize(value));
    }catch(error){
        throw invalid(
            `${field} is not valid SessionData: ${errorText(error)}`,
            error,
        );
    }
}

function asRecord(value: unknown, field: string): Record<string, unknown>{
    if (!isRecord(value)){
        throw invalid(`${field} must be an object`);
    }
    return value;
}

function asString(value: unknown, field: string): string{
    if (typeof value !== "string"){
        throw invalid(`${field} must be a string`);
    }
    return value;
}

function asOptionalString(value: unknown, field: string): string | undefined{
    if (value === undefined) return undefined;
    return asString(value, field);
}

function asInteger(value: unknown, field: string): number{
    if (typeof value !== "number" || !Number.isInteger(value)){
        throw invalid(`${field} must be an integer`);
    }
    return value;
}

function asNonNegativeNumber(value: unknown, field: string): number{
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0){
        throw invalid(`${field} must be a non-negative number`);
    }
    return value;
}

function asTimestamp(value: unknown, field: string): number{
    return asNonNegativeNumber(value, field);
}

function asStringArray(value: unknown, field: string): string[]{
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")){
        throw invalid(`${field} must be an array of strings`);
    }
    return [...value] as string[];
}

function asEnum<T extends string>(
    value: unknown,
    allowed: readonly T[],
    field: string,
): T{
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)){
        throw invalid(`${field} must be one of ${allowed.join(", ")}`);
    }
    return value as T;
}

function invalid(message: string, origin?: unknown): HarnessError{
    return new HarnessError(
        HarnessErrorCode.DeserializationFailed,
        `Invalid RunResult: ${message}`,
        origin === undefined ? {} : { origin },
    );
}

function errorText(error: unknown): string{
    return error instanceof Error ? error.message : String(error);
}
