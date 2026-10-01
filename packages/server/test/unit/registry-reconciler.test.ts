/**
 * @fileoverview Unit tests for the lazy registry reconciler.
 *
 * The behavior under test is *when* the client re-asks the brain for its registry name.
 * Getting this wrong is expensive in both directions: asking too eagerly puts an HTTP call
 * on every chat request, and never asking again means a client that booted before the Skip
 * API came up manages nothing for the rest of its life — the scenario that motivated
 * dropping the original capped retry (MJAPI and the Skip API are routinely started hours
 * apart locally, and a brain can be down for a maintenance window).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const ensureSkipRecords = vi.fn(async () => {});
const fetchSkipRegistryName = vi.fn(async () => 'Skip-Local' as string | null);
const resolveSkipApiKey = vi.fn(async () => 'key');
const getSkipConfig = vi.fn(() => ({ skipURL: 'http://127.0.0.1:8000', apiKey: 'key' }));

vi.mock('@askskip/core', () => ({
    ensureSkipRecords: (...a: unknown[]) => ensureSkipRecords(...(a as [])),
    fetchSkipRegistryName: (...a: unknown[]) => fetchSkipRegistryName(...(a as [])),
    resolveSkipApiKey: (...a: unknown[]) => resolveSkipApiKey(...(a as [])),
    getSkipConfig: () => getSkipConfig(),
}));

vi.mock('@memberjunction/core', () => ({
    LogError: vi.fn(),
    LogStatus: vi.fn(),
    Metadata: { Provider: {} },
}));

vi.mock('@memberjunction/sqlserver-dataprovider', () => ({
    UserCache: { Instance: { GetSystemUser: () => ({ ID: 'sys' }) } },
}));

const { noteBrainContact, markRegistryReconciled, resetRegistryReconcilerState } = await import(
    '../../src/registry-reconciler.js'
);

/** Lets the fire-and-forget reconcile settle before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    resetRegistryReconcilerState();
    ensureSkipRecords.mockClear();
    fetchSkipRegistryName.mockClear();
    fetchSkipRegistryName.mockResolvedValue('Skip-Local');
    vi.useRealTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('noteBrainContact', () => {
    it('reconciles on the first successful brain contact', async () => {
        noteBrainContact();
        await settle();

        expect(fetchSkipRegistryName).toHaveBeenCalledTimes(1);
        expect(ensureSkipRecords).toHaveBeenCalledTimes(1);
        expect(ensureSkipRecords.mock.calls[0][3]).toBe('Skip-Local');
    });

    it('does not re-ask on every subsequent request', async () => {
        noteBrainContact();
        await settle();
        noteBrainContact();
        noteBrainContact();
        await settle();

        expect(fetchSkipRegistryName).toHaveBeenCalledTimes(1);
    });

    it('skips work entirely when startup already reconciled', async () => {
        markRegistryReconciled('Skip-Local');
        noteBrainContact();
        await settle();

        expect(fetchSkipRegistryName).not.toHaveBeenCalled();
        expect(ensureSkipRecords).not.toHaveBeenCalled();
    });

    it('retries on the next contact when the brain is still unreachable', async () => {
        // This is the hours-apart case: startup failed, the first request after the brain
        // comes up must still reconcile. A capped retry would have given up long before.
        fetchSkipRegistryName.mockResolvedValueOnce(null);

        noteBrainContact();
        await settle();
        expect(ensureSkipRecords).not.toHaveBeenCalled();

        noteBrainContact();
        await settle();
        expect(ensureSkipRecords).toHaveBeenCalledTimes(1);
    });

    it('keeps retrying after a thrown error rather than wedging', async () => {
        fetchSkipRegistryName.mockRejectedValueOnce(new Error('socket hang up'));

        noteBrainContact();
        await settle();
        expect(ensureSkipRecords).not.toHaveBeenCalled();

        noteBrainContact();
        await settle();
        expect(ensureSkipRecords).toHaveBeenCalledTimes(1);
    });

    it('picks up a rename once the re-check interval has passed', async () => {
        noteBrainContact();
        await settle();
        expect(ensureSkipRecords).toHaveBeenCalledTimes(1);

        // Operator renames the brain's registry while this client keeps running.
        fetchSkipRegistryName.mockResolvedValue('Skip-Stage');
        vi.setSystemTime(new Date(Date.now() + 6 * 60 * 1000));

        noteBrainContact();
        await settle();

        expect(ensureSkipRecords).toHaveBeenCalledTimes(2);
        expect(ensureSkipRecords.mock.calls[1][3]).toBe('Skip-Stage');
    });

    it('does not rewrite records when the name is unchanged at re-check', async () => {
        noteBrainContact();
        await settle();

        vi.setSystemTime(new Date(Date.now() + 6 * 60 * 1000));
        noteBrainContact();
        await settle();

        expect(fetchSkipRegistryName).toHaveBeenCalledTimes(2);
        expect(ensureSkipRecords).toHaveBeenCalledTimes(1);
    });
});
