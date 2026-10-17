/**
 * The SQL both profilers emit that differs by platform, in one place.
 *
 * Quoting goes through MJ's `SQLDialect`; what is here is the rest: functions and
 * clauses that have no dialect abstraction (string length, hashing, sampling,
 * date text). Every entry is a `Record<DatabasePlatform, …>`, so a platform MJ
 * adds is a compile error here until it has its own SQL, rather than silently
 * receiving T-SQL.
 *
 * PostgreSQL fragments are written in lower case: MJ's PostgreSQL provider
 * auto-quotes bare ALL-CAPS words that are not in its keyword list
 * (`REPEATABLE`, `CONCAT_WS` are not), which would turn them into identifiers.
 */

import type { DatabasePlatform } from '@memberjunction/core';

type Fragment<Args extends unknown[]> = Record<DatabasePlatform, (...args: Args) => string>;

/** Empty or whitespace-only. SQL Server's `=` ignores trailing spaces; PostgreSQL needs `btrim`. */
export const BLANK_PREDICATE: Fragment<[string]> = {
    sqlserver: c => `${c} = ''`,
    postgresql: c => `btrim(${c}) = ''`,
};

/** Length in characters. `LEN` ignores trailing spaces, as the blank test does. */
export const CHAR_LENGTH: Fragment<[string]> = {
    sqlserver: c => `LEN(${c})`,
    postgresql: c => `char_length(${c})`,
};

/** A non-fractional numeric expression as a float, so AVG keeps decimals. */
export const AS_FLOAT: Fragment<[string]> = {
    sqlserver: e => `CAST(${e} AS FLOAT)`,
    postgresql: e => `cast(${e} as double precision)`,
};

/** A typed date literal: never converted to the column's type (`2100-01-01` overflows `smalldatetime`) or read by the session's date format. */
export const DATE_LITERAL: Fragment<[string]> = {
    sqlserver: day => `CAST('${day}' AS DATETIME2)`,
    postgresql: day => `date '${day}'`,
};

/** A date as the database prints it (SQL Server style 121), which round-trips exactly and avoids the driver's time-zone handling. */
export const DATE_TEXT: Fragment<[string]> = {
    sqlserver: e => `CONVERT(NVARCHAR(40), ${e}, 121)`,
    postgresql: e => `cast(${e} as text)`,
};

/** A non-negative 31-bit hash of one or more key columns, so `%` never sees a negative number. */
export const KEY_HASH: Fragment<[string[]]> = {
    sqlserver: keys => `(CHECKSUM(${keys.join(', ')}) & 2147483647)`,
    postgresql: keys => `(hashtext(${keys.length === 1
        ? `cast(${keys[0]} as text)`
        : `concat_ws('|', ${keys.map(k => `cast(${k} as text)`).join(', ')})`}) & 2147483647)`,
};

/** A repeatable block sample of a base table (never a view: neither engine allows it). */
export const TABLE_SAMPLE: Fragment<[string]> = {
    sqlserver: percent => `TABLESAMPLE (${percent} PERCENT) REPEATABLE (7)`,
    postgresql: percent => `tablesample system (${percent}) repeatable (7)`,
};

/**
 * Approximate distinct count (HyperLogLog, ~2% error), or null where the database's own
 * statistics give the cardinality for free (PostgreSQL `pg_stats.n_distinct`). Hundreds of
 * these in one parallel statement exhausted SQL Server's memory and shut a test instance down;
 * statements of at most 50 under `MAXDOP 2` used a 14 MB grant (2M rows × 1,022 columns).
 */
export const APPROX_DISTINCT: Record<DatabasePlatform, ((c: string) => string) | null> = {
    sqlserver: c => `APPROX_COUNT_DISTINCT(${c})`,
    postgresql: null,
};

/** The hint the approximate-distinct statements run under. */
export const APPROX_DISTINCT_HINT: Record<DatabasePlatform, string> = {
    sqlserver: ' OPTION (MAXDOP 2)',
    postgresql: '',
};

/**
 * Placeholder dates: before 1901, from 2100, or 1970-01-01. One rule for both
 * profilers, so the entity profile and a query profile agree on what a
 * placeholder is.
 */
export function SentinelPredicate(c: string, platform: DatabasePlatform): string {
    const day = DATE_LITERAL[platform];
    return `(${c} < ${day('1901-01-01')} OR ${c} >= ${day('2100-01-01')} `
        + `OR (${c} >= ${day('1970-01-01')} AND ${c} < ${day('1970-01-02')}))`;
}

/** `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM:SS` when the time is not midnight; fractions and offsets dropped. */
export function FormatDate(raw: string): string {
    const match = /^(-?\d{4,}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?/.exec(raw.trim());
    if (!match) return raw;
    return !match[2] || match[2] === '00:00:00' ? match[1] : `${match[1]}T${match[2]}`;
}
