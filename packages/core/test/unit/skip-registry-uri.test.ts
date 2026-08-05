/**
 * @fileoverview Unit tests for component registry URI resolution.
 *
 * The order is a contract shared with MJ's ComponentRegistryResolver and with
 * SkipMiddleware.deriveRegistryEnvVars(), and it decides which brain a tenant's
 * components come from — so it is pinned here:
 *
 *   1. REGISTRY_URI_OVERRIDE_SKIP  (registry may differ from the chat endpoint)
 *   2. ASK_SKIP_URL                (the configured brain serves its own registry)
 *   3. the URI already on the record (production default when never overridden)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    getConfiguredSkipRegistryURI,
    getSkipRegistryURI,
    DEFAULT_SKIP_BASE_URL,
    SKIP_REGISTRY_URI_OVERRIDE_ENV_VAR,
} from '../../src/skip-config.js';

const PROD_REGISTRY_URI = `${DEFAULT_SKIP_BASE_URL}/registry`;
const DEV_BRAIN_URL = 'https://brain-dev.askskip.ai';

describe('getSkipRegistryURI', () => {
    it('appends /registry to the production default', () => {
        expect(getSkipRegistryURI()).toBe(PROD_REGISTRY_URI);
    });

    it('strips trailing slashes before appending /registry', () => {
        expect(getSkipRegistryURI(`${DEV_BRAIN_URL}//`)).toBe(`${DEV_BRAIN_URL}/registry`);
    });
});

describe('getConfiguredSkipRegistryURI', () => {
    let savedOverride: string | undefined;
    let savedSkipURL: string | undefined;

    beforeEach(() => {
        savedOverride = process.env[SKIP_REGISTRY_URI_OVERRIDE_ENV_VAR];
        savedSkipURL = process.env.ASK_SKIP_URL;
        delete process.env[SKIP_REGISTRY_URI_OVERRIDE_ENV_VAR];
        delete process.env.ASK_SKIP_URL;
    });

    afterEach(() => {
        restore(SKIP_REGISTRY_URI_OVERRIDE_ENV_VAR, savedOverride);
        restore('ASK_SKIP_URL', savedSkipURL);
    });

    function restore(name: string, value: string | undefined): void {
        if (value === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    }

    it('uses the explicit registry override ahead of everything else', () => {
        process.env[SKIP_REGISTRY_URI_OVERRIDE_ENV_VAR] = 'https://registry-dev.askskip.ai/registry';
        process.env.ASK_SKIP_URL = DEV_BRAIN_URL;

        expect(getConfiguredSkipRegistryURI(PROD_REGISTRY_URI)).toBe('https://registry-dev.askskip.ai/registry');
    });

    it('trims and strips trailing slashes from the override', () => {
        process.env[SKIP_REGISTRY_URI_OVERRIDE_ENV_VAR] = '  https://registry-dev.askskip.ai/registry//  ';

        expect(getConfiguredSkipRegistryURI()).toBe('https://registry-dev.askskip.ai/registry');
    });

    it('derives the registry from ASK_SKIP_URL when no override is set', () => {
        process.env.ASK_SKIP_URL = `${DEV_BRAIN_URL}/`;

        expect(getConfiguredSkipRegistryURI(PROD_REGISTRY_URI)).toBe(`${DEV_BRAIN_URL}/registry`);
    });

    it('keeps the stored record URI when neither variable is set', () => {
        // The upgrade/self-heal path: an operator-corrected row must survive re-runs of setup.
        expect(getConfiguredSkipRegistryURI('https://registry-corrected.askskip.ai/registry')).toBe(
            'https://registry-corrected.askskip.ai/registry',
        );
    });

    it('falls back to production when there is no stored URI (new record)', () => {
        expect(getConfiguredSkipRegistryURI()).toBe(PROD_REGISTRY_URI);
        expect(getConfiguredSkipRegistryURI(null)).toBe(PROD_REGISTRY_URI);
        expect(getConfiguredSkipRegistryURI('   ')).toBe(PROD_REGISTRY_URI);
    });

    it('ignores blank env values rather than treating them as configuration', () => {
        process.env[SKIP_REGISTRY_URI_OVERRIDE_ENV_VAR] = '   ';
        process.env.ASK_SKIP_URL = '';

        expect(getConfiguredSkipRegistryURI(PROD_REGISTRY_URI)).toBe(PROD_REGISTRY_URI);
    });
});
