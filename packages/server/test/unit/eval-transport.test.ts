/**
 * @fileoverview Unit tests for the eval transport: the dispatcher that outlasts undici's 300 s
 * header timeout, and the error message an eval caller receives when the run times out.
 */

import { describe, it, expect } from 'vitest';
import { Agent } from 'undici';
import { getEvalDispatcher, isEvalTimeout, describeEvalError } from '../../src/eval-transport.js';

/** Builds the error shape fetch throws when undici gives up: TypeError('fetch failed') with a coded cause. */
function undiciFailure(code: string): Error {
    const cause = Object.assign(new Error('timeout'), { code });
    return Object.assign(new TypeError('fetch failed'), { cause });
}

describe('getEvalDispatcher', () => {
    it('returns an undici Agent, reused for the same timeout', () => {
        const first = getEvalDispatcher(900_000);
        expect(first).toBeInstanceOf(Agent);
        expect(getEvalDispatcher(900_000)).toBe(first);
    });

    it('returns a separate Agent for a different timeout', () => {
        expect(getEvalDispatcher(1_200_000)).not.toBe(getEvalDispatcher(900_000));
    });
});

describe('isEvalTimeout', () => {
    it('recognises an AbortSignal.timeout abort', () => {
        expect(isEvalTimeout(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe(true);
    });

    it('recognises undici header and body timeouts behind "fetch failed"', () => {
        expect(isEvalTimeout(undiciFailure('UND_ERR_HEADERS_TIMEOUT'))).toBe(true);
        expect(isEvalTimeout(undiciFailure('UND_ERR_BODY_TIMEOUT'))).toBe(true);
    });

    it('does not treat other failures as timeouts', () => {
        expect(isEvalTimeout(undiciFailure('ECONNREFUSED'))).toBe(false);
        expect(isEvalTimeout(new Error('Skip eval API returned 500: boom'))).toBe(false);
        expect(isEvalTimeout('fetch failed')).toBe(false);
    });
});

describe('describeEvalError', () => {
    it('names the timeout and the setting that controls it', () => {
        const message = describeEvalError(undiciFailure('UND_ERR_HEADERS_TIMEOUT'), 600_000);
        expect(message).toContain('600 s');
        expect(message).toContain('evalRunAgentTimeoutMs');
    });

    it('passes other errors through unchanged', () => {
        expect(describeEvalError(new Error('Skip eval API returned 500: boom'), 600_000))
            .toBe('Skip eval API returned 500: boom');
        expect(describeEvalError('plain string', 600_000)).toBe('plain string');
    });
});
