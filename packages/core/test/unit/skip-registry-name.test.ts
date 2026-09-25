/**
 * @fileoverview Unit tests for per-environment registry naming.
 *
 * Each Skip environment publishes under its own registry name (`Skip`, `Skip-Stage`,
 * `Skip-Local`). Two things are derived from that name and are contracts with code we do
 * not own, so they are pinned here:
 *
 *   1. The env var names MJ reads — `ComponentRegistryResolver` builds them from the
 *      registry record's Name, so our derivation must match it character for character.
 *   2. The registry record's ID — deterministic, so setup is idempotent and a promotion
 *      has a known target to repoint `__mj.Component.SourceRegistryID` at.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    DEFAULT_SKIP_REGISTRY_NAME,
    deriveRegistryEnvVarSuffix,
    getRegistryAPIKeyEnvVar,
    getRegistryURIOverrideEnvVar,
    resolveSkipRegistryURI,
} from '../../src/skip-config.js';
import { deriveSkipRegistryID } from '../../src/skip-records.js';

/** The GUID MJ core originally seeded and still carries in its deleteRecord tombstone. */
const LEGACY_PROD_REGISTRY_ID = 'B2F8C247-D22E-4991-9A69-0F73954A68D6';

describe('deriveRegistryEnvVarSuffix', () => {
    // Mirrors ComponentRegistryResolver.getRegistryUri():
    //   `REGISTRY_URI_OVERRIDE_${registry.Name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`
    it('uppercases and replaces every non-alphanumeric character', () => {
        expect(deriveRegistryEnvVarSuffix('Skip')).toBe('SKIP');
        expect(deriveRegistryEnvVarSuffix('Skip-Stage')).toBe('SKIP_STAGE');
        expect(deriveRegistryEnvVarSuffix('Skip Local')).toBe('SKIP_LOCAL');
        expect(deriveRegistryEnvVarSuffix('Skip.v2')).toBe('SKIP_V2');
    });

    it('collapses names that differ only by separator — the documented collision hazard', () => {
        expect(deriveRegistryEnvVarSuffix('Skip-Stage')).toBe(deriveRegistryEnvVarSuffix('Skip_Stage'));
    });
});

describe('registry env var names', () => {
    it('defaults to the production spelling, preserving existing deployments', () => {
        expect(getRegistryURIOverrideEnvVar()).toBe('REGISTRY_URI_OVERRIDE_SKIP');
        expect(getRegistryAPIKeyEnvVar()).toBe('REGISTRY_API_KEY_SKIP');
    });

    it('derives per-environment names', () => {
        expect(getRegistryURIOverrideEnvVar('Skip-Stage')).toBe('REGISTRY_URI_OVERRIDE_SKIP_STAGE');
        expect(getRegistryAPIKeyEnvVar('Skip-Local')).toBe('REGISTRY_API_KEY_SKIP_LOCAL');
    });

    // MJ derives its two variables by DIFFERENT rules — the URI replaces every
    // non-alphanumeric, the API key replaces only hyphens. Mirroring the wrong rule sets a
    // variable MJ never reads, and the registry then falls back to unauthenticated.
    it('follows MJ hyphen-only derivation for the API key variable', () => {
        expect(getRegistryAPIKeyEnvVar('Skip.v2')).toBe('REGISTRY_API_KEY_SKIP.V2');
        expect(getRegistryURIOverrideEnvVar('Skip.v2')).toBe('REGISTRY_URI_OVERRIDE_SKIP_V2');
    });

    it('agrees on both rules for the hyphenated names we recommend', () => {
        for (const name of ['Skip', 'Skip-Local', 'Skip-Stage']) {
            expect(getRegistryAPIKeyEnvVar(name)).toBe(`REGISTRY_API_KEY_${deriveRegistryEnvVarSuffix(name)}`);
        }
    });
});

describe('deriveSkipRegistryID', () => {
    it('returns the legacy pinned GUID for production, so existing installs are untouched', () => {
        expect(deriveSkipRegistryID('Skip')).toBe(LEGACY_PROD_REGISTRY_ID);
        expect(deriveSkipRegistryID(DEFAULT_SKIP_REGISTRY_NAME)).toBe(LEGACY_PROD_REGISTRY_ID);
    });

    it('matches production case-insensitively and ignores surrounding whitespace', () => {
        expect(deriveSkipRegistryID('  skip ')).toBe(LEGACY_PROD_REGISTRY_ID);
        expect(deriveSkipRegistryID('SKIP')).toBe(LEGACY_PROD_REGISTRY_ID);
    });

    it('is deterministic — setup running twice cannot create a duplicate', () => {
        expect(deriveSkipRegistryID('Skip-Stage')).toBe(deriveSkipRegistryID('Skip-Stage'));
    });

    it('gives distinct environments distinct IDs', () => {
        const ids = new Set([
            deriveSkipRegistryID('Skip'),
            deriveSkipRegistryID('Skip-Stage'),
            deriveSkipRegistryID('Skip-Local'),
        ]);
        expect(ids.size).toBe(3);
    });

    it('emits a well-formed uppercase v5 UUID', () => {
        const id = deriveSkipRegistryID('Skip-Stage');
        expect(id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
    });
});

describe('resolveSkipRegistryURI with a registry name', () => {
    const STAGE_OVERRIDE = 'REGISTRY_URI_OVERRIDE_SKIP_STAGE';
    let savedStage: string | undefined;
    let savedProd: string | undefined;
    let savedSkipURL: string | undefined;

    beforeEach(() => {
        savedStage = process.env[STAGE_OVERRIDE];
        savedProd = process.env.REGISTRY_URI_OVERRIDE_SKIP;
        savedSkipURL = process.env.ASK_SKIP_URL;
        delete process.env[STAGE_OVERRIDE];
        delete process.env.REGISTRY_URI_OVERRIDE_SKIP;
        delete process.env.ASK_SKIP_URL;
    });

    afterEach(() => {
        const restore = (key: string, value: string | undefined) => {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        };
        restore(STAGE_OVERRIDE, savedStage);
        restore('REGISTRY_URI_OVERRIDE_SKIP', savedProd);
        restore('ASK_SKIP_URL', savedSkipURL);
    });

    it('reads the override variable derived from the registry name', () => {
        process.env[STAGE_OVERRIDE] = 'https://brain-stage.askskip.ai/registry';
        const resolved = resolveSkipRegistryURI(null, 'Skip-Stage');
        expect(resolved).toEqual({ uri: 'https://brain-stage.askskip.ai/registry', source: 'override' });
    });

    it('ignores the production override when resolving a different registry', () => {
        // A stray REGISTRY_URI_OVERRIDE_SKIP must not leak into Skip-Stage resolution —
        // MJ would never apply it to that registry either.
        process.env.REGISTRY_URI_OVERRIDE_SKIP = 'https://wrong.example.com/registry';
        const resolved = resolveSkipRegistryURI('https://brain-stage.askskip.ai/registry', 'Skip-Stage');
        expect(resolved).toEqual({ uri: 'https://brain-stage.askskip.ai/registry', source: 'stored' });
    });

    it('still honors ASK_SKIP_URL for a named registry', () => {
        process.env.ASK_SKIP_URL = 'http://127.0.0.1:8000';
        const resolved = resolveSkipRegistryURI(null, 'Skip-Local');
        expect(resolved).toEqual({ uri: 'http://127.0.0.1:8000/registry', source: 'brain' });
    });

    it('defaults to production behavior when no name is given', () => {
        process.env.REGISTRY_URI_OVERRIDE_SKIP = 'https://brain-dev.askskip.ai/registry';
        expect(resolveSkipRegistryURI()).toEqual({
            uri: 'https://brain-dev.askskip.ai/registry',
            source: 'override',
        });
    });
});
