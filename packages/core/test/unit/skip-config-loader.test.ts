/**
 * @fileoverview Unit tests for the skip.config.cjs loader.
 *
 * Three behaviors are pinned:
 *   1. found       — a config in the start directory loads (and the resolved path is logged once)
 *   2. walk-up     — a missing config walks up to an ancestor's file; nothing anywhere -> null
 *   3. broken stop — a config that EXISTS but fails to evaluate logs loudly, returns null,
 *                    and does NOT fall through to an ancestor's (different) config
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('@memberjunction/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@memberjunction/core')>();
    return { ...actual, LogStatus: vi.fn(), LogError: vi.fn() };
});

import { LogStatus, LogError } from '@memberjunction/core';
import { loadSkipConfigFile } from '../../src/skip-config.js';

describe('loadSkipConfigFile', () => {
    let fixtureRoot: string;

    beforeEach(() => {
        // Unique per test: require() caches by resolved path, so fixtures must never be reused.
        fixtureRoot = mkdtempSync(join(tmpdir(), 'skip-config-test-'));
        vi.mocked(LogStatus).mockClear();
        vi.mocked(LogError).mockClear();
    });

    afterEach(() => {
        rmSync(fixtureRoot, { recursive: true, force: true });
    });

    function writeConfig(dir: string, content: string): string {
        const path = join(dir, 'skip.config.cjs');
        writeFileSync(path, content, 'utf-8');
        return path;
    }

    it('loads the config from the start directory and logs the resolved path', () => {
        const configPath = writeConfig(fixtureRoot, `module.exports = { enableEval: true };`);

        const cfg = loadSkipConfigFile(fixtureRoot);

        expect(cfg).toEqual({ enableEval: true });
        expect(LogError).not.toHaveBeenCalled();
        // The success line is logged at most once per process (module-level flag), and this
        // is the first successful load in this test file's module instance.
        expect(LogStatus).toHaveBeenCalledOnce();
        expect(vi.mocked(LogStatus).mock.calls[0][0]).toContain(configPath);
    });

    it('walks up to an ancestor directory when the start directory has no config', () => {
        writeConfig(fixtureRoot, `module.exports = { marker: 'ancestor' };`);
        const nested = join(fixtureRoot, 'apps', 'MJAPI');
        mkdirSync(nested, { recursive: true });

        expect(loadSkipConfigFile(nested)).toEqual({ marker: 'ancestor' });
        expect(LogError).not.toHaveBeenCalled();
    });

    it('returns null when no config exists anywhere up to the filesystem root', () => {
        const nested = join(fixtureRoot, 'no', 'config', 'here');
        mkdirSync(nested, { recursive: true });

        expect(loadSkipConfigFile(nested)).toBeNull();
        expect(LogError).not.toHaveBeenCalled();
    });

    it('stops on a config with a syntax error: logs, returns null, and never loads the ancestor config', () => {
        writeConfig(fixtureRoot, `module.exports = { marker: 'ancestor' };`);
        const nested = join(fixtureRoot, 'child');
        mkdirSync(nested);
        const brokenPath = writeConfig(nested, `module.exports = { this is not javascript`);

        expect(loadSkipConfigFile(nested)).toBeNull();

        expect(LogError).toHaveBeenCalledOnce();
        expect(vi.mocked(LogError).mock.calls[0][0]).toContain(brokenPath);
    });

    it('treats a config whose own require() of a missing module fails as broken, not as not-found', () => {
        writeConfig(fixtureRoot, `module.exports = { marker: 'ancestor' };`);
        const nested = join(fixtureRoot, 'child');
        mkdirSync(nested);
        const brokenPath = writeConfig(nested, `require('some-module-that-does-not-exist-xyz');\nmodule.exports = {};`);

        expect(loadSkipConfigFile(nested)).toBeNull();

        expect(LogError).toHaveBeenCalledOnce();
        const message = vi.mocked(LogError).mock.calls[0][0] as string;
        expect(message).toContain(brokenPath);
        expect(message).toContain('some-module-that-does-not-exist-xyz');
    });
});
