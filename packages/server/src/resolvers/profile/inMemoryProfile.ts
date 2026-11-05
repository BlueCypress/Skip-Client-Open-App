/**
 * The profile's aggregate pass computed from rows already fetched, instead of a second query.
 *
 * The SQL pass hoists the candidate query into a CTE and aggregates it, so the database runs the whole candidate query
 * a second time. When the test leg already fetched the complete result (it came back under its row cap), the same
 * statistics follow from those rows. ACR, 11-05: a Test SQL over a composed ground truth query took ~20 s, and its
 * profile leg re-ran it and hit the 15 s timeout three times, so the writer paid ~35 s and got no statistics.
 *
 * Every statistic mirrors its SQL expression in `planProfileAggregates`, including the platform's comparison rules:
 * SQL Server's default collation compares text case-insensitively and ignores trailing spaces (`COUNT(DISTINCT)`,
 * `= ''`), PostgreSQL compares exactly and the blank test trims both ends. Dates arrive from the driver as UTC ISO
 * strings once serialized, which is the stored value (`useUTC`), so they compare and print as style 121 would.
 *
 * Pure, so the parity with the SQL pass is unit-testable without a database.
 */

import type { DatabasePlatform } from '@memberjunction/core';
import type { ProfileAggregatePlan } from './buildProfileSQL.js';

type Row = Record<string, unknown>;

/** The aggregate row the SQL pass would have returned for these rows, keyed by the plan's aliases. */
export function computeProfileAggregatesInMemory(rows: Row[], plan: ProfileAggregatePlan, platform: DatabasePlatform): Row {
    const result: Row = { [plan.totalRowsAlias]: rows.length };
    for (const aggregate of plan.aggregates) {
        const values = rows.map(r => r[aggregate.column]);
        result[aggregate.alias] = AGGREGATES[aggregate.kind](values, platform);
    }
    return result;
}

type Aggregate = (values: unknown[], platform: DatabasePlatform) => unknown;

const AGGREGATES: Record<ProfileAggregatePlan['aggregates'][number]['kind'], Aggregate> = {
    distinct: (values, platform) => new Set(values.filter(isPresent).map(v => distinctKey(v, platform))).size,
    nulls: values => values.filter(v => !isPresent(v)).length,
    min: values => extreme(numbers(values), (a, b) => a < b),
    max: values => extreme(numbers(values), (a, b) => a > b),
    nonZero: values => numbers(values).filter(n => n !== 0).length,
    blank: (values, platform) => values.filter(v => typeof v === 'string' && isBlank(v, platform)).length,
    sentinel: values => dates(values).filter(isSentinelDate).length,
    minDate: values => dateText(extreme(dates(values).filter(d => !isSentinelDate(d)), (a, b) => a < b)),
    maxDate: values => dateText(extreme(dates(values).filter(d => !isSentinelDate(d)), (a, b) => a > b)),
};

function isPresent(value: unknown): boolean {
    return value !== null && value !== undefined;
}

/** The value as `COUNT(DISTINCT)` compares it on the platform. */
function distinctKey(value: unknown, platform: DatabasePlatform): string {
    if (typeof value !== 'string') return `${typeof value}:${String(value)}`;
    return platform === 'sqlserver' ? `string:${value.toLowerCase().replace(/\s+$/, '')}` : `string:${value}`;
}

/** `BLANK_PREDICATE`: SQL Server's `= ''` ignores trailing spaces only; PostgreSQL's `btrim` trims both ends. */
function isBlank(value: string, platform: DatabasePlatform): boolean {
    return (platform === 'sqlserver' ? value.replace(/\s+$/, '') : value.trim()) === '';
}

/** Numeric values, as the driver returns them (decimals and bigints often as strings). */
function numbers(values: unknown[]): number[] {
    return values.flatMap(v => {
        if (typeof v === 'number') return Number.isFinite(v) ? [v] : [];
        if (typeof v === 'bigint') return [Number(v)];
        if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return [Number(v)];
        return [];
    });
}

/** Date values as UTC ISO timestamps (`2026-11-05T00:00:00.000Z`), comparable as strings. */
function dates(values: unknown[]): string[] {
    return values.flatMap(v => {
        const iso = v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null;
        return iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? [iso] : [];
    });
}

/** `SentinelPredicate`: before 1901, from 2100, or on 1970-01-01. */
function isSentinelDate(iso: string): boolean {
    return iso < '1901-01-01' || iso >= '2100-01-01' || iso.startsWith('1970-01-01');
}

/** Style 121 (`yyyy-mm-dd hh:mi:ss.mmm`), which `FormatDate` then trims as it does the SQL pass's text. */
function dateText(iso: string | null): string | null {
    if (!iso) return null;
    const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2})(\.\d+)?)?/.exec(iso);
    return match ? `${match[1]} ${match[2] ?? '00:00:00'}${match[3] ?? '.000'}` : iso;
}

function extreme<T>(values: T[], better: (a: T, b: T) => boolean): T | null {
    let best: T | null = null;
    for (const value of values) if (best === null || better(value, best)) best = value;
    return best;
}
