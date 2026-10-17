/**
 * One bounded attempt at the exact tier for an entity.
 *
 * - **Every statement is bounded at the database.** `timeoutMs` makes SQL Server
 *   and PostgreSQL cancel the statement, not just stop waiting, and
 *   `readOnlyTransaction` keeps it read-only (MJ 6.1.5+, the Open App's floor).
 * - **The attempt has a budget** ({@link PASS_BUDGET_MS}). No new statement starts
 *   once it is spent.
 * - **A timeout retries the same chunk with a 4× smaller sample**, down to the
 *   floor; a timeout at the floor gives up. A semi-join sample that fails for
 *   another reason (most likely no `SELECT` on the base table) retries once by
 *   key hash; any other error ends the attempt.
 * - **Finished chunks are kept.** A wide entity's pass that fails on chunk 3 of 5
 *   still returns exact statistics for the first two; the next attempt runs only
 *   what is missing.
 */

import { LogError, LogStatus, type DatabaseProviderBase, type UserInfo } from '@memberjunction/core';
import type { SQLDialect } from '@memberjunction/sql-dialect';
import type { ProfiledColumn } from './entityColumns.js';
import { BuildCardinalityStatements, BuildExtremesStatement, BuildMainStatements, ChunkColumns, ROWS_ALIAS, SampleFraction, type ProfileDialectName, type ProfileSource } from './profileSQL.js';
import { HashInstead, SampleAfterTimeout, type SampleSpec } from './samplingPolicy.js';
import { ClassifyFailure, type FailureKind } from './failurePolicy.js';
import { ApplyCardinalityRow, ApplyExtremesRow, DateBoundsOf, ReadMainRow, type ExactColumn, type ExactRowCount } from './readProfile.js';

/** Below MJAPI's common 30 s `requestTimeout`, so the profiler's own limit is the one that fires. */
export const STATEMENT_TIMEOUT_MS = 20_000;
export const PASS_BUDGET_MS = 60_000;
/** The most of the pass budget the optional cardinality statements may use. */
export const CARDINALITY_BUDGET_MS = 20_000;
/** A statement is not started with less budget than this left. */
const MIN_STATEMENT_MS = 1_000;

export interface PassTarget {
    EntityName: string;
    Source: ProfileSource;
    /** Every profiled column, in the order aliases are numbered by. */
    Columns: ProfiledColumn[];
    Dialect: SQLDialect;
    DialectName: ProfileDialectName;
    Provider: DatabaseProviderBase;
    User: UserInfo;
}

export interface PassInput {
    /** Columns still without exact statistics. */
    Pending: ProfiledColumn[];
    /** The sample to start with; null for a full scan. */
    Sample: SampleSpec | null;
    /** Row estimate, for the sample floor. */
    Rows: number | null;
    /** Overrides for tests and failure injection. */
    StatementTimeoutMs?: number;
    BudgetMs?: number;
}

export type PassFailureKind = FailureKind | 'budget';

export interface PassOutcome {
    Exact: ExactColumn[];
    RowCount: ExactRowCount | null;
    Failure: { Kind: PassFailureKind; Message: string } | null;
    /** True when the attempt timed out at the floor sample. */
    GaveUp: boolean;
    /** The sample the next attempt should start from. */
    NextSample: SampleSpec | null;
}

export async function RunExactPass(target: PassTarget, input: PassInput): Promise<PassOutcome> {
    const deadline = Date.now() + (input.BudgetMs ?? PASS_BUDGET_MS);
    const statementTimeout = input.StatementTimeoutMs ?? STATEMENT_TIMEOUT_MS;
    const outcome: PassOutcome = { Exact: [], RowCount: null, Failure: null, GaveUp: false, NextSample: input.Sample };
    const queue = ChunkColumns(input.Pending);
    let sample = input.Sample;
    let triedHash = false;
    while (queue.length > 0) {
        const remaining = deadline - Date.now();
        if (remaining < MIN_STATEMENT_MS) {
            outcome.Failure = { Kind: 'budget', Message: `pass budget spent with ${queue.length} chunk(s) left` };
            break;
        }
        const chunk = queue[0];
        const [statement] = BuildMainStatements(target.Source, chunk, target.Columns, target.Dialect, target.DialectName, sample);
        try {
            const row = await runStatement(target, statement.SQL, Math.min(statementTimeout, remaining));
            outcome.Exact.push(...ReadMainRow(row, chunk, target.Columns, sample));
            outcome.RowCount = betterRowCount(outcome.RowCount, row, sample);
            queue.shift();
        } catch (error: unknown) {
            const kind = ClassifyFailure(error);
            const retry = kind === 'timeout'
                ? timeoutRetry(target, sample, input.Rows)
                : errorRetry(target, sample, triedHash, error);
            if (retry) {
                triedHash ||= kind === 'error';
                sample = retry;
                continue;
            }
            outcome.Failure = { Kind: kind, Message: describe(error) };
            outcome.GaveUp = kind === 'timeout';
            break;
        }
    }
    outcome.NextSample = sample;
    // The optional statements run only after a clean main pass: one that failed is not given more work.
    if (!outcome.Failure) {
        await addExtremes(target, outcome, sample, deadline, statementTimeout);
        await addCardinality(target, outcome, sample, Math.min(deadline, Date.now() + CARDINALITY_BUDGET_MS), statementTimeout);
    }
    return outcome;
}

function timeoutRetry(target: PassTarget, sample: SampleSpec | null, rows: number | null): SampleSpec | null {
    const retry = SampleAfterTimeout(sample, rows, target.Source.PrimaryKeys);
    LogStatus(`ProfileEntityFields: ${target.EntityName} timed out at ${describeSample(sample)}`
        + (retry ? `; retrying at ${describeSample(retry)}` : '; giving up until the next attempt'));
    return retry;
}

function errorRetry(target: PassTarget, sample: SampleSpec | null, triedHash: boolean, error: unknown): SampleSpec | null {
    LogError(`ProfileEntityFields: ${target.EntityName} failed at ${describeSample(sample)} — ${describe(error)}`);
    return sample?.Method === 'semi' && !triedHash ? HashInstead(sample) : null;
}

/**
 * Counts rows at each date column's bounds. Optional: a failure or a spent
 * budget only leaves `ExtremeShare` out.
 */
async function addExtremes(target: PassTarget, outcome: PassOutcome, sample: SampleSpec | null, deadline: number,
    statementTimeout: number): Promise<void> {
    const bounds = DateBoundsOf(outcome.Exact, target.Columns);
    const statement = BuildExtremesStatement(target.Source, bounds, target.Columns, target.Dialect, target.DialectName, sample);
    const remaining = deadline - Date.now();
    if (!statement || remaining < MIN_STATEMENT_MS) return;
    try {
        const row = await runStatement(target, statement.SQL, Math.min(statementTimeout, remaining));
        ApplyExtremesRow(row, bounds, target.Columns, new Map(outcome.Exact.map(e => [e.Column.Name, e])));
    } catch (error: unknown) {
        LogStatus(`ProfileEntityFields: date extremes skipped for ${target.EntityName} — ${describe(error)}`);
    }
}

/**
 * Approximate distinct counts for the columns this attempt profiled (SQL Server; PostgreSQL's
 * come free from `pg_stats`). Optional, like the extremes: it stops at its own budget or the
 * first failure, and a very wide entity may leave its lowest-priority columns without one.
 */
async function addCardinality(target: PassTarget, outcome: PassOutcome, sample: SampleSpec | null, deadline: number,
    statementTimeout: number): Promise<void> {
    const profiled = new Map(outcome.Exact.map(e => [e.Column.Name, e]));
    const columns = target.Columns.filter(c => profiled.has(c.Name));
    const fraction = sample ? SampleFraction(sample) : 1;
    let lastMs = 0;
    for (const statement of BuildCardinalityStatements(target.Source, columns, target.Columns, target.Dialect, target.DialectName, sample)) {
        const remaining = deadline - Date.now();
        // Statements cost about the same; one that cannot finish in what is left would only be cancelled.
        if (remaining < Math.max(MIN_STATEMENT_MS, lastMs * 1.5)) return;
        const started = Date.now();
        try {
            const row = await runStatement(target, statement.SQL, Math.min(statementTimeout, remaining));
            ApplyCardinalityRow(row, statement.Columns, target.Columns, profiled, sample, fraction);
            lastMs = Date.now() - started;
        } catch (error: unknown) {
            LogStatus(`ProfileEntityFields: cardinality stopped for ${target.EntityName} — ${describe(error)}`);
            return;
        }
    }
}

async function runStatement(target: PassTarget, sql: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const rows = await target.Provider.ExecuteSQL<Record<string, unknown>>(sql, undefined, {
        description: `ProfileEntityFields: ${target.EntityName}`,
        ignoreLogging: true,
        readOnlyTransaction: true,
        timeoutMs,
    }, target.User);
    return rows?.[0] ?? {};
}

/** A full scan's count is exact; a sample's is scaled. The first count stands unless an exact one arrives. */
function betterRowCount(current: ExactRowCount | null, row: Record<string, unknown>, sample: SampleSpec | null): ExactRowCount | null {
    const counted = Number(row[ROWS_ALIAS] ?? NaN);
    if (!Number.isFinite(counted)) return current;
    if (!sample) return { Count: counted, Source: 'exact' };
    if (current?.Source === 'exact') return current;
    return { Count: Math.round(counted / SampleFraction(sample)), Source: 'estimate' };
}

function describeSample(sample: SampleSpec | null): string {
    return sample ? `a ${sample.Percent}% ${sample.Method} sample` : 'a full scan';
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
