import { InvalidParameterError } from "../../base";
import { SessionError, SessionErrorType } from "../../session/error";

/** 归一化 base URL：去空白、去尾部斜杠，空值时使用回退地址 */
export function normalizeBaseUrl(baseUrl: string | undefined, fallback: string): string{
    const trimmed = (baseUrl ?? fallback).trim();
    const resolved = trimmed.length > 0 ? trimmed : fallback;
    return resolved.replace(/\/+$/, "");
}

/** 构造 Bearer 鉴权头；API key 为空时抛出参数错误 */
export function buildBearerHeaders(
    apiKey: string,
    headers: Record<string, string> | undefined,
    label: string,
): Record<string, string>{
    const key = typeof apiKey === "string" ? apiKey.trim() : "";
    if (key.length === 0){
        throw new InvalidParameterError(`${label} requires a non-empty API key`);
    }

    return {
        Authorization: `Bearer ${key}`,
        ...(headers ?? {}),
    };
}

/** 解析 fetch 实现；宿主未注入时使用全局 fetch */
export function resolveFetch(
    fetchImpl: typeof fetch | undefined,
    label: string,
): typeof fetch{
    const resolved = fetchImpl ?? globalThis.fetch;
    if (typeof resolved !== "function"){
        throw new InvalidParameterError(`${label} requires a fetch implementation`);
    }
    return resolved;
}

/** 校验并取整超时时间；未设置时返回 undefined（表示不主动超时） */
export function normalizeTimeout(
    timeoutMs: number | undefined,
    label: string,
): number | undefined{
    if (timeoutMs === undefined) return undefined;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0){
        throw new InvalidParameterError(
            `${label} timeoutMs must be a positive number, got ${String(timeoutMs)}`,
        );
    }
    return Math.floor(timeoutMs);
}

/** 读取错误响应体，限制回传长度，避免把大段 HTML 写进错误消息 */
export async function readErrorDetail(response: Response, maxChars: number = 500): Promise<string>{
    const body = await response.text().catch(() => "");
    return body.length > 0 ? `: ${body.slice(0, maxChars)}` : "";
}

/** 把非 2xx 响应转换为 ProviderError */
export async function httpError(
    action: string,
    response: Response,
    maxChars: number = 500,
): Promise<SessionError>{
    return new SessionError(
        SessionErrorType.ProviderError,
        `${action} returned HTTP ${response.status}${await readErrorDetail(response, maxChars)}`,
        undefined,
        response.status,
    );
}

/** 请求级取消信号：外部 signal 与超时合并，调用方必须在结束时 cleanup */
export type RequestSignal = {
    signal: AbortSignal | undefined;
    timedOut: () => boolean;
    cleanup: () => void;
};

export function createRequestSignal(
    external: AbortSignal | undefined,
    timeoutMs: number | undefined,
): RequestSignal{
    if (timeoutMs === undefined && external === undefined){
        return { signal: undefined, timedOut: () => false, cleanup: () => { /* 无需清理 */ } };
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);

    const onAbort = (): void => controller.abort(external?.reason);
    if (external !== undefined){
        if (external.aborted) controller.abort(external.reason);
        else external.addEventListener("abort", onAbort, { once: true });
    }

    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        cleanup: () => {
            if (timer !== undefined) clearTimeout(timer);
            external?.removeEventListener("abort", onAbort);
        },
    };
}
