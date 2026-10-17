/**
 * Computes, caches and refreshes entity profiles in this MJAPI process.
 *
 * - **On demand, never at startup.** A Data Expert run touches a handful of
 *   entities; profiling every table at boot would cost minutes per replica.
 * - **Two tiers.** A cache miss answers at once from the database's own
 *   statistics ({@link dbStatistics}) and starts the exact pass
 *   ({@link exactPass}); the caller waits for it up to its budget, and a slower
 *   pass fills the cache for the next caller.
 * - **Failures back off** (5 min → 24 h, {@link failurePolicy}) and are reported
 *   as `ExactStatus` / `RetryAfter`, so Skip can stop waiting for a pass that will
 *   not come. Nothing here throws to the resolver for a database reason.
 * - **Refreshes.** Free signals are checked at most every 5 minutes per entity on
 *   request ({@link refreshPolicy}), and a timer recomputes entries a week old,
 *   one at a time with jitter, so no burst of scans reaches the database. Old
 *   statistics are served while a refresh runs.
 * - **At most {@link MAX_CONCURRENT_PASSES} exact passes run at once** per process.
 *
 * The cache is per process (about 200 bytes per column; all of a large client's
 * AI-visible columns fit in a few MB). Each replica computes its own entries, and
 * a restart empties it.
 */

import { LogError, type DatabasePlatform, type EntityInfo, type UserInfo } from '@memberjunction/core';
import type { DatabaseProviderBase } from '@memberjunction/core';
import { GetDialect } from '@memberjunction/sql-dialect';
import type { EntityProfile, EntityProfileExactStatus } from '@askskip/types';
import { PrimaryKeyNames, ProfiledColumns, SchemaSignature } from './entityColumns.js';
import type { ProfileDialectName } from './profileSQL.js';
import {
    ColumnStatisticsSQL, ReadColumnStatistics, ReadTableStatistics, TableStatisticsSQL,
    type ColumnStatistic, type ColumnStatisticRow, type TableStatistics,
} from './dbStatistics.js';
import { CHECK_INTERVAL_MS, MAX_AGE_MS, RefreshReasonFor, type FreshnessSample } from './refreshPolicy.js';
import { RunExactPass, type PassOutcome, type PassTarget } from './exactPass.js';
import { ChooseSample, type SampleSpec } from './samplingPolicy.js';
import { BackoffMs } from './failurePolicy.js';
import { AssembleProfile, type ExactColumn, type ExactRowCount } from './readProfile.js';

const MAX_CACHED_ENTITIES = 5_000;
export const MAX_CONCURRENT_PASSES = 2;
const CATALOG_TIMEOUT_MS = 5_000;
/** A first request waits at least this long for the database's own statistics. */
const MIN_CATALOG_WAIT_MS = 500;
const TIMER_INTERVAL_MS = 60 * 60 * 1000;
const TIMER_JITTER_MS = 60 * 1000;

interface CacheEntry {
    Target: PassTarget;
    Signature: string;
    Table: TableStatistics;
    DbStatistics: Map<string, ColumnStatistic>;
    /** The statistics served. */
    Exact: Map<string, ExactColumn>;
    /** A refresh in progress: its results overlay `Exact` and replace it once complete. */
    Refresh: Map<string, ExactColumn> | null;
    RowCount: ExactRowCount | null;
    /** When the served exact statistics were completed (tier-0 time until then). */
    ComputedAtMs: number;
    /** When the current cycle (first computation or refresh) started; the timer starts one a week. */
    CycleStartedAtMs: number;
    Baseline: FreshnessSample;
    LastCheckMs: number;
    Status: EntityProfileExactStatus;
    FailedAttempts: number;
    NextAttemptAtMs: number | null;
    /** The sample the next attempt starts from; undefined = decide from the cost model. */
    NextSample: SampleSpec | null | undefined;
    ExactInFlight?: Promise<void>;
}

/** Runs at most `limit` tasks at once, in arrival order. */
class PassLimiter {
    private active = 0;
    private readonly waiting: Array<() => void> = [];

    constructor(private readonly limit: number) {}

    public async Run<T>(task: () => Promise<T>): Promise<T> {
        if (this.active >= this.limit) await new Promise<void>(resolve => this.waiting.push(resolve));
        this.active += 1;
        try {
            return await task();
        } finally {
            this.active -= 1;
            this.waiting.shift()?.();
        }
    }
}

export class EntityProfileService {
    private static readonly cache = new Map<string, CacheEntry>();
    /** Misses whose database statistics are being read, so concurrent callers share one read. */
    private static readonly starting = new Map<string, Promise<CacheEntry>>();
    private static readonly limiter = new PassLimiter(MAX_CONCURRENT_PASSES);
    private static timer: ReturnType<typeof setInterval> | null = null;
    private static timerRunning = false;

    /** Returns the best profile available within `waitMs`, starting computation, a retry or a refresh as needed. */
    public static async GetProfile(entity: EntityInfo, provider: DatabaseProviderBase, user: UserInfo, waitMs: number): Promise<EntityProfile> {
        EntityProfileService.ensureTimer();
        const target = EntityProfileService.targetFor(entity, provider, user);
        const key = `${target.DialectName}:${entity.SchemaName}.${entity.BaseTable}`.toLowerCase();
        const deadline = Date.now() + waitMs;
        const cached = EntityProfileService.cache.get(key);
        let entry: CacheEntry | null;
        if (!cached || cached.Signature !== SchemaSignature(target.Columns)) {
            // The catalog reads are normally milliseconds, but wait behind locks; they must not hold the caller past its wait.
            entry = await within(EntityProfileService.startOnce(key, target), Math.max(waitMs, MIN_CATALOG_WAIT_MS));
            if (!entry) return EntityProfileService.placeholderProfile(target);
        } else {
            entry = cached;
            entry.Target = target;
            EntityProfileService.maybeStart(entry);
        }
        await waitFor(entry.ExactInFlight, Math.max(0, deadline - Date.now()));
        return EntityProfileService.profileOf(entry);
    }

    /** Test seam: forget every cached profile and stop the timer. */
    public static ClearCache(): void {
        EntityProfileService.cache.clear();
        EntityProfileService.starting.clear();
        if (EntityProfileService.timer) clearInterval(EntityProfileService.timer);
        EntityProfileService.timer = null;
    }

    /** Test seam: run the weekly sweep now. */
    public static async RunRefreshSweep(jitterMs = TIMER_JITTER_MS): Promise<void> {
        await EntityProfileService.sweep(jitterMs);
    }

    private static targetFor(entity: EntityInfo, provider: DatabaseProviderBase, user: UserInfo): PassTarget {
        const platform = provider.PlatformKey as DatabasePlatform;
        const dialectName: ProfileDialectName = platform;
        return {
            EntityName: entity.Name,
            Source: { Schema: entity.SchemaName, View: entity.BaseView, BaseTable: entity.BaseTable, PrimaryKeys: PrimaryKeyNames(entity) },
            Columns: ProfiledColumns(entity),
            Dialect: GetDialect(platform), DialectName: dialectName, Provider: provider, User: user,
        };
    }

    private static startOnce(key: string, target: PassTarget): Promise<CacheEntry> {
        const pending = EntityProfileService.starting.get(key);
        if (pending) return pending;
        const started = EntityProfileService.startEntry(key, target)
            .finally(() => EntityProfileService.starting.delete(key));
        EntityProfileService.starting.set(key, started);
        return started;
    }

    /** Nothing known yet: the database statistics are still being read. */
    private static placeholderProfile(target: PassTarget): EntityProfile {
        return AssembleProfile({
            EntityName: target.EntityName, Columns: target.Columns, Exact: new Map(), DbStatistics: new Map(),
            Table: { Rows: null, RowsExact: false, ChangeCounter: null, Bytes: null }, RowCount: null,
            ComputedAtMs: Date.now(), ExactStatus: 'pending', NextAttemptAtMs: null, Stale: false,
        });
    }

    /** A miss or a schema change: answer from database statistics now, and start the exact pass. */
    private static async startEntry(key: string, target: PassTarget): Promise<CacheEntry> {
        const [table, statistics] = await Promise.all([readTableStatistics(target), readColumnStatistics(target)]);
        const now = Date.now();
        const entry: CacheEntry = {
            Target: target, Signature: SchemaSignature(target.Columns), Table: table, DbStatistics: statistics,
            Exact: new Map(), Refresh: null, RowCount: null,
            ComputedAtMs: now, CycleStartedAtMs: now,
            Baseline: { Rows: table.Rows, ChangeCounter: table.ChangeCounter }, LastCheckMs: now,
            Status: 'pending', FailedAttempts: 0, NextAttemptAtMs: null, NextSample: undefined,
        };
        EntityProfileService.store(key, entry);
        EntityProfileService.startAttempt(entry);
        return entry;
    }

    private static maybeStart(entry: CacheEntry): void {
        if (entry.ExactInFlight) return;
        const now = Date.now();
        if (entry.Status !== 'complete') {
            if (now >= (entry.NextAttemptAtMs ?? 0)) EntityProfileService.startAttempt(entry);
            return;
        }
        if (now - entry.LastCheckMs >= CHECK_INTERVAL_MS) {
            entry.LastCheckMs = now;
            void EntityProfileService.checkFreshness(entry);
        }
    }

    private static startAttempt(entry: CacheEntry): void {
        if (entry.ExactInFlight) return;
        entry.ExactInFlight = EntityProfileService.limiter.Run(() => EntityProfileService.attempt(entry))
            .catch((error: unknown) => LogError(`ProfileEntityFields: exact pass failed for ${entry.Target.EntityName} — ${describe(error)}`))
            .finally(() => { entry.ExactInFlight = undefined; });
    }

    /** Starts a new cycle over every column, serving the old statistics until it completes. */
    private static startRefresh(entry: CacheEntry): void {
        if (entry.ExactInFlight) return;
        const cycle: Partial<CacheEntry> = {
            Refresh: new Map(), CycleStartedAtMs: Date.now(), Status: 'pending',
            FailedAttempts: 0, NextAttemptAtMs: null, NextSample: undefined,
        };
        Object.assign(entry, cycle);
        EntityProfileService.startAttempt(entry);
    }

    private static async attempt(entry: CacheEntry): Promise<void> {
        entry.Table = await readTableStatistics(entry.Target);
        const cycle = entry.Refresh ?? entry.Exact;
        const pending = entry.Target.Columns.filter(c => !cycle.has(c.Name));
        const sample = entry.NextSample !== undefined
            ? entry.NextSample
            : ChooseSample(entry.Table.Rows, entry.Target.Columns, entry.Target.Source.PrimaryKeys, entry.Target.DialectName, entry.Table.Bytes);
        const outcome = await RunExactPass(entry.Target, { Pending: pending, Sample: sample, Rows: entry.Table.Rows });
        for (const column of outcome.Exact) cycle.set(column.Column.Name, column);
        if (outcome.RowCount) entry.RowCount = outcome.RowCount;
        EntityProfileService.recordOutcome(entry, outcome);
    }

    private static recordOutcome(entry: CacheEntry, outcome: PassOutcome): void {
        const now = Date.now();
        if (!outcome.Failure) {
            const complete: Partial<CacheEntry> = {
                Exact: entry.Refresh ?? entry.Exact, Refresh: null,
                Status: 'complete', FailedAttempts: 0, NextAttemptAtMs: null, NextSample: undefined,
                ComputedAtMs: now, LastCheckMs: now,
                Baseline: { Rows: entry.Table.Rows, ChangeCounter: entry.Table.ChangeCounter },
            };
            Object.assign(entry, complete);
            return;
        }
        entry.FailedAttempts += 1;
        entry.NextAttemptAtMs = now + BackoffMs(entry.FailedAttempts);
        entry.NextSample = outcome.NextSample;
        entry.Status = outcome.GaveUp ? 'gave-up-timeout' : outcome.Failure.Kind === 'error' ? 'failed-error' : 'pending';
    }

    private static async checkFreshness(entry: CacheEntry): Promise<void> {
        const table = await readTableStatistics(entry.Target);
        const reason = RefreshReasonFor({
            AgeMs: Date.now() - entry.ComputedAtMs, SchemaChanged: false,
            Baseline: entry.Baseline, Current: { Rows: table.Rows, ChangeCounter: table.ChangeCounter },
        });
        if (reason) EntityProfileService.startRefresh(entry);
    }

    private static profileOf(entry: CacheEntry): EntityProfile {
        const served = entry.Refresh ? new Map([...entry.Exact, ...entry.Refresh]) : entry.Exact;
        return AssembleProfile({
            EntityName: entry.Target.EntityName, Columns: entry.Target.Columns, Exact: served,
            DbStatistics: entry.DbStatistics, Table: entry.Table, RowCount: entry.RowCount,
            ComputedAtMs: entry.ComputedAtMs, ExactStatus: entry.Status, NextAttemptAtMs: entry.NextAttemptAtMs,
            Stale: entry.Refresh !== null,
        });
    }

    private static ensureTimer(): void {
        if (EntityProfileService.timer) return;
        EntityProfileService.timer = setInterval(() => { void EntityProfileService.sweep(TIMER_JITTER_MS); }, TIMER_INTERVAL_MS);
        EntityProfileService.timer.unref?.();
    }

    /** Refreshes entries whose cycle is a week old, one at a time, pausing a random interval between them. */
    private static async sweep(jitterMs: number): Promise<void> {
        if (EntityProfileService.timerRunning) return;
        EntityProfileService.timerRunning = true;
        try {
            const due = [...EntityProfileService.cache.values()].filter(e => !e.ExactInFlight && Date.now() - e.CycleStartedAtMs >= MAX_AGE_MS);
            for (const entry of due) {
                EntityProfileService.startRefresh(entry);
                await entry.ExactInFlight;
                if (jitterMs > 0) await delay(Math.random() * jitterMs);
            }
        } finally {
            EntityProfileService.timerRunning = false;
        }
    }

    private static store(key: string, entry: CacheEntry): void {
        EntityProfileService.cache.delete(key);
        EntityProfileService.cache.set(key, entry);
        if (EntityProfileService.cache.size > MAX_CACHED_ENTITIES) {
            const oldest = EntityProfileService.cache.keys().next().value;
            if (oldest !== undefined) EntityProfileService.cache.delete(oldest);
        }
    }
}

async function readTableStatistics(target: PassTarget): Promise<TableStatistics> {
    try {
        const rows = await target.Provider.ExecuteSQL<Record<string, unknown>>(
            TableStatisticsSQL(target.Source.Schema, target.Source.BaseTable, target.Dialect, target.DialectName),
            undefined, catalogOptions('table statistics'), target.User);
        return ReadTableStatistics(rows?.[0], target.DialectName);
    } catch (error: unknown) {
        LogError(`ProfileEntityFields: table statistics unavailable for ${target.EntityName} — ${describe(error)}`);
        return { Rows: null, RowsExact: false, ChangeCounter: null, Bytes: null };
    }
}

async function readColumnStatistics(target: PassTarget): Promise<Map<string, ColumnStatistic>> {
    try {
        const rows = await target.Provider.ExecuteSQL<ColumnStatisticRow>(
            ColumnStatisticsSQL(target.Source.Schema, target.Source.BaseTable, target.Dialect, target.DialectName),
            undefined, catalogOptions('column statistics'), target.User);
        return ReadColumnStatistics(rows ?? [], target.DialectName);
    } catch (error: unknown) {
        // Older SQL Server versions lack sys.dm_db_stats_histogram; the exact pass still runs.
        LogError(`ProfileEntityFields: column statistics unavailable for ${target.EntityName} — ${describe(error)}`);
        return new Map();
    }
}

function catalogOptions(what: string): { description: string; ignoreLogging: boolean; readOnlyTransaction: boolean; timeoutMs: number } {
    return { description: `ProfileEntityFields: ${what}`, ignoreLogging: true, readOnlyTransaction: true, timeoutMs: CATALOG_TIMEOUT_MS };
}

/** The promise's value if it settles within `ms`, else null; it keeps running either way. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(ms, 0)); })]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function waitFor(promise: Promise<void> | undefined, waitMs: number): Promise<void> {
    if (!promise || waitMs <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([promise, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
    if (timer) clearTimeout(timer);
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
