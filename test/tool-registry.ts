import assert from "node:assert/strict";

import { ToolError, ToolErrorType } from "../src/session/error";
import {
    composeToolName,
    parseToolName,
    ToolRegistry,
    validateToolParams,
} from "../src/session/tool";
import type { ToolProvider } from "../src/session/tool";
import type { ToolCall, ToolCallResult, ToolDefinition, ToolParamSchema } from "../src/session/type";

/* ---------------------------------------------------------------------------
 * 工具库
 * ------------------------------------------------------------------------- */

const readSchema: ToolParamSchema = {
    type: "object",
    properties: {
        path: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"] },
    },
    required: ["path"],
};

function definition(name: string, inputSchema: ToolParamSchema = readSchema): ToolDefinition {
    return { name, description: name, inputSchema };
}

function ok(content: string): ToolCallResult {
    return { content, status: { isSuccess: true, duration: 0 } };
}

type FakeOptions = {
    tools?: ToolDefinition[];
    fail?: boolean;
    fetchCount?: { value: number };
    onCall?: (call: ToolCall, options?: { signal?: AbortSignal }) => Promise<ToolCallResult> | ToolCallResult;
};

function fakeProvider(id: string, options: FakeOptions = {}): ToolProvider {
    return {
        id,
        name: id,
        description: id,
        async fetchTools() {
            if (options.fetchCount !== undefined) options.fetchCount.value += 1;
            if (options.fail === true) throw new ToolError(ToolErrorType.NetworkError, true, `${id} offline`);
            return options.tools ?? [];
        },
        async call(call, callOptions) {
            if (options.onCall !== undefined) return await options.onCall(call, callOptions);
            return ok(`called ${id}__${call.name}`);
        },
    };
}

function section(title: string): void {
    console.log(`\n=== ${title} ===`);
}

/* ---------------------------------------------------------------------------
 * 1. 命名规则：<provider_id>__<tool_id>
 * ------------------------------------------------------------------------- */
section("命名");

assert.equal(composeToolName("obsidian", "read"), "obsidian__read");
assert.deepEqual(parseToolName("obsidian__read"), { providerId: "obsidian", toolId: "read" });
assert.deepEqual(parseToolName("obsidian__a__b"), { providerId: "obsidian", toolId: "a__b" });
assert.equal(parseToolName("obsidian"), null);
assert.equal(parseToolName(""), null);
assert.equal(parseToolName("__read"), null);
assert.equal(parseToolName("obsidian__"), null);
assert.equal(parseToolName("obsidian.read"), null, "旧的点号命名必须被拒绝");
console.log("PASS 分隔符 __、首段切分、非法名拒绝");

/* ---------------------------------------------------------------------------
 * 2. 列出工具：拼装名称、填充 source、缓存、并发合并、只读副本
 * ------------------------------------------------------------------------- */
section("listTools");

const fetchA = { value: 0 };
const fetchB = { value: 0 };
const registry = new ToolRegistry();

assert.equal(
    registry.registerProvider(fakeProvider("obsidian", { tools: [definition("read")], fetchCount: fetchA })),
    true,
);
assert.equal(
    registry.registerProvider(fakeProvider("unity", { tools: [definition("createGameObject")], fetchCount: fetchB })),
    true,
);

const first = await registry.listTools();
assert.deepEqual(first.map((tool) => tool.name), ["obsidian__read", "unity__createGameObject"]);
assert.equal(first[0].source.providerId, "obsidian");
assert.equal(first[1].source.providerId, "unity");
assert.equal(fetchA.value, 1);
assert.equal(fetchB.value, 1);

const second = await registry.listTools();
assert.equal(fetchA.value, 1, "第二次 listTools 必须命中缓存");
assert.equal(second.length, 2);

second[0].name = "hacked";
assert.equal((await registry.listTools())[0].name, "obsidian__read", "返回值被修改不得污染缓存");

const dedupe = { value: 0 };
const concurrent = new ToolRegistry();
concurrent.registerProvider(fakeProvider("p", { tools: [definition("read")], fetchCount: dedupe }));
await Promise.all([concurrent.listTools(), concurrent.listTools(), concurrent.listTools()]);
assert.equal(dedupe.value, 1, "并发 listTools 必须合并为一次拉取");
console.log("PASS 拼装/source/缓存/并发/副本");

/* ---------------------------------------------------------------------------
 * 3. 失败隔离与缓存失效
 * ------------------------------------------------------------------------- */
section("失败隔离");

const errors: Array<[string, unknown]> = [];
const faultTolerant = new ToolRegistry({
    onProviderError: (providerId, error) => errors.push([providerId, error]),
});
faultTolerant.registerProvider(fakeProvider("good", { tools: [definition("read")] }));
faultTolerant.registerProvider(fakeProvider("dead", { fail: true }));

assert.deepEqual((await faultTolerant.listTools()).map((tool) => tool.name), ["good__read"]);
assert.equal(errors.length, 1);
assert.equal(errors[0][0], "dead");

const retryCount = { value: 0 };
const allDead = new ToolRegistry();
allDead.registerProvider(fakeProvider("dead", { fail: true, fetchCount: retryCount }));
assert.deepEqual(await allDead.listTools(), []);
assert.deepEqual(await allDead.listTools(), []);
assert.equal(retryCount.value, 2, "全部 Provider 失败时不得缓存空结果");

const refetch = { value: 0 };
const invalidating = new ToolRegistry();
invalidating.registerProvider(fakeProvider("a", { tools: [definition("read")], fetchCount: refetch }));
await invalidating.listTools();
assert.equal(refetch.value, 1);
invalidating.registerProvider(fakeProvider("b", { tools: [] }));
await invalidating.listTools();
assert.equal(refetch.value, 2, "注册新 Provider 必须让缓存失效");
assert.equal(invalidating.unregisterProvider("b"), true);
assert.equal(invalidating.unregisterProvider("b"), false);
console.log("PASS 单点失败隔离 / 全失败不缓存 / 注册注销失效");

/* ---------------------------------------------------------------------------
 * 4. Provider 返回非法定义时被剔除
 * ------------------------------------------------------------------------- */
section("非法定义");

const invalidErrors: Array<[string, unknown]> = [];
const invalid = new ToolRegistry({ onProviderError: (id, error) => invalidErrors.push([id, error]) });
invalid.registerProvider(fakeProvider("p", {
    tools: [
        definition("bad.name"),
        definition("bad__tool"),
        definition("good"),
        definition("good"),
    ],
}));

assert.deepEqual((await invalid.listTools()).map((tool) => tool.name), ["p__good"]);
assert.equal(invalidErrors.length, 3, "点号名 / 含分隔符名 / 重复名 都应被上报");
console.log("PASS 非法工具名与重复工具名被剔除并上报");

/* ---------------------------------------------------------------------------
 * 5. 注册校验
 * ------------------------------------------------------------------------- */
section("registerProvider");

const guarded = new ToolRegistry();
assert.equal(guarded.registerProvider(fakeProvider("obsidian")), true);
assert.equal(guarded.registerProvider(fakeProvider("obsidian")), false, "重复注册返回 false");
assert.equal(guarded.registerProvider(fakeProvider("obsidian"), true), true, "force 覆盖");
assert.throws(() => guarded.registerProvider(fakeProvider("bad.id")), /Invalid tool provider id/);
assert.throws(() => guarded.registerProvider(fakeProvider("a__b")), /Invalid tool provider id/);
assert.throws(() => guarded.registerProvider(fakeProvider("")), /Invalid tool provider id/);
console.log("PASS 重复注册 / force / 非法 ID");

/* ---------------------------------------------------------------------------
 * 6. 调用：裸名下发、成功结果、耗时
 * ------------------------------------------------------------------------- */
section("invoke 成功");

const seenCalls: ToolCall[] = [];
const callable = new ToolRegistry();
callable.registerProvider(fakeProvider("obsidian", {
    tools: [definition("read")],
    onCall: (call) => {
        seenCalls.push(call);
        return ok("file body");
    },
}));

const success = await callable.invoke({ id: "call-1", name: "obsidian__read", params: { path: "a.md" } });
assert.equal(success.status.isSuccess, true);
assert.equal(success.content, "file body");
assert.equal(seenCalls[0].name, "read", "Provider 只能看到裸工具名");
assert.equal(seenCalls[0].id, "call-1");
assert.ok(success.status.duration >= 0);
console.log("PASS Provider 收到裸名、结果透传、耗时已填");

/* ---------------------------------------------------------------------------
 * 7. 调用失败：未知 Provider / 非法名称 / 参数校验
 * ------------------------------------------------------------------------- */
section("invoke 失败即结果");

const unknown = await callable.invoke({ id: "call-2", name: "nope__read", params: {} });
assert.equal(unknown.status.isSuccess, false);
assert.equal(unknown.status.error?.type, ToolErrorType.NotFound);
assert.equal(typeof unknown.content, "string");

const legacy = await callable.invoke({ id: "call-3", name: "obsidian.read", params: {} });
assert.equal(legacy.status.error?.type, ToolErrorType.NotFound);

let invokedOnInvalid = 0;
const validating = new ToolRegistry();
validating.registerProvider(fakeProvider("obsidian", {
    tools: [definition("read")],
    onCall: () => {
        invokedOnInvalid += 1;
        return ok("should not happen");
    },
}));

const missing = await validating.invoke({ id: "call-4", name: "obsidian__read", params: {} });
assert.equal(missing.status.error?.type, ToolErrorType.InvalidParams);
assert.match(String(missing.content), /params\.path: missing required property/);

const wrongType = await validating.invoke({ id: "call-5", name: "obsidian__read", params: { path: 42 } });
assert.match(String(wrongType.content), /params\.path: expected string, got number/);

const badEnum = await validating.invoke({
    id: "call-6",
    name: "obsidian__read",
    params: { path: "a", encoding: "utf16" },
});
assert.match(String(badEnum.content), /params\.encoding: expected one of/);
assert.equal(invokedOnInvalid, 0, "参数非法时不得调用 Provider");

const valid = await validating.invoke({
    id: "call-7",
    name: "obsidian__read",
    params: { path: "a", encoding: "utf8" },
});
assert.equal(valid.status.isSuccess, true);
console.log("PASS 未知 Provider / 旧命名 / 缺参 / 类型 / 枚举");

/* ---------------------------------------------------------------------------
 * 8. 错误语义：ToolError 转结果，internalError 与非 ToolError 上抛
 * ------------------------------------------------------------------------- */
section("invoke 错误语义");

const failing = (error: unknown): ToolRegistry => {
    const registry = new ToolRegistry();
    registry.registerProvider(fakeProvider("p", {
        tools: [definition("read")],
        onCall: () => {
            throw error;
        },
    }));
    return registry;
};

const network = await failing(new ToolError(ToolErrorType.NetworkError, true, "socket reset"))
    .invoke({ id: "c", name: "p__read", params: { path: "a" } });
assert.equal(network.status.isSuccess, false);
assert.equal(network.status.error?.type, ToolErrorType.NetworkError);
assert.equal(network.status.error?.retryable, true);

await assert.rejects(
    () => failing(new ToolError(ToolErrorType.InternalError, false, "bug in provider"))
        .invoke({ id: "c", name: "p__read", params: { path: "a" } }),
    /bug in provider/,
    "internalError 不属于工具结果",
);

await assert.rejects(
    () => failing(new Error("plain boom"))
        .invoke({ id: "c", name: "p__read", params: { path: "a" } }),
    /plain boom/,
    "非 ToolError 属于程序缺陷，必须上抛",
);
console.log("PASS NetworkError→结果 / internalError 与普通异常上抛");

/* ---------------------------------------------------------------------------
 * 9. 取消与超时
 * ------------------------------------------------------------------------- */
section("取消与超时");

const hanging = (onCall?: FakeOptions["onCall"]): ToolRegistry => {
    const registry = new ToolRegistry();
    registry.registerProvider(fakeProvider("p", {
        tools: [definition("read")],
        onCall: onCall ?? (() => new Promise<ToolCallResult>(() => { /* 永不返回 */ })),
    }));
    return registry;
};

const timeoutStartedAt = Date.now();
const timedOut = await hanging().invoke(
    { id: "c", name: "p__read", params: { path: "a" } },
    { timeoutMs: 50 },
);
const timeoutElapsed = Date.now() - timeoutStartedAt;
assert.equal(timedOut.status.error?.type, ToolErrorType.Timeout);
assert.equal(timedOut.status.error?.retryable, true);
assert.ok(timeoutElapsed >= 40, `超时应至少等待 timeoutMs，实际 ${timeoutElapsed}ms`);
assert.ok(timeoutElapsed < 2000, `超时不应拖太久，实际 ${timeoutElapsed}ms`);

const preAborted = new AbortController();
preAborted.abort();
const aborted = await hanging().invoke(
    { id: "c", name: "p__read", params: { path: "a" } },
    { signal: preAborted.signal },
);
assert.equal(aborted.status.error?.type, ToolErrorType.AbortError);
assert.equal(aborted.status.error?.retryable, false);

const midFlight = new AbortController();
let providerSawSignal = false;
const pending = hanging((_call, options) => {
    providerSawSignal = options?.signal !== undefined;
    return new Promise<ToolCallResult>(() => { /* 永不返回 */ });
}).invoke(
    { id: "c", name: "p__read", params: { path: "a" } },
    { signal: midFlight.signal },
);
setTimeout(() => midFlight.abort(), 30);
const interrupted = await pending;
assert.equal(providerSawSignal, true, "Provider 必须收到取消信号");
assert.equal(interrupted.status.error?.type, ToolErrorType.AbortError);
console.log("PASS 超时 / 预先取消 / 中途取消");

/* ---------------------------------------------------------------------------
 * 10. 参数校验器直测
 * ------------------------------------------------------------------------- */
section("validateToolParams");

assert.deepEqual(validateToolParams({ type: "object", required: ["a"] }, {}), [
    "params.a: missing required property",
]);
assert.deepEqual(validateToolParams({ type: "array", items: { type: "number" } }, [1, "x"]), [
    "params[1]: expected number, got string",
]);
assert.deepEqual(validateToolParams({ type: ["string", "null"] }, null), []);
assert.deepEqual(validateToolParams({ type: "object", properties: { a: { type: "string" } } }, { a: "x" }), []);
assert.equal(
    validateToolParams({ type: "object", properties: { a: { type: "string" } } }, { a: "x", extra: 1 }).length,
    0,
    "未声明的字段应放行",
);
console.log("PASS required / items / 联合类型 / 未声明字段放行");

console.log("\nAll tool registry checks passed.");
