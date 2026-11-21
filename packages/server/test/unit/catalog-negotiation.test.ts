/**
 * @fileoverview Unit tests for sending catalogs by reference and handling Skip's `catalog_miss` answers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkipErrorCode, SkipRetryAction, SkipResponsePhase, type SkipAPIRequest, type SkipAPIResponse, type SkipErrorDetail } from '@askskip/types';
import { SkipCatalogKind } from '@askskip/types/catalog';

vi.mock('@memberjunction/core', () => ({ LogError: vi.fn(), LogStatus: vi.fn() }));

import { LogError } from '@memberjunction/core';
import { SkipCatalogNegotiator } from '../../src/catalog-negotiation.js';

type Result = { Final?: SkipAPIResponse };

function fullRequest(entities: { ID: string; Name: string; Description?: string }[], queries: { ID: string; Name: string }[] = []): SkipAPIRequest {
    return { messages: [], entities, queries, conversationID: 'c', userEmail: 'u@x', requestPhase: 'initial_request', apiKeys: [], callingServerAPIKey: 'raw-key' } as unknown as SkipAPIRequest;
}

function ok(): Result {
    return { Final: { success: true, responsePhase: SkipResponsePhase.analysis_complete, messages: [] } };
}

function miss(detail: Partial<SkipErrorDetail>): Result {
    return {
        Final: {
            success: false, responsePhase: SkipResponsePhase.analysis_complete, messages: [],
            errorDetail: { type: 'validation', code: SkipErrorCode.catalog_miss, message: 'miss', retryable: true, retryAction: SkipRetryAction.resend_catalog, ...detail },
        },
    };
}

/** A sender that answers with the given results in order and records every request. */
function scriptedSender(results: Result[]) {
    const sent: SkipAPIRequest[] = [];
    const send = vi.fn(async (request: SkipAPIRequest) => {
        sent.push(request);
        return results[sent.length - 1] ?? ok();
    });
    return { send, sent };
}

async function run(full: SkipAPIRequest, results: Result[], url = 'http://skip') {
    const catalogs = SkipCatalogNegotiator.BuildRequestCatalogs(full)!;
    const { send, sent } = scriptedSender(results);
    const result = await new SkipCatalogNegotiator(url).Send(full, catalogs, send, (r: Result) => r.Final);
    return { result, sent };
}

const ENTITIES = [{ ID: 'E-1', Name: 'Customers' }, { ID: 'E-2', Name: 'Orders' }];

describe('SkipCatalogNegotiator', () => {
    beforeEach(() => {
        SkipCatalogNegotiator.Reset();
        vi.clearAllMocks();
    });

    it('sends refs and empty arrays on a hit, once', async () => {
        const { sent } = await run(fullRequest(ENTITIES, [{ ID: 'Q-1', Name: 'Q' }]), [ok()]);
        expect(sent).toHaveLength(1);
        expect(sent[0].entities).toEqual([]);
        expect(sent[0].queries).toEqual([]);
        expect(sent[0].catalogRefs?.entities?.itemCount).toBe(2);
        expect(sent[0].catalogRefs?.queries?.itemCount).toBe(1);
        expect(sent[0].catalogManifests).toBeUndefined();
    });

    it('resends the manifest and every item after a miss with nothing accepted, keeping the callback key', async () => {
        const { sent } = await run(fullRequest(ENTITIES), [miss({ missingKinds: [SkipCatalogKind.Entities] }), ok()]);
        expect(sent).toHaveLength(2);
        expect(sent[1].catalogManifests?.entities?.items).toHaveLength(2);
        expect(sent[1].catalogItems?.entities?.map((i) => i.id).sort()).toEqual(['E-1', 'E-2']);
        expect(sent[1].callingServerAPIKey).toBe('raw-key');
        expect(sent[1].entities).toEqual([]);
    });

    it('resends only the changed item once a manifest was accepted', async () => {
        await run(fullRequest(ENTITIES), [ok()]);
        const changed = [{ ID: 'E-1', Name: 'Customers' }, { ID: 'E-2', Name: 'Orders', Description: 'now described' }];
        const { sent } = await run(fullRequest(changed), [miss({ missingKinds: [SkipCatalogKind.Entities] }), ok()]);
        expect(sent[1].catalogItems?.entities?.map((i) => i.id)).toEqual(['E-2']);
    });

    it('sends exactly the IDs Skip lists on a second miss', async () => {
        const { sent } = await run(fullRequest(ENTITIES), [
            miss({ missingKinds: [SkipCatalogKind.Entities] }),
            miss({ missingItems: [{ kind: SkipCatalogKind.Entities, ids: ['e-2'] }] }),
            ok(),
        ]);
        expect(sent).toHaveLength(3);
        expect(sent[2].catalogItems?.entities?.map((i) => i.id)).toEqual(['E-2']);
        expect(sent[2].catalogManifests?.entities).toBeDefined();
    });

    it('falls back to the full payload after two resends, logs an error, and accepts nothing', async () => {
        const full = fullRequest(ENTITIES);
        const always = miss({ missingKinds: [SkipCatalogKind.Entities] });
        const { sent } = await run(full, [always, always, always, ok()]);
        expect(sent).toHaveLength(4);
        expect(sent[3]).toBe(full);
        expect(sent[3].catalogRefs).toBeUndefined();
        expect(LogError).toHaveBeenCalledTimes(1);

        // Nothing was accepted, so the next miss resends every item.
        const { sent: next } = await run(fullRequest(ENTITIES), [miss({ missingKinds: [SkipCatalogKind.Entities] }), ok()]);
        expect(next[1].catalogItems?.entities).toHaveLength(2);
    });

    it('does not record a manifest as accepted when no final response arrived', async () => {
        const full = fullRequest(ENTITIES);
        const catalogs = SkipCatalogNegotiator.BuildRequestCatalogs(full)!;
        await new SkipCatalogNegotiator('http://skip').Send(full, catalogs, async () => ({} as Result), (r: Result) => r.Final);
        const { sent } = await run(fullRequest(ENTITIES), [miss({ missingKinds: [SkipCatalogKind.Entities] }), ok()]);
        expect(sent[1].catalogItems?.entities).toHaveLength(2);
    });

    it('sends a request with no catalogs unchanged', async () => {
        const full = fullRequest([]);
        const { sent } = await run(full, [ok()]);
        expect(sent[0]).toBe(full);
    });

    it('reuses the entity catalog while the entity array is the same object', () => {
        const full = fullRequest(ENTITIES);
        const a = SkipCatalogNegotiator.BuildRequestCatalogs(full)!.get(SkipCatalogKind.Entities);
        const b = SkipCatalogNegotiator.BuildRequestCatalogs(full)!.get(SkipCatalogKind.Entities);
        expect(b).toBe(a);
    });
});
