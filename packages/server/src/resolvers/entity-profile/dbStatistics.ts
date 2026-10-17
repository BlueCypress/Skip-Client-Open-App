/**
 * The free tier: statistics the database already keeps, read from its catalog.
 *
 * - Size: PostgreSQL `pg_class.relpages`, SQL Server in-row pages; it sets the
 *   cost estimate's floor for wide-row tables.
 * - Row count: PostgreSQL `pg_class.reltuples` (an estimate, normally within
 *   0.2% but seen 13% off) and SQL Server `sys.partitions.rows` (exact).
 * - Coverage: PostgreSQL `pg_stats.null_frac`, and the NULL step of a SQL Server
 *   statistics histogram, for the columns that have one. Coverage error was at
 *   most 0.006 against exact counts (E1b). SQL Server keeps statistics only for
 *   columns someone has filtered, joined or grouped on, so most columns have none.
 * - Distinct values (PostgreSQL only): `pg_stats.n_distinct`, an ANALYZE
 *   estimate that is free and present for nearly every column; it gives the
 *   cardinality class. SQL Server keeps no equivalent outside histograms.
 * - Change counter (PostgreSQL only): `n_tup_ins + n_tup_upd + n_tup_del`, which
 *   drives the refresh rule.
 *
 * Bounds are never taken from statistics: histogram and most-common-value arrays
 * hold real values, and their date maxima were wrong in up to 100% of a table's
 * date columns. Everything here is readable by a `db_datareader` login; the
 * DMVs that need VIEW DATABASE STATE are deliberately not used.
 */

import type { SQLDialect } from '@memberjunction/sql-dialect';
import type { ProfileDialectName } from './profileSQL.js';

export interface TableStatistics {
    /** Row count, or null when the database has none (a PostgreSQL table never analyzed). */
    Rows: number | null;
    RowsExact: boolean;
    /** PostgreSQL cumulative insert + update + delete count; null on SQL Server. */
    ChangeCounter: number | null;
    /** In-row bytes (PostgreSQL heap, SQL Server in-row pages): what a scan reads. Null when unknown. */
    Bytes: number | null;
}

export interface ColumnStatisticRow {
    name: string;
    /** PostgreSQL: fraction of NULLs. */
    null_frac?: number | null;
    /** PostgreSQL: distinct values; negative is a fraction of rows. */
    n_distinct?: number | null;
    /** SQL Server: rows the statistic describes. */
    stat_rows?: number | null;
    /** SQL Server: histogram steps; 0 on a non-empty table means the column is all NULL. */
    steps?: number | null;
    /** SQL Server: rows in the NULL step. */
    null_rows?: number | null;
    /** SQL Server: when the statistic was last updated, to prefer the newest of several. */
    last_updated?: string | Date | null;
}

type CatalogSQL = Record<ProfileDialectName, (schema: string, table: string, dialect: SQLDialect) => string>;

const TABLE_STATISTICS_SQL: CatalogSQL = {
    sqlserver: (schema, table, dialect) => {
        const object = `OBJECT_ID(${objectName(schema, table, dialect)})`;
        return `SELECT SUM(p.rows) AS rows, `
            + `(SELECT SUM(a.total_pages) * 8192 FROM sys.allocation_units a JOIN sys.partitions ap ON a.container_id = ap.partition_id `
            + `WHERE ap.object_id = ${object} AND ap.index_id IN (0, 1) AND a.type = 1) AS bytes `
            + `FROM sys.partitions p WHERE p.object_id = ${object} AND p.index_id IN (0, 1)`;
    },
    // relpages, not pg_relation_size(): the function takes a lock on the table and waits behind any
    // exclusive lock (ALTER TABLE, VACUUM FULL), while the catalog columns never do.
    postgresql: (schema, table, dialect) => `SELECT CAST(c.reltuples AS BIGINT) AS rows, `
        + `CAST(c.relpages AS BIGINT) * CAST(current_setting('block_size') AS BIGINT) AS bytes, `
        + `COALESCE(s.n_tup_ins, 0) + COALESCE(s.n_tup_upd, 0) + COALESCE(s.n_tup_del, 0) AS change_counter `
        + `FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace `
        + `LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid `
        + `WHERE n.nspname = ${dialect.QuoteStringLiteral(schema)} AND c.relname = ${dialect.QuoteStringLiteral(table)}`,
};

const COLUMN_STATISTICS_SQL: CatalogSQL = {
    sqlserver: (schema, table, dialect) => `SELECT c.name AS name, sp.rows AS stat_rows, sp.last_updated, `
        + `(SELECT COUNT(*) FROM sys.dm_db_stats_histogram(st.object_id, st.stats_id)) AS steps, `
        + `(SELECT SUM(h.equal_rows) FROM sys.dm_db_stats_histogram(st.object_id, st.stats_id) h WHERE h.range_high_key IS NULL) AS null_rows `
        + `FROM sys.stats st `
        + `JOIN sys.stats_columns sc ON sc.object_id = st.object_id AND sc.stats_id = st.stats_id AND sc.stats_column_id = 1 `
        + `JOIN sys.columns c ON c.object_id = sc.object_id AND c.column_id = sc.column_id `
        + `CROSS APPLY sys.dm_db_stats_properties(st.object_id, st.stats_id) sp `
        + `WHERE st.object_id = OBJECT_ID(${objectName(schema, table, dialect)}) AND sp.rows > 0`,
    postgresql: (schema, table, dialect) => `SELECT attname AS name, null_frac, n_distinct FROM pg_stats `
        + `WHERE schemaname = ${dialect.QuoteStringLiteral(schema)} AND tablename = ${dialect.QuoteStringLiteral(table)} `
        + `AND NOT inherited`,
};

export function TableStatisticsSQL(schema: string, table: string, dialect: SQLDialect, dialectName: ProfileDialectName): string {
    return TABLE_STATISTICS_SQL[dialectName](schema, table, dialect);
}

export function ColumnStatisticsSQL(schema: string, table: string, dialect: SQLDialect, dialectName: ProfileDialectName): string {
    return COLUMN_STATISTICS_SQL[dialectName](schema, table, dialect);
}

function objectName(schema: string, table: string, dialect: SQLDialect): string {
    return dialect.QuoteStringLiteral(dialect.QuoteSchema(schema, table));
}

const TABLE_STATISTICS_READER: Record<ProfileDialectName, (row: Record<string, unknown> | undefined) => TableStatistics> = {
    sqlserver: row => ({ Rows: toNumber(row?.rows), RowsExact: true, ChangeCounter: null, Bytes: toNumber(row?.bytes) }),
    postgresql: row => {
        const rows = toNumber(row?.rows);
        // reltuples is -1 (PostgreSQL 14+) before the first ANALYZE: unknown, not empty.
        return { Rows: rows === null || rows < 0 ? null : rows, RowsExact: false, ChangeCounter: toNumber(row?.change_counter), Bytes: toNumber(row?.bytes) };
    },
};

export function ReadTableStatistics(row: Record<string, unknown> | undefined, dialectName: ProfileDialectName): TableStatistics {
    return TABLE_STATISTICS_READER[dialectName](row);
}

/** What the database's own statistics say about one column. */
export interface ColumnStatistic {
    Coverage?: number;
    /** PostgreSQL `n_distinct`: positive is a count, negative a fraction of rows. */
    NDistinct?: number;
}

const COLUMN_STATISTICS_READER: Record<ProfileDialectName, (rows: ColumnStatisticRow[]) => Map<string, ColumnStatistic>> = {
    sqlserver: readSQLServerHistograms,
    postgresql: rows => new Map(rows.map(row => {
        const nullFraction = toNumber(row.null_frac);
        const nDistinct = toNumber(row.n_distinct);
        return [row.name, {
            ...(nullFraction !== null && { Coverage: clamp(1 - nullFraction) }),
            ...(nDistinct !== null && nDistinct !== 0 && { NDistinct: nDistinct }),
        }];
    })),
};

export function ReadColumnStatistics(rows: ColumnStatisticRow[], dialectName: ProfileDialectName): Map<string, ColumnStatistic> {
    return COLUMN_STATISTICS_READER[dialectName](rows);
}

/**
 * On SQL Server a column can have several statistics objects; the newest wins. A
 * histogram with no steps on a non-empty table is an all-NULL column — reading it
 * as "no NULL step, so fully populated" would report the emptiest columns as the
 * fullest.
 */
function readSQLServerHistograms(rows: ColumnStatisticRow[]): Map<string, ColumnStatistic> {
    const newest = new Map<string, ColumnStatisticRow>();
    for (const row of rows) {
        const current = newest.get(row.name);
        if (!current || timeOf(row.last_updated) > timeOf(current.last_updated)) newest.set(row.name, row);
    }
    const statistics = new Map<string, ColumnStatistic>();
    for (const [name, row] of newest) {
        const statRows = toNumber(row.stat_rows);
        if (!statRows) continue;
        const empty = (toNumber(row.steps) ?? 0) === 0;
        statistics.set(name, { Coverage: empty ? 0 : clamp(1 - (toNumber(row.null_rows) ?? 0) / statRows) });
    }
    return statistics;
}

function toNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function timeOf(value: string | Date | null | undefined): number {
    if (!value) return 0;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
}

function clamp(value: number): number {
    return Math.min(1, Math.max(0, value));
}
