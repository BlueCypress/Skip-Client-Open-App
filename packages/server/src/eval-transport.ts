/**
 * @fileoverview HTTP transport settings for the Skip eval endpoints.
 *
 * An agent eval runs the whole Skip pipeline before the Skip API sends a single byte back,
 * and a hard case takes well over five minutes. Node's built-in fetch (undici) waits at most
 * 300 s for response headers, independently of any AbortSignal, and then fails with a bare
 * `fetch failed`. The eval call therefore runs on its own dispatcher, whose header and body
 * timeouts match the configured eval timeout.
 *
 * @module @askskip/server/eval-transport
 */

import { Agent } from 'undici';

/** One dispatcher per timeout value, so connections are pooled rather than leaked per request. */
const dispatchers = new Map<number, Agent>();

/**
 * Returns the dispatcher for eval requests that may take up to `timeoutMs` to respond.
 *
 * @param timeoutMs - The longest the request may wait for headers, and between body chunks
 */
export function getEvalDispatcher(timeoutMs: number): Agent {
    let dispatcher = dispatchers.get(timeoutMs);
    if (!dispatcher) {
        dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
        dispatchers.set(timeoutMs, dispatcher);
    }
    return dispatcher;
}

/** undici's error codes for a request that ran out of time. */
const UNDICI_TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

/** Whether `error` means the eval request ran out of time, as opposed to failing outright. */
export function isEvalTimeout(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }
    if (error.name === 'TimeoutError') {
        return true;
    }
    const cause = (error as Error & { cause?: { code?: string } }).cause;
    return !!cause?.code && UNDICI_TIMEOUT_CODES.has(cause.code);
}

/**
 * The error message an eval caller receives. A timeout names the setting that controls it;
 * fetch's own message for one is just `fetch failed`, which says nothing about the cause.
 *
 * @param error - What the eval request threw
 * @param timeoutMs - The timeout the request ran with
 */
export function describeEvalError(error: unknown, timeoutMs: number): string {
    if (isEvalTimeout(error)) {
        return `The Skip eval run did not respond within ${Math.round(timeoutMs / 1000)} s. ` +
            `Raise evalRunAgentTimeoutMs in skip.config.cjs if runs legitimately take longer.`;
    }
    return error instanceof Error ? error.message : String(error);
}
