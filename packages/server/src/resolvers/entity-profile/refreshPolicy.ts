/**
 * When a cached entity profile is recomputed.
 *
 * Statistics change slowly, and Skip only needs them roughly right, so the backstop is a week. Every
 * signal used here is free: no freshness check scans a table, so profiling never adds load to the
 * client's database between refreshes.
 *
 * A change signal alone is not enough. On a client whose integration syncs every
 * few minutes, `MAX(__mj_UpdatedAt)` moves every 20 s–4 min while under 0.31% of
 * rows change in a day (E1b, PLUS), so refreshing on every change would mean
 * recomputing on almost every call. A change counts only once enough rows have
 * changed and the entry is old enough; age alone eventually refreshes anything.
 */

export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_AGE_FOR_ROW_CHANGE_MS = 60 * 60 * 1000;
export const CHANGED_SHARE = 0.05;
/** A freshness check reads only catalog statistics; run it at most this often per entity. */
export const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** What the freshness check observes now, and what was observed when the profile was computed. */
export interface FreshnessSample {
    Rows: number | null;
    /** PostgreSQL insert + update + delete counter. */
    ChangeCounter: number | null;
}

export interface RefreshInput {
    AgeMs: number;
    SchemaChanged: boolean;
    Baseline: FreshnessSample;
    Current: FreshnessSample;
}

export type RefreshReason = 'schema' | 'age' | 'counter-reset' | 'rows-changed' | null;

export function RefreshReasonFor(input: RefreshInput): RefreshReason {
    const { AgeMs, Baseline, Current } = input;
    if (input.SchemaChanged) return 'schema';
    if (AgeMs >= MAX_AGE_MS) return 'age';
    if (Baseline.ChangeCounter !== null && Current.ChangeCounter !== null && Current.ChangeCounter < Baseline.ChangeCounter) {
        // Counters reset on a crash, failover or pg_stat_reset; nothing about the data can be inferred.
        return 'counter-reset';
    }
    if (AgeMs >= MIN_AGE_FOR_ROW_CHANGE_MS && changedShare(Baseline, Current) >= CHANGED_SHARE) return 'rows-changed';
    return null;
}

/** Share of rows changed: from the change counter when there is one, otherwise from the row count's movement. */
function changedShare(baseline: FreshnessSample, current: FreshnessSample): number {
    const rows = Math.max(baseline.Rows ?? current.Rows ?? 0, 1);
    if (baseline.ChangeCounter !== null && current.ChangeCounter !== null) {
        return (current.ChangeCounter - baseline.ChangeCounter) / rows;
    }
    if (baseline.Rows !== null && current.Rows !== null) {
        return Math.abs(current.Rows - baseline.Rows) / rows;
    }
    return 0;
}
