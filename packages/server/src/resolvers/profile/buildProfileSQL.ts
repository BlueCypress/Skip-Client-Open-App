/**
 * Deterministic, dialect-agnostic generation of the profile queries.
 *
 * The builder here is a **pure function** of (base SQL, column list, policy,
 * dialect). That purity is the security property, not merely a testing
 * convenience: a deterministically-generated aggregate query cannot be steered
 * by a model into returning row values. Every projection it emits is a count, a
 * ratio or a numeric bound, so no row value can leave the database by this path
 * regardless of what the caller asks for.
 *
 * It also means the riskiest piece — CTE hoisting — is unit-testable against
 * both dialects without a database.
 */

import { SQLParser, AnalyzeTopLevelOrderBy } from '@memberjunction/sql-parser';
import type { SQLDialect } from '@memberjunction/sql-dialect';
import type { ProfileColumn } from './columnTypes.js';
import type { PrivacyPolicy } from './privacyPolicy.js';

/** The CTE the candidate query is hoisted into. Prefixed to avoid colliding with a user CTE. */
const PROFILE_CTE = '__skip_profile';

/** Alias of the `COUNT(*)` column in the aggregate pass. */
const TOTAL_ROWS_ALIAS = 'skip_total_rows';

/** Which statistic a returned aggregate column carries. */
export type ProfileAggregateKind = 'distinct' | 'nulls' | 'min' | 'max' | 'nonZero';

/** Maps one column of the aggregate result back to the column and statistic it describes. */
export interface ProfileAggregate {
    alias: string;
    column: string;
    kind: ProfileAggregateKind;
}

export interface ProfileSQLPlan {
    sql: string;
    totalRowsAlias: string;
    aggregates: ProfileAggregate[];
    /** Columns the aggregate pass refused to describe, with the reason. */
    skipped: { name: string; reason: string }[];
}

/**
 * SQL base types that cannot be aggregated with `COUNT(DISTINCT …)` on at least
 * one supported platform (SQL Server rejects the legacy LOB types outright).
 * Columns of these types are reported as skipped rather than risking an error
 * that would sink the entire profile.
 */
const NON_AGGREGATABLE_TYPES = new Set<string>([
    'text', 'ntext', 'image', 'xml',
    'binary', 'varbinary', 'bytea',
]);

/**
 * Builds the single aggregate query that produces every statistic.
 *
 * Returns `null` when the candidate SQL cannot be safely rewritten — the caller
 * reports `unparseable` and returns the test result untouched.
 */
export function buildProfileSQL(
    baseSQL: string,
    columns: ProfileColumn[],
    _policy: PrivacyPolicy,
    dialect: SQLDialect,
): ProfileSQLPlan | null {
    const hoisted = hoistIntoProfileCTE(baseSQL, dialect);
    if (!hoisted) return null;

    const skipped: { name: string; reason: string }[] = [];
    const aggregates: ProfileAggregate[] = [];
    const projections: string[] = [`COUNT(*) AS ${dialect.QuoteColumnAlias(TOTAL_ROWS_ALIAS)}`];

    columns.forEach((column, index) => {
        const denial = nonAggregatableReason(column);
        if (denial) {
            skipped.push({ name: column.name, reason: denial });
            return;
        }

        const quoted = dialect.QuoteIdentifier(column.name);
        const emit = (kind: ProfileAggregateKind, expression: string): void => {
            const alias = `skip_c${index}_${kind.toLowerCase()}`;
            projections.push(`${expression} AS ${dialect.QuoteColumnAlias(alias)}`);
            aggregates.push({ alias, column: column.name, kind });
        };

        emit('distinct', `COUNT(DISTINCT ${quoted})`);
        emit('nulls', `SUM(CASE WHEN ${quoted} IS NULL THEN 1 ELSE 0 END)`);

        if (column.isNumeric) {
            emit('min', `MIN(${quoted})`);
            emit('max', `MAX(${quoted})`);
            emit('nonZero', `SUM(CASE WHEN ${quoted} IS NOT NULL AND ${quoted} <> 0 THEN 1 ELSE 0 END)`);
        }
    });

    if (aggregates.length === 0) return null;

    const sql = `${hoisted}\nSELECT\n    ${projections.join(',\n    ')}\nFROM ${dialect.QuoteIdentifier(PROFILE_CTE)}`;
    if (containsWriteStatement(sql, dialect)) return null;

    return { sql, totalRowsAlias: TOTAL_ROWS_ALIAS, aggregates, skipped };
}

/**
 * Refuses only on a *confident positive*: the SQL parsed, and what it parsed to
 * contains a write. A parse failure is not treated as unsafe.
 *
 * The asymmetry is the whole point, and it is the second attempt at this guard.
 *
 * The first version refused whenever `SQLCTEExtraction.UsedASTParsing` was
 * `false`. That flag reports which code path ran, not whether the split can be
 * trusted — and the regex path returns a correct split for shapes MJ's own
 * preprocessing handles. It fired on every bracket-quoted CTE name, which is
 * exactly what `RenderPipeline` emits when it resolves `{{query:"…"}}` into a
 * CTE named after the query, and on every CTE-headed query on PostgreSQL
 * (`extractCTEsViaAST` reads `cte.stmt.ast`, TransactSQL's shape). The
 * composition path — most real Skip queries — never profiled at all.
 *
 * The second version validated the *generated* SQL with `SQLParser.IsValid`.
 * That is no better: `IsValid` is `false` for plenty of valid T-SQL, including
 * `WITH [x] AS (SELECT a FROM t) SELECT COUNT(*) AS [n] FROM [x]`. Gating on it
 * blocked every TransactSQL profile.
 *
 * Both failures share one root cause: treating a parser limitation as a
 * correctness signal. `node-sql-parser` does not accept the full T-SQL/PG
 * grammar and never will, so "the parser could not read this" carries no
 * information about validity.
 *
 * The database is the only real authority on whether SQL is valid, and this
 * follows MJ's own precedent — `QueryPagingEngine.buildCountSQL` performs the
 * identical hoist and applies no validity gate whatsoever. A bad hoist makes
 * `ExecuteSQL` throw, `attachProfile` catches it, and the caller reports
 * `ProfileUnavailableReason: 'error'`. That degradation path already exists and
 * costs one failed read.
 *
 * Safety does not rest on this check: the base SQL already passed
 * `RenderPipeline.assertSafeToExecute` (the same `HasWriteStatement` scan) and
 * execution is on the read-only provider. This is defense in depth for the case
 * where the parser *does* understand the statement and sees a write in it.
 */
function containsWriteStatement(sql: string, dialect: SQLDialect): boolean {
    const parsed = new SQLParser(sql, dialect);
    return parsed.IsValid && parsed.HasWriteStatement;
}


/**
 * Produces the `WITH …` prefix that wraps the candidate query in a CTE the
 * profile can aggregate over, ending just before the outer `SELECT`.
 *
 * This is the piece most likely to break first, because Skip generates
 * CTE-headed SQL routinely and `WITH __skip_profile AS (WITH x AS …)` is a
 * syntax error on every platform. `SQLParser.ExtractCTEs` splits an existing
 * `WITH` list from its main statement so the candidate's own CTEs can be hoisted
 * to become *siblings* of the profile CTE rather than nested inside it.
 *
 * `MJ`'s `QueryPagingEngine.buildCountSQL` solves the identical problem and is
 * the reference shape; it is `private static`, so the structure is copied rather
 * than called.
 *
 * Two deliberate departures from `buildCountSQL`:
 *
 * - **An existing outer cap is kept.** `buildCountSQL` clears `TOP`/`LIMIT` so a
 *   count describes the full set. A profile should describe the result the
 *   candidate actually produces, so if the author wrote `SELECT TOP 100`, 100
 *   rows *is* the true result and the statistics should say so.
 * - **No parser round-trip on the body.** The body is emitted as-is apart from
 *   the `ORDER BY` decision, so `SQLParser.ToSQL()` never gets a chance to
 *   reformat SQL it did not fully understand.
 *
 * ## On `UsedASTParsing`
 *
 * `ExtractCTEs` reports `UsedASTParsing: false` far more often than "this
 * extraction is unreliable" would suggest — on every CTE-headed query on
 * PostgreSQL (`extractCTEsViaAST` reads `cte.stmt.ast`, TransactSQL's shape, and
 * abandons the AST path), and on any bracket-quoted CTE name, which is precisely
 * what composition emits. In both cases the returned split is correct and MJ's
 * own `buildCountSQL` uses it without complaint.
 *
 * So the flag is not consulted here. Safety comes from parsing the *generated*
 * SQL — see `isSafeGeneratedSQL`.
 */
function hoistIntoProfileCTE(baseSQL: string, dialect: SQLDialect): string | null {
    const cleaned = baseSQL.trimEnd().replace(/;\s*$/, '');
    if (cleaned.trim().length === 0) return null;

    // `UsedASTParsing` is deliberately not consulted. It reports which code path
    // ran, not whether the result can be trusted, and the regex path produces a
    // correct split for the shapes MJ's own preprocessing handles — including the
    // bracket-quoted CTE names that composition emits. The generated SQL is
    // validated by parsing it instead; see `isSafeGeneratedSQL`.
    const extraction = SQLParser.ExtractCTEs(cleaned, dialect);

    const mainStatement = extraction ? extraction.MainStatement : cleaned;
    const existingCTEs = extraction
        ? extraction.CTEDefinitions.map(def => quoteCTEName(def, dialect))
        : [];

    const body = stripUnneededOrderBy(mainStatement, dialect);
    const profileCTE = `${dialect.QuoteIdentifier(PROFILE_CTE)} AS (\n${body}\n)`;

    return `WITH ${[...existingCTEs, profileCTE].join(',\n')}`;
}

/** Trailing clauses that make the text after `ORDER BY` load-bearing rather than decorative. */
const ROW_SELECTING_TAIL = /\b(LIMIT|OFFSET|FETCH|FOR)\b/i;

/**
 * Removes a top-level `ORDER BY` from the profile body unless it changes which
 * rows the body returns.
 *
 * An aggregate over a set does not depend on the order of the set, so sorting is
 * pure waste — and on an uncapped result over a large join it is expensive
 * waste. SQL Server additionally rejects `ORDER BY` in a CTE body unless `TOP`,
 * `OFFSET` or `FOR XML` is present, so there it is often illegal as well.
 *
 * The sort must be kept whenever it *selects* rows rather than merely arranging
 * them: `SELECT TOP 10 … ORDER BY x DESC` returns a specific ten rows, and
 * dropping the sort would profile an arbitrary ten instead — describing a
 * different result than the caller was shown.
 *
 * Two MJ behaviours make this fiddlier than it looks, both verified at 5.51.0:
 *
 * - **`SqlWithoutOrderBy` is unusable on PostgreSQL.** `AnalyzeTopLevelOrderBy`
 *   returns the SQL *unchanged* whenever it decides the clause is legal in a
 *   CTE, and on PostgresQL `node-sql-parser` emits a `limit` node on every
 *   SELECT — present but empty — so `isOrderByLegalInCTE` answers `true`
 *   universally. The `Positions` array is produced by a dialect-independent
 *   scanner and is reliable, so the cut is made from that instead.
 * - **`OuterCap` does not see `OFFSET … FETCH`.** It reports `TOP` and `LIMIT`
 *   only, so a query paged with `OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY` would
 *   look uncapped, and truncating at the `ORDER BY` would silently drop the
 *   paging along with the sort. Hence the trailing-clause check.
 */
function stripUnneededOrderBy(sql: string, dialect: SQLDialect): string {
    const analysis = AnalyzeTopLevelOrderBy(sql, dialect);
    const cut = analysis.Positions[analysis.Positions.length - 1];
    if (cut == null) return sql;

    if (ROW_SELECTING_TAIL.test(sql.slice(cut))) return sql;

    const parsed = new SQLParser(sql, dialect);
    // Unparseable, or capped: leave the body alone. On SQL Server an illegal
    // ORDER BY then fails loudly at execution and the caller reports the profile
    // as unavailable, which beats guessing at a rewrite.
    if (!parsed.IsValid || parsed.OuterCap) return sql;

    return sql.slice(0, cut).trimEnd();
}

/**
 * `ExtractCTEs` returns definitions with unquoted names (`myName AS (…)`), which
 * breaks if a CTE is named after a reserved word and, on PostgreSQL, silently
 * changes case. Re-applies dialect quoting to the name only.
 *
 * Mirrors `QueryPagingEngine.quoteCteName`, which is `private static`.
 */
function quoteCTEName(cteDefinition: string, dialect: SQLDialect): string {
    const match = cteDefinition.match(/^(\[([^\]]+)\]|"([^"]+)"|([A-Za-z_]\w*))\s+AS\s*\(/i);
    if (!match) return cteDefinition;

    const bareName = match[2] ?? match[3] ?? match[4];
    if (!bareName) return cteDefinition;

    return dialect.QuoteIdentifier(bareName) + cteDefinition.substring(match[1].length);
}

/**
 * Returns why a column cannot be aggregated at all, or `null` when it can.
 * Only the metadata tier can answer this — a type learned from sampled JS values
 * cannot distinguish `nvarchar` from `ntext`.
 */
function nonAggregatableReason(column: ProfileColumn): string | null {
    if (column.typeSource !== 'metadata') return null;

    const normalized = column.type.toLowerCase().replace(/\(.*$/, '').trim();
    return NON_AGGREGATABLE_TYPES.has(normalized)
        ? `SQL type '${normalized}' cannot be aggregated with COUNT(DISTINCT)`
        : null;
}
