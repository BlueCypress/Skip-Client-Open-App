/**
 * The exact tier's SQL: aggregate statements over an entity's BaseView.
 *
 * Pure functions of (source, columns, dialect, sample). The caller never supplies
 * SQL or a column list, and every projection is a count, a length or a
 * date/numeric bound, so no text value can leave the database by this path.
 *
 * Per column, by {@link ColumnKind} (measurements §9, §10):
 * - every column: non-null count;
 * - `numeric`: MIN, MAX, zero count, negative count;
 * - `date`: MIN/MAX excluding placeholders (before 1901, from 2100, 1970-01-01) and
 *   the placeholder count; a second, cheap statement then counts rows at those
 *   bounds ({@link BuildExtremesStatement});
 * - `text` (bounded only): blank count, MAX and AVG length.
 *
 * No `COUNT(DISTINCT)`: 350–760 MB memory grants and 30 s to over 600 s per
 * statement, and one PostgreSQL OOM crash (measurements §4).
 *
 * Platform-specific SQL comes from `shared/dialectSQL.ts`, shared with the query
 * profiler; quoting comes from MJ's `SQLDialect`.
 */

import type { DatabasePlatform } from '@memberjunction/core';
import type { SQLDialect } from '@memberjunction/sql-dialect';
import {
    APPROX_DISTINCT, APPROX_DISTINCT_HINT, AS_FLOAT, BLANK_PREDICATE, CHAR_LENGTH, DATE_TEXT, KEY_HASH, SentinelPredicate, TABLE_SAMPLE,
} from '../shared/dialectSQL.js';
import type { ColumnKind, ProfiledColumn } from './entityColumns.js';
import type { SampleSpec } from './samplingPolicy.js';

/** Approximate-distinct aggregates per statement: measured safe; hundreds in one statement were not. */
export const MAX_APPROX_DISTINCT_PER_STATEMENT = 50;

/** Both engines' SELECT-list limits (SQL Server 4,096, PostgreSQL 1,664) with room to spare. */
export const MAX_AGGREGATES_PER_STATEMENT = 1_000;

/** Hash samples pick buckets of 0.01% of the key space. */
export const HASH_BUCKETS = 10_000;

/** MJ's platform key; every platform-specific fragment lives in `shared/dialectSQL.ts`. */
export type ProfileDialectName = DatabasePlatform;

export interface ProfileSource {
    Schema: string;
    /** The BaseView: the entity's definition, and what Skip's queries read. */
    View: string;
    /** The base table, read only by the semi-join sample. */
    BaseTable: string;
    PrimaryKeys: string[];
}

export interface AggregateStatement {
    SQL: string;
    /** Columns whose aggregates this statement computes. */
    Columns: ProfiledColumn[];
}

/** A date column's bounds from the main pass, as the database printed them, for the extremes statement. */
export interface DateBounds {
    Column: ProfiledColumn;
    RawMin: string;
    RawMax: string;
}

export const ROWS_ALIAS = '__rows';

/** Alias of one statistic of the column at `index` in the full column list. */
export type StatisticKey = 'nonNull' | 'min' | 'max' | 'zero' | 'negative' | 'blank' | 'maxLength' | 'avgLength'
    | 'sentinel' | 'atMin' | 'atMax' | 'approxDistinct';

const ALIAS_PREFIX: Record<StatisticKey, string> = {
    nonNull: 'c', min: 'n', max: 'x', zero: 'z', negative: 'g', blank: 'b', maxLength: 'lx', avgLength: 'la',
    sentinel: 's', atMin: 'em', atMax: 'ex', approxDistinct: 'ad',
};

export function StatisticAlias(key: StatisticKey, index: number): string {
    return `${ALIAS_PREFIX[key]}${index}`;
}

const AGGREGATES_PER_KIND: Record<ColumnKind, number> = { numeric: 5, date: 4, text: 4, other: 1 };

/**
 * The main pass, split so no statement exceeds {@link MAX_AGGREGATES_PER_STATEMENT}.
 * Aliases use each column's index in `all`, so chunks merge without collisions and
 * a retry of one chunk produces the same aliases.
 */
export function BuildMainStatements(source: ProfileSource, columns: ProfiledColumn[], all: ProfiledColumn[],
    dialect: SQLDialect, dialectName: ProfileDialectName, sample: SampleSpec | null): AggregateStatement[] {
    const from = FromClause(source, dialect, dialectName, sample);
    return ChunkColumns(columns).map(chunk => ({
        SQL: `SELECT COUNT(*) AS ${dialect.QuoteColumnAlias(ROWS_ALIAS)}, `
            + `${chunk.flatMap(c => projections(c, all.indexOf(c), dialect, dialectName)).join(', ')} FROM ${from}`,
        Columns: chunk,
    }));
}

export function ChunkColumns(columns: ProfiledColumn[]): ProfiledColumn[][] {
    const chunks: ProfiledColumn[][] = [];
    let current: ProfiledColumn[] = [];
    let aggregates = 1;
    for (const column of columns) {
        const cost = AGGREGATES_PER_KIND[column.Kind];
        if (current.length > 0 && aggregates + cost > MAX_AGGREGATES_PER_STATEMENT) {
            chunks.push(current);
            current = [];
            aggregates = 1;
        }
        current.push(column);
        aggregates += cost;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

/**
 * Rows at each date column's own MIN and MAX. A large share at an extreme marks a
 * placeholder whatever its value (CASE uses `2099-12-31` as "never ends", which
 * the 2100 cutoff misses). The bounds are the database's own printed values,
 * converted back with an explicit style so the comparison is exact and
 * independent of the session's date format.
 */
export function BuildExtremesStatement(source: ProfileSource, bounds: DateBounds[], all: ProfiledColumn[],
    dialect: SQLDialect, dialectName: ProfileDialectName, sample: SampleSpec | null): AggregateStatement | null {
    if (bounds.length === 0) return null;
    const parts = bounds.flatMap(b => {
        const index = all.indexOf(b.Column);
        const quoted = dialect.QuoteIdentifier(b.Column.Name);
        return [
            `${countWhen(`${quoted} = ${dateLiteral(b.RawMin, b.Column.Type, dialect, dialectName)}`)} AS ${dialect.QuoteColumnAlias(StatisticAlias('atMin', index))}`,
            `${countWhen(`${quoted} = ${dateLiteral(b.RawMax, b.Column.Type, dialect, dialectName)}`)} AS ${dialect.QuoteColumnAlias(StatisticAlias('atMax', index))}`,
        ];
    });
    return {
        SQL: `SELECT COUNT(*) AS ${dialect.QuoteColumnAlias(ROWS_ALIAS)}, ${parts.join(', ')} FROM ${FromClause(source, dialect, dialectName, sample)}`,
        Columns: bounds.map(b => b.Column),
    };
}

/**
 * Cardinality statements (SQL Server only; PostgreSQL reads `n_distinct` for free): at most
 * {@link MAX_APPROX_DISTINCT_PER_STATEMENT} approximate-distinct aggregates each, under the
 * platform's hint, over the main pass's sample. Columns that most often decide a join or a
 * grouping come first — keys (`uniqueidentifier`) and bounded text, then numbers and dates — so
 * a budget that runs out on a very wide entity leaves the least useful columns without one.
 * Long text, bits and other types are never counted.
 */
export function BuildCardinalityStatements(source: ProfileSource, columns: ProfiledColumn[], all: ProfiledColumn[],
    dialect: SQLDialect, dialectName: ProfileDialectName, sample: SampleSpec | null): AggregateStatement[] {
    const approx = APPROX_DISTINCT[dialectName];
    if (!approx) return [];
    const eligible = columns.filter(c => CardinalityPriority(c) !== null)
        .sort((a, b) => (CardinalityPriority(a) ?? 0) - (CardinalityPriority(b) ?? 0));
    const from = FromClause(source, dialect, dialectName, sample);
    const statements: AggregateStatement[] = [];
    for (let i = 0; i < eligible.length; i += MAX_APPROX_DISTINCT_PER_STATEMENT) {
        const chunk = eligible.slice(i, i + MAX_APPROX_DISTINCT_PER_STATEMENT);
        const parts = chunk.map(c => {
            const index = all.indexOf(c);
            const quoted = dialect.QuoteIdentifier(c.Name);
            return `${countWhen(`${quoted} IS NOT NULL`)} AS ${dialect.QuoteColumnAlias(StatisticAlias('nonNull', index))}, `
                + `${approx(quoted)} AS ${dialect.QuoteColumnAlias(StatisticAlias('approxDistinct', index))}`;
        });
        statements.push({
            SQL: `SELECT COUNT(*) AS ${dialect.QuoteColumnAlias(ROWS_ALIAS)}, ${parts.join(', ')} FROM ${from}${APPROX_DISTINCT_HINT[dialectName]}`,
            Columns: chunk,
        });
    }
    return statements;
}

/** Order in which columns get a cardinality, or null when they never do. */
export function CardinalityPriority(column: ProfiledColumn): number | null {
    if (column.Kind === 'other') return /^uniqueidentifier$|^uuid$/i.test(column.Type.trim()) ? 0 : null;
    return { text: 1, numeric: 2, date: 3 }[column.Kind];
}

/**
 * The view, restricted to a sample when one is given. `TABLESAMPLE` cannot apply
 * to a view on either engine, so:
 * - `hash` filters on a hash of the primary key: it reads every row and
 *   aggregates only the sample. It wins at about 5% and above.
 * - `semi` keeps keys drawn from a block sample of the base table: it reads only
 *   the sampled pages, then seeks the view by key. It wins below about 5%, and
 *   needs a single-column key and `SELECT` on the base table.
 */
export function FromClause(source: ProfileSource, dialect: SQLDialect, dialectName: ProfileDialectName, sample: SampleSpec | null): string {
    const view = dialect.QuoteSchema(source.Schema, source.View);
    if (!sample) return view;
    if (sample.Method === 'semi') {
        const key = dialect.QuoteIdentifier(source.PrimaryKeys[0]);
        const table = dialect.QuoteSchema(source.Schema, source.BaseTable);
        return `${view} WHERE ${key} IN (SELECT ${key} FROM ${table} ${TABLE_SAMPLE[dialectName](formatPercent(sample.Percent))})`;
    }
    const hash = KEY_HASH[dialectName](source.PrimaryKeys.map(k => dialect.QuoteIdentifier(k)));
    return `${view} WHERE ${hash} % ${HASH_BUCKETS} < ${HashBucket(sample.Percent)}`;
}

/** Buckets of {@link HASH_BUCKETS} a hash sample keeps. */
export function HashBucket(percent: number): number {
    return Math.min(HASH_BUCKETS, Math.max(1, Math.round(percent * HASH_BUCKETS / 100)));
}

/** The share of rows a sample keeps, for scaling its row count. */
export function SampleFraction(sample: SampleSpec): number {
    return sample.Method === 'hash' ? HashBucket(sample.Percent) / HASH_BUCKETS : sample.Percent / 100;
}

function formatPercent(percent: number): string {
    return String(Math.round(percent * 1000) / 1000);
}

function countWhen(predicate: string): string {
    return `SUM(CASE WHEN ${predicate} THEN 1 ELSE 0 END)`;
}

/**
 * `SUM(CASE WHEN c IS NULL THEN 0 ELSE 1 END)` rather than `COUNT(c)`, because
 * SQL Server rejects `COUNT` on its legacy LOB types and this form works on every
 * type in both dialects.
 */
function projections(column: ProfiledColumn, index: number, dialect: SQLDialect, dialectName: ProfileDialectName): string[] {
    const c = dialect.QuoteIdentifier(column.Name);
    const as = (key: StatisticKey, expression: string): string => `${expression} AS ${dialect.QuoteColumnAlias(StatisticAlias(key, index))}`;
    const parts = [as('nonNull', `SUM(CASE WHEN ${c} IS NULL THEN 0 ELSE 1 END)`)];
    switch (column.Kind) {
        case 'numeric':
            parts.push(as('min', `MIN(${c})`), as('max', `MAX(${c})`),
                as('zero', countWhen(`${c} = 0`)), as('negative', countWhen(`${c} < 0`)));
            break;
        case 'date': {
            const sentinel = SentinelPredicate(c, dialectName);
            parts.push(as('min', DATE_TEXT[dialectName](`MIN(CASE WHEN NOT ${sentinel} THEN ${c} END)`)),
                as('max', DATE_TEXT[dialectName](`MAX(CASE WHEN NOT ${sentinel} THEN ${c} END)`)),
                as('sentinel', countWhen(sentinel)));
            break;
        }
        case 'text':
            parts.push(...textProjections(c, dialectName).map(([key, expression]) => as(key, expression)));
            break;
        case 'other':
            break;
    }
    return parts;
}

function textProjections(c: string, dialectName: ProfileDialectName): [StatisticKey, string][] {
    const length = CHAR_LENGTH[dialectName](c);
    return [['blank', countWhen(BLANK_PREDICATE[dialectName](c))], ['maxLength', `MAX(${length})`], ['avgLength', `AVG(${AS_FLOAT[dialectName](length)})`]];
}

const SQL_SERVER_DATE_TYPES = new Set(['date', 'datetime', 'datetime2', 'datetimeoffset', 'smalldatetime']);

/**
 * A bound printed by the main pass, converted back exactly: SQL Server with an
 * explicit style 121 (its implicit conversion of `yyyy-mm-dd hh:mi:ss` to
 * `datetime` depends on the session's date format); PostgreSQL by coercing an
 * untyped literal to the column's type.
 */
const DATE_BOUND_LITERAL: Record<ProfileDialectName, (literal: string, type: string) => string> = {
    sqlserver: (literal, type) => {
        const base = type.trim().toLowerCase().replace(/\(.*$/, '');
        return SQL_SERVER_DATE_TYPES.has(base) ? `CONVERT(${base.toUpperCase()}, ${literal}, 121)` : literal;
    },
    postgresql: literal => literal,
};

function dateLiteral(raw: string, type: string, dialect: SQLDialect, dialectName: ProfileDialectName): string {
    return DATE_BOUND_LITERAL[dialectName](dialect.QuoteStringLiteral(raw), type);
}
