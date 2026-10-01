/**
 * @fileoverview Unit tests for classifying REGISTRY_URI_OVERRIDE_SKIP.
 *
 * This decides whether the production "Skip" registry record gets repaired on a client that
 * publishes under another name. Getting it wrong is not academic: the first version treated
 * "the variable is set" as operator intent and declined to repair. But before per-environment
 * registries, pointing a client at stage *was* setting that variable — so the repair skipped
 * exactly the instances that needed it. More Cheese Stage upgraded with its `Skip` row still
 * aimed at the stage brain, and nothing said why.
 */

import { describe, it, expect } from 'vitest';
import { classifyProductionRegistryOverride } from '../../src/skip-records.js';

const THIS_BRAIN = 'https://brain-stage.askskip.ai/registry';

describe('classifyProductionRegistryOverride', () => {
    it('reports absent when the variable is unset or blank', () => {
        expect(classifyProductionRegistryOverride(undefined, THIS_BRAIN)).toBe('absent');
        expect(classifyProductionRegistryOverride('', THIS_BRAIN)).toBe('absent');
        expect(classifyProductionRegistryOverride('   ', THIS_BRAIN)).toBe('absent');
    });

    // The regression that motivated this. A value aimed at this instance's own brain cannot
    // be a statement about production — production is somewhere else by definition.
    it('treats an override pointing at this instance as legacy wiring', () => {
        expect(classifyProductionRegistryOverride(THIS_BRAIN, THIS_BRAIN)).toBe('legacy');
    });

    it('normalizes trailing slashes, surrounding space and case before comparing', () => {
        expect(classifyProductionRegistryOverride(`${THIS_BRAIN}/`, THIS_BRAIN)).toBe('legacy');
        expect(classifyProductionRegistryOverride(`  ${THIS_BRAIN}//  `, THIS_BRAIN)).toBe('legacy');
        expect(classifyProductionRegistryOverride(THIS_BRAIN.toUpperCase(), THIS_BRAIN)).toBe('legacy');
        expect(classifyProductionRegistryOverride(THIS_BRAIN, `${THIS_BRAIN}/`)).toBe('legacy');
    });

    it('treats an override pointing elsewhere as deliberate and leaves it alone', () => {
        // A mirror or proxy in front of production is a real thing an operator may want.
        expect(classifyProductionRegistryOverride('https://registry-mirror.internal/registry', THIS_BRAIN))
            .toBe('deliberate');
        expect(classifyProductionRegistryOverride('https://brain-prod.askskip.ai/registry', THIS_BRAIN))
            .toBe('deliberate');
    });

    it('does not confuse a different host that merely shares a suffix', () => {
        expect(classifyProductionRegistryOverride('https://not-brain-stage.askskip.ai/registry', THIS_BRAIN))
            .toBe('deliberate');
    });

    it('does not treat a different path on the same host as this instance', () => {
        expect(classifyProductionRegistryOverride('https://brain-stage.askskip.ai/other', THIS_BRAIN))
            .toBe('deliberate');
    });
});
