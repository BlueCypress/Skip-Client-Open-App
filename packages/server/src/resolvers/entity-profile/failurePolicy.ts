/**
 * How the exact pass reacts to a failed statement (measurements §7).
 *
 * - A **timeout** is retried with a smaller sample: the pass can still finish.
 * - **Any other error** (permissions, a dropped column, invalid SQL) is not
 *   resampled: a smaller sample fails the same way. It waits for the long
 *   schedule.
 *
 * Between failed attempts the entry backs off 5 min → 30 min → 2 h → 12 h → 24 h,
 * so an entity that cannot be profiled costs one bounded attempt per interval per
 * replica, not one per request.
 */

export type FailureKind = 'timeout' | 'error';

const BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000];

/**
 * Recognizes a statement timeout from every path that raises one:
 * - MJ's `timeoutMs` on SQL Server (`QueryWithTimeout`): `Query timeout exceeded`;
 * - the mssql driver's own `requestTimeout`: `RequestError` code `ETIMEOUT`, and
 *   `ECANCEL` for a cancelled request;
 * - PostgreSQL's `statement_timeout`: SQLSTATE `57014`, "canceling statement due
 *   to statement timeout".
 */
export function ClassifyFailure(error: unknown): FailureKind {
    const code = errorCode(error);
    if (code === '57014' || code === 'ETIMEOUT' || code === 'ECANCEL') return 'timeout';
    const message = error instanceof Error ? error.message : String(error);
    return /timeout|timed out|canceling statement|request failed to complete/i.test(message) ? 'timeout' : 'error';
}

/** Wait before the next attempt after `failedAttempts` consecutive failures (1-based). */
export function BackoffMs(failedAttempts: number): number {
    const index = Math.min(Math.max(failedAttempts, 1), BACKOFF_MS.length) - 1;
    return BACKOFF_MS[index];
}

function errorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    const direct = (error as { code?: unknown }).code;
    if (typeof direct === 'string') return direct;
    // mssql wraps the driver error; MJ may wrap it again.
    const cause = (error as { originalError?: unknown; cause?: unknown }).originalError ?? (error as { cause?: unknown }).cause;
    return cause && cause !== error ? errorCode(cause) : undefined;
}
