/**
 * @fileoverview Unit tests for profile SQL generation.
 *
 * `buildProfileSQL` is pure by design precisely so the
 * riskiest part of this feature — rewriting someone else's SQL — can be pinned
 * down without a database. Three things are being defended.
 *
 * **CTE hoisting.** `WITH __skip_profile AS (<candidate>)` is a syntax error on
 * every platform whenever the candidate already begins with `WITH`, and Skip
 * generates CTE-headed SQL routinely. The candidate's own CTEs must become
 * siblings of the profile CTE, never its children.
 *
 * **Both dialects.** A T-SQL-only suite would pass indefinitely while the
 * PostgreSQL path stayed broken, and PostgreSQL clients are on the roadmap.
 * Every structural assertion that can run on both, does.
 *
 * **The ORDER BY decision.** Sorting an uncapped result to compute aggregates is
 * expensive waste, but stripping the sort from a *capped* query changes which
 * rows are described. Both directions are asserted.
 */

import { describe, it, expect } from 'vitest';
import { GetDialect } from '@memberjunction/sql-dialect';
import { buildProfileSQL } from '../../src/resolvers/profile/buildProfileSQL.js';
import type { ProfileColumn } from '../../src/resolvers/profile/columnTypes.js';
import { getPrivacyPolicy } from '../../src/resolvers/profile/privacyPolicy.js';

const POLICY = getPrivacyPolicy();
const SQLSERVER = { name: 'TransactSQL', dialect: GetDialect('sqlserver'), open: '[', close: ']' } as const;
const POSTGRES = { name: 'PostgreSQL', dialect: GetDialect('postgresql'), open: '"', close: '"' } as const;
const DIALECTS = [SQLSERVER, POSTGRES] as const;

function column(name: string, overrides: Partial<ProfileColumn> = {}): ProfileColumn {
    return {
        name,
        type: 'int',
        isNumeric: true,
        isString: false,
        typeSource: 'metadata',
        ...overrides,
    };
}

const PLAIN_SQL = 'SELECT e.EmployeeID, COUNT(cl.ID) AS CompletionCount FROM vwEmployees e GROUP BY e.EmployeeID';

const CTE_SQL = `WITH completed AS (
    SELECT EmployeeID, COUNT(*) AS Total FROM vwNeoGovLearns WHERE Status = 'Complete' GROUP BY EmployeeID
)
SELECT e.EmployeeID, c.Total FROM vwEmployees e LEFT JOIN completed c ON c.EmployeeID = e.EmployeeID`;

/** Counts top-level `WITH` keywords. More than one means a nested CTE — the syntax error this all guards against. */
function countWith(sql: string): number {
    return sql.match(/\bWITH\b/gi)?.length ?? 0;
}

describe.each(DIALECTS)('buildProfileSQL — $name', ({ dialect, open, close }) => {
    const q = (name: string) => `${open}${name}${close}`;

    it('wraps a plain SELECT in a single profile CTE', () => {
        const plan = buildProfileSQL(PLAIN_SQL, [column('EmployeeID')], POLICY, dialect);

        expect(plan).not.toBeNull();
        expect(plan!.sql).toContain(`WITH ${q('__skip_profile')} AS (`);
        expect(plan!.sql).toContain(`FROM ${q('__skip_profile')}`);
        expect(countWith(plan!.sql)).toBe(1);
    });

    it('emits distinct and null counts for every column, numeric aggregates only for numeric ones', () => {
        const columns = [
            column('CompletionCount'),
            column('Occupation', { type: 'nvarchar', isNumeric: false, isString: true }),
        ];
        const plan = buildProfileSQL(PLAIN_SQL, columns, POLICY, dialect)!;

        const kinds = (name: string) => plan.aggregates.filter(a => a.column === name).map(a => a.kind).sort();
        expect(kinds('CompletionCount')).toEqual(['distinct', 'max', 'min', 'nonZero', 'nulls']);
        expect(kinds('Occupation')).toEqual(['distinct', 'nulls']);

        expect(plan.sql).toContain(`COUNT(DISTINCT ${q('Occupation')})`);
        expect(plan.sql).toContain(`MIN(${q('CompletionCount')})`);
        // No MIN/MAX against a text column — that is invalid SQL, and it would
        // sink the entire profile rather than just that one column.
        expect(plan.sql).not.toContain(`MIN(${q('Occupation')})`);
    });

    it('quotes every identifier through the dialect, never as a string literal', () => {
        const plan = buildProfileSQL(PLAIN_SQL, [column('Employee ID')], POLICY, dialect)!;
        // A column name with a space only survives if it went through QuoteIdentifier.
        expect(plan.sql).toContain(q('Employee ID'));
    });

    it('strips a top-level ORDER BY when there is no cap — aggregates do not need a sort', () => {
        const plan = buildProfileSQL(`${PLAIN_SQL} ORDER BY CompletionCount DESC`, [column('EmployeeID')], POLICY, dialect)!;
        expect(plan.sql).not.toMatch(/ORDER\s+BY/i);
    });

    it('reports non-aggregatable metadata types as skipped instead of emitting invalid SQL', () => {
        const columns = [
            column('Notes', { type: 'ntext', isNumeric: false, isString: true }),
            column('EmployeeID'),
        ];
        const plan = buildProfileSQL(PLAIN_SQL, columns, POLICY, dialect)!;

        expect(plan.aggregates.some(a => a.column === 'Notes')).toBe(false);
        expect(plan.skipped).toEqual([
            { name: 'Notes', reason: expect.stringContaining('ntext') },
        ]);
    });

    it('refuses to rewrite empty SQL', () => {
        expect(buildProfileSQL('   ', [column('X')], POLICY, dialect)).toBeNull();
    });
});

describe('buildProfileSQL — CTE hoisting (TransactSQL)', () => {
    const { dialect } = SQLSERVER;
    const q = (name: string) => `[${name}]`;

    it('hoists an existing CTE as a sibling rather than nesting it', () => {
        const plan = buildProfileSQL(CTE_SQL, [column('EmployeeID')], POLICY, dialect);
        expect(plan).not.toBeNull();

        // Exactly one WITH, at the very start. A nested WITH is the syntax error
        // this whole code path exists to avoid, so assert on the count rather
        // than merely on the prefix.
        expect(countWith(plan!.sql)).toBe(1);
        expect(plan!.sql.trimStart().toUpperCase().startsWith('WITH ')).toBe(true);

        // The candidate's CTE is quoted and sits before the profile CTE in the
        // same comma-separated list.
        const userCTE = plan!.sql.indexOf(`${q('completed')} AS (`);
        const profileCTE = plan!.sql.indexOf(`${q('__skip_profile')} AS (`);
        expect(userCTE).toBeGreaterThan(-1);
        expect(profileCTE).toBeGreaterThan(userCTE);

        // The profile CTE body is the main statement, and it still references
        // the hoisted CTE.
        const body = plan!.sql.slice(profileCTE);
        expect(body).not.toMatch(/\bWITH\b/i);
        expect(body).toMatch(/LEFT JOIN \[completed\]/i);
    });

    it('keeps ORDER BY when a cap is present — the sort selects which rows the result contains', () => {
        const capped = 'SELECT TOP 10 EmployeeID, Total FROM vwEmployees ORDER BY Total DESC';
        const plan = buildProfileSQL(capped, [column('Total')], POLICY, dialect)!;

        expect(plan.sql).toMatch(/ORDER\s+BY/i);
        expect(plan.sql).toMatch(/TOP\s*\(?\s*10/i);
    });
});

/**
 * `SQLParser.OuterCap` reports `TOP` and `LIMIT` but not `OFFSET … FETCH`
 * (verified at MJ 5.51.0), so a paged query looks uncapped. Cutting at the
 * `ORDER BY` would then drop the paging clause along with the sort and profile
 * a different set of rows than the caller was shown.
 */
describe.each(DIALECTS)('buildProfileSQL — paged tails ($name)', ({ dialect }) => {
    const paged = dialect.PlatformKey === 'sqlserver'
        ? 'SELECT EmployeeID FROM vwEmployees ORDER BY EmployeeID OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY'
        : 'SELECT EmployeeID FROM vwEmployees ORDER BY EmployeeID LIMIT 10 OFFSET 0';

    it('keeps a sort that a paging clause depends on', () => {
        const plan = buildProfileSQL(paged, [column('EmployeeID')], POLICY, dialect)!;

        expect(plan.sql).toMatch(/ORDER\s+BY/i);
        expect(plan.sql).toMatch(/OFFSET/i);
    });
});

/**
 * PostgreSQL cannot hoist CTEs at MJ 5.51.0 — `SQLParser.ExtractCTEs` always
 * lands on its regex fallback there, because `extractCTEsViaAST` reads a CTE
 * body from `cte.stmt.ast`, which is the TransactSQL shape; on PostgresQL
 * `node-sql-parser` puts it at `cte.stmt`.
 *
 * The guard refuses a regex extraction rather than rewriting SQL on a guess, so
 * the result is a clean refusal. This test exists so the day MJ fixes the AST
 * path, the change in behaviour is noticed here rather than in production.
 */
describe('buildProfileSQL — shapes where ExtractCTEs falls back to regex', () => {
    // `SQLCTEExtraction.UsedASTParsing` reports which code path ran, not whether
    // the split is trustworthy. An earlier guard refused whenever it was false,
    // which silently disabled profiling for the two shapes below — the second of
    // which is the majority of real Skip queries. Both must profile.

    it('profiles a CTE-headed query on PostgreSQL', () => {
        // `extractCTEsViaAST` reads `cte.stmt.ast` (TransactSQL's shape), so the
        // AST path is abandoned for every CTE-headed query on PostgreSQL.
        const plan = buildProfileSQL(CTE_SQL, [column('EmployeeID')], POLICY, POSTGRES.dialect);
        expect(plan).not.toBeNull();
        expect(countWith(plan!.sql)).toBe(1);
    });

    describe.each(DIALECTS)('bracket-quoted CTE name — $name', ({ dialect, open, close }) => {
        // What RenderPipeline emits for `SELECT * FROM {{query:"Some/Path/Query Name"}}`:
        // the composition CTE is named after the query, so it contains spaces and
        // is quoted. node-sql-parser cannot parse this; MJ's preprocessing can.
        const composed =
            `WITH ${open}Claim Prior Training Status${close} AS (\n`
            + `SELECT EmployeeID, CompletionCount FROM vwNeoGovLearns\n`
            + `)\nSELECT EmployeeID, CompletionCount FROM ${open}Claim Prior Training Status${close}`;

        it('profiles rather than refusing', () => {
            const plan = buildProfileSQL(
                composed,
                [column('EmployeeID'), column('CompletionCount', { isNumeric: true })],
                POLICY,
                dialect,
            );
            expect(plan).not.toBeNull();
            expect(countWith(plan!.sql)).toBe(1);
            expect(plan!.sql.trimStart().toUpperCase().startsWith('WITH ')).toBe(true);

            // The composition CTE is hoisted as a sibling, not nested.
            const userCTE = plan!.sql.indexOf(`${open}Claim Prior Training Status${close} AS (`);
            const profileCTE = plan!.sql.indexOf(`${open}__skip_profile${close} AS (`);
            expect(userCTE).toBeGreaterThan(-1);
            expect(profileCTE).toBeGreaterThan(userCTE);
            expect(plan!.sql.slice(profileCTE)).not.toMatch(/\bWITH\b/i);

            // The numeric tier survives — this is the statistic test 23 needed.
            expect(plan!.aggregates.some(a => a.kind === 'nonZero')).toBe(true);
        });
    });

    it('does not gate on parseability — the database is the authority', () => {
        // Deliberately not refused here. `node-sql-parser` rejects plenty of
        // valid T-SQL, so "the parser could not read it" says nothing about
        // validity. If the hoist really is malformed, ExecuteSQL throws and the
        // caller degrades to ProfileUnavailableReason: 'error'.
        const exotic = 'SELECT EmployeeID, TRY_CAST(Total AS FLOAT) AS Total FROM vwEmployees';
        expect(buildProfileSQL(exotic, [column('EmployeeID')], POLICY, SQLSERVER.dialect)).not.toBeNull();
    });
});

/**
 * The invariant that replaced R2/R3.
 *
 * Literal-value disclosure was removed entirely once MJ's own `EntityFieldValue`
 * path (CHECK constraints + DBAutoDoc enum detection, shipped to Skip by
 * `SkipSDK.packFieldValues`) was found to answer the same question better. With
 * the domain pass gone there is no code path by which a row value can reach the
 * response, so this asserts the property directly rather than trusting that the
 * gates which used to enforce it are still correct.
 */
describe.each(DIALECTS)('buildProfileSQL — emits no row values ($name)', ({ dialect }) => {
    it('projects only counts, ratios and numeric bounds', () => {
        const columns = [
            column('EmployeeID'),
            column('Status', { type: 'nvarchar', isNumeric: false, isString: true }),
            column('CompletionCount'),
        ];
        const plan = buildProfileSQL(PLAIN_SQL, columns, POLICY, dialect)!;

        // Every emitted aggregate is one of the five statistic kinds. Anything
        // else would mean a column expression reached the projection unwrapped.
        for (const aggregate of plan.aggregates) {
            expect(['distinct', 'nulls', 'min', 'max', 'nonZero']).toContain(aggregate.kind);
        }

        // Assert on the outer projection only. The candidate query is hoisted
        // verbatim into the profile CTE and may legitimately contain GROUP BY —
        // PLAIN_SQL does. What matters is that the *generated* outer SELECT adds
        // no grouping of its own: a GROUP BY over a column, unioned per column,
        // was precisely the shape by which the domain pass returned literals.
        const outer = plan.sql.slice(plan.sql.lastIndexOf('\nSELECT\n'));
        expect(outer).not.toMatch(/GROUP\s+BY/i);
        expect(outer).not.toMatch(/UNION/i);
        expect(outer).not.toMatch(/HAVING/i);
    });
});
