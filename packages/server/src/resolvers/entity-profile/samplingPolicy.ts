/**
 * Whether, and how, the exact pass samples an entity's rows.
 *
 * The decision comes from a cost estimate, not from a row or cell threshold:
 * rows × per-column cost, using the worst rates measured on PLUS (16 ns per cell
 * for coverage alone, 36 ns with the type-specific statistics; measurements §9).
 * A pass estimated above {@link SAMPLE_ABOVE_MS} is sampled, sized to land at
 * about {@link SAMPLE_TARGET_MS}.
 *
 * The per-cell rate cannot see wide rows: PLUS `RecordChange` (19 columns, a
 * 5.8 GB heap) was estimated at 3.5 s and took 23 s. So the estimate is at least
 * the time to read the table's in-row bytes, at the slowest measured rate per
 * engine, counted twice when date columns add the extremes statement, which is a
 * second scan (implementation-remeasure.md).
 *
 * - **SQL Server samples only from {@link SQL_SERVER_MIN_SAMPLED_ROWS} rows.**
 *   `TABLESAMPLE` there runs single-threaded and was slower than the parallel full
 *   scan at 773k rows (measurements §2).
 * - **Method by size:** below {@link SEMI_BELOW_PERCENT} a semi-join over a block
 *   sample reads only the sampled pages; from there a key-hash filter wins
 *   (measurements §10, finding 4). The semi-join needs a single-column key.
 * - **After a timeout** the sample is cut 4×, down to a floor of
 *   {@link FLOOR_PERCENT}% or {@link FLOOR_ROWS} rows, whichever is larger.
 */

import type { ColumnKind, ProfiledColumn } from './entityColumns.js';
import type { ProfileDialectName } from './profileSQL.js';

export type SampleMethod = 'hash' | 'semi';

export interface SampleSpec {
    /** Share of rows to keep, 0–100. */
    Percent: number;
    Method: SampleMethod;
}

/** Nanoseconds per row for a column of each kind (measured worst case). */
const NS_PER_CELL: Record<ColumnKind, number> = { numeric: 36, date: 36, text: 36, other: 16 };
/** Nanoseconds per in-row byte scanned: PLUS 23.1 s / 5.8 GB; SQL Server's parallel scan, CASE 4.6 s / 16.6 GB. */
const NS_PER_BYTE: Record<ProfileDialectName, number> = { postgresql: 4, sqlserver: 0.3 };

export const SAMPLE_ABOVE_MS = 10_000;
export const SAMPLE_TARGET_MS = 5_000;
export const SQL_SERVER_MIN_SAMPLED_ROWS = 2_000_000;
/** Below this many rows a full scan always runs. */
const MIN_SAMPLED_ROWS: Record<ProfileDialectName, number> = { sqlserver: SQL_SERVER_MIN_SAMPLED_ROWS, postgresql: 0 };
export const SEMI_BELOW_PERCENT = 5;
export const FLOOR_PERCENT = 0.5;
export const FLOOR_ROWS = 20_000;
const TIMEOUT_CUT = 4;

export function EstimatePassMs(rows: number, columns: ProfiledColumn[], bytes: number | null = null,
    dialectName: ProfileDialectName = 'postgresql'): number {
    const nsPerRow = columns.reduce((sum, c) => sum + NS_PER_CELL[c.Kind], 0);
    const cells = rows * nsPerRow / 1_000_000;
    if (bytes === null || bytes <= 0) return cells;
    const scans = columns.some(c => c.Kind === 'date') ? 2 : 1;
    return Math.max(cells, scans * bytes * NS_PER_BYTE[dialectName] / 1_000_000);
}

/** The first attempt's sample, or null for a full scan. */
export function ChooseSample(rows: number | null, columns: ProfiledColumn[], primaryKeys: string[],
    dialectName: ProfileDialectName, bytes: number | null = null): SampleSpec | null {
    if (rows === null || rows <= 0 || primaryKeys.length === 0) return null;
    if (rows < MIN_SAMPLED_ROWS[dialectName]) return null;
    const estimate = EstimatePassMs(rows, columns, bytes, dialectName);
    if (estimate <= SAMPLE_ABOVE_MS) return null;
    const percent = Math.max(100 * SAMPLE_TARGET_MS / estimate, FloorPercent(rows));
    return percent >= 100 ? null : sampleFor(percent, primaryKeys);
}

/**
 * The sample to retry with after a timeout, or null when the floor has already
 * been tried (the pass gives up). A full scan cuts to 25%.
 */
export function SampleAfterTimeout(current: SampleSpec | null, rows: number | null, primaryKeys: string[]): SampleSpec | null {
    if (primaryKeys.length === 0) return null;
    const floor = FloorPercent(rows);
    const currentPercent = current?.Percent ?? 100;
    if (currentPercent <= floor) return null;
    return sampleFor(Math.max(currentPercent / TIMEOUT_CUT, floor), primaryKeys);
}

/** The same sample by key hash, after a semi-join failed (most likely no `SELECT` on the base table). */
export function HashInstead(sample: SampleSpec): SampleSpec {
    return { Percent: sample.Percent, Method: 'hash' };
}

export function FloorPercent(rows: number | null): number {
    if (rows === null || rows <= 0) return FLOOR_PERCENT;
    return Math.min(100, Math.max(FLOOR_PERCENT, 100 * FLOOR_ROWS / rows));
}

function sampleFor(percent: number, primaryKeys: string[]): SampleSpec {
    const method: SampleMethod = percent < SEMI_BELOW_PERCENT && primaryKeys.length === 1 ? 'semi' : 'hash';
    return { Percent: Math.round(percent * 1000) / 1000, Method: method };
}
