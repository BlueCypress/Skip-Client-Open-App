/**
 * A profiled test fetches more rows than the caller asked for, so a small result can be profiled from them. Only the
 * statistics leave the client's server for those extra rows: the caller receives the rows it asked for and no more.
 */

/** The parts of a test result this reads and rewrites. */
export interface TestRowsResult {
    Success: boolean;
    Results?: string;
    RowCount: number;
}

/** The test result as the caller asked for it: at most `requested` rows, whatever the profile fetched. */
export function capToRequestedRows<T extends TestRowsResult>(fetched: T, rows: Record<string, unknown>[], requested: number | undefined): T {
    if (!fetched.Success || requested == null || rows.length <= requested) return fetched;
    const kept = rows.slice(0, requested);
    return { ...fetched, Results: JSON.stringify(kept), RowCount: kept.length };
}
