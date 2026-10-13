/**
 * @fileoverview Unit tests for resolving `evalRunAgentTimeoutMs` from skip.config.cjs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@memberjunction/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@memberjunction/core')>();
    return { ...actual, LogStatus: vi.fn(), LogError: vi.fn() };
});

import { LogError } from '@memberjunction/core';
import { resolveEvalRunAgentTimeoutMs, DEFAULT_EVAL_RUN_AGENT_TIMEOUT_MS } from '../../src/skip-config.js';

describe('resolveEvalRunAgentTimeoutMs', () => {
    beforeEach(() => {
        vi.mocked(LogError).mockClear();
    });

    it('defaults to 10 minutes when there is no config file or no setting', () => {
        expect(DEFAULT_EVAL_RUN_AGENT_TIMEOUT_MS).toBe(600_000);
        expect(resolveEvalRunAgentTimeoutMs(null)).toBe(DEFAULT_EVAL_RUN_AGENT_TIMEOUT_MS);
        expect(resolveEvalRunAgentTimeoutMs({ enableEval: true })).toBe(DEFAULT_EVAL_RUN_AGENT_TIMEOUT_MS);
        expect(LogError).not.toHaveBeenCalled();
    });

    it('uses a positive number from the config', () => {
        expect(resolveEvalRunAgentTimeoutMs({ evalRunAgentTimeoutMs: 900_000 })).toBe(900_000);
        expect(LogError).not.toHaveBeenCalled();
    });

    it('logs and falls back to the default for an invalid value', () => {
        for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '900000', true]) {
            expect(resolveEvalRunAgentTimeoutMs({ evalRunAgentTimeoutMs: bad })).toBe(DEFAULT_EVAL_RUN_AGENT_TIMEOUT_MS);
        }
        expect(LogError).toHaveBeenCalledTimes(6);
    });
});
