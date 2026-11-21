/**
 * @fileoverview Unit tests for the client metadata catalog's canonical form and hashing (`@askskip/types/catalog`).
 * Every MJAPI replica must produce identical bytes for identical metadata, so these pin the properties the Brain
 * relies on: order independence, nulls kept, volatile timestamps dropped, and mismatches detected.
 */

import { describe, it, expect } from 'vitest';
import {
    BuildCatalog,
    CanonicalizeCatalogItem,
    DiffCatalogItems,
    HashCatalogItemContent,
    HashCatalogManifest,
    SerializeCatalogManifest,
    SKIP_CATALOG_FORMAT_VERSION,
    VerifyCatalogItem,
    VerifyCatalogManifest,
} from '../src/catalog.js';

function sampleEntity(): Record<string, unknown> {
    return {
        ID: 'E-1',
        Name: 'Customers',
        Description: null,
        __mj_CreatedAt: '2026-01-01T00:00:00Z',
        __mj_UpdatedAt: '2026-11-01T00:00:00Z',
        Fields: [
            { ID: 'F-B', Name: 'Name', Sequence: 2, Description: null, EntityFieldValues: [{ ID: 'V-2', Sequence: 2, Value: 'b' }, { ID: 'V-1', Sequence: 1, Value: 'a' }] },
            { ID: 'F-A', Name: 'ID', Sequence: 1, Description: 'Primary key', EntityFieldValues: [] },
        ],
        RelatedEntities: [{ ID: 'R-2', RelatedEntity: 'Orders' }, { ID: 'R-1', RelatedEntity: 'Notes' }],
        OrganicKeys: [],
        Tags: ['b', 'a'],
    };
}

/** Same data, every object's keys and every ID-keyed array in a different order. */
function shuffledEntity(): Record<string, unknown> {
    return {
        Tags: ['b', 'a'],
        OrganicKeys: [],
        RelatedEntities: [{ RelatedEntity: 'Notes', ID: 'R-1' }, { RelatedEntity: 'Orders', ID: 'R-2' }],
        Fields: [
            { EntityFieldValues: [], Description: 'Primary key', Sequence: 1, Name: 'ID', ID: 'F-A' },
            { EntityFieldValues: [{ Value: 'a', Sequence: 1, ID: 'V-1' }, { Value: 'b', Sequence: 2, ID: 'V-2' }], Description: null, Sequence: 2, Name: 'Name', ID: 'F-B' },
        ],
        __mj_UpdatedAt: '2026-11-19T00:00:00Z',
        Description: null,
        Name: 'Customers',
        ID: 'E-1',
    };
}

describe('CanonicalizeCatalogItem', () => {
    it('gives shuffled input the same string and hash', () => {
        const a = CanonicalizeCatalogItem(sampleEntity());
        const b = CanonicalizeCatalogItem(shuffledEntity());
        expect(b).toBe(a);
        expect(HashCatalogItemContent(b)).toBe(HashCatalogItemContent(a));
    });

    it('keeps nulls', () => {
        const parsed = JSON.parse(CanonicalizeCatalogItem(sampleEntity())) as Record<string, unknown>;
        expect('Description' in parsed).toBe(true);
        expect(parsed.Description).toBeNull();
        expect((parsed.Fields as Record<string, unknown>[])[1].Description).toBeNull();
    });

    it('drops __mj_CreatedAt and __mj_UpdatedAt at every depth', () => {
        const withNested = { ...sampleEntity(), Fields: [{ ID: 'F-1', Sequence: 1, __mj_UpdatedAt: 'x' }] };
        const text = CanonicalizeCatalogItem(withNested);
        expect(text).not.toContain('__mj_');
        expect(CanonicalizeCatalogItem({ ...withNested, __mj_UpdatedAt: 'changed' })).toBe(text);
    });

    it('sorts fields by Sequence then ID, and keeps arrays without IDs in order', () => {
        const parsed = JSON.parse(CanonicalizeCatalogItem(sampleEntity())) as { Fields: { ID: string; EntityFieldValues: { ID: string }[] }[]; RelatedEntities: { ID: string }[]; Tags: string[] };
        expect(parsed.Fields.map((f) => f.ID)).toEqual(['F-A', 'F-B']);
        expect(parsed.Fields[1].EntityFieldValues.map((v) => v.ID)).toEqual(['V-1', 'V-2']);
        expect(parsed.RelatedEntities.map((r) => r.ID)).toEqual(['R-1', 'R-2']);
        expect(parsed.Tags).toEqual(['b', 'a']);
    });

    it('serializes through toJSON, as the wire does', () => {
        class WithToJSON { toJSON(): object { return { ID: 'X', Name: 'from toJSON' }; } }
        expect(CanonicalizeCatalogItem(new WithToJSON())).toBe('{"ID":"X","Name":"from toJSON"}');
    });

    it('changes the hash when a value changes', () => {
        const changed = { ...sampleEntity(), Description: 'now described' };
        expect(HashCatalogItemContent(CanonicalizeCatalogItem(changed))).not.toBe(HashCatalogItemContent(CanonicalizeCatalogItem(sampleEntity())));
    });
});

describe('item hashing and verification', () => {
    it('includes the format version in the hash', () => {
        expect(HashCatalogItemContent('{}', 1)).not.toBe(HashCatalogItemContent('{}', 2));
    });

    it('detects a hash mismatch', () => {
        const content = CanonicalizeCatalogItem(sampleEntity());
        const hash = HashCatalogItemContent(content);
        expect(VerifyCatalogItem({ id: 'E-1', hash, content }, SKIP_CATALOG_FORMAT_VERSION)).toBe(true);
        expect(VerifyCatalogItem({ id: 'E-1', hash, content: content.replace('Customers', 'Clients') }, SKIP_CATALOG_FORMAT_VERSION)).toBe(false);
        expect(VerifyCatalogItem({ id: 'E-1', hash, content }, SKIP_CATALOG_FORMAT_VERSION + 1)).toBe(false);
    });

    it('produces lowercase hex SHA-256', () => {
        expect(HashCatalogItemContent('x')).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe('manifests', () => {
    const entries = [{ id: 'B-2', hash: 'h2' }, { id: 'a-1', hash: 'h1' }];

    it('serializes one way regardless of order and ID case', () => {
        expect(SerializeCatalogManifest(entries)).toBe(`skip-catalog-manifest:v${SKIP_CATALOG_FORMAT_VERSION}\na-1:h1\nb-2:h2`);
        expect(HashCatalogManifest([...entries].reverse())).toBe(HashCatalogManifest(entries));
        expect(HashCatalogManifest([{ id: 'A-1', hash: 'h1' }, { id: 'b-2', hash: 'h2' }])).toBe(HashCatalogManifest(entries));
    });

    it('round-trips through JSON and still verifies', () => {
        const built = BuildCatalog([sampleEntity(), { ID: 'E-2', Name: 'Orders' }], (e) => String(e.ID));
        const wire = JSON.parse(JSON.stringify(built.Manifest));
        expect(VerifyCatalogManifest(wire)).toBe(true);
        expect(wire.manifestHash).toBe(built.Ref.manifestHash);
        expect(built.Ref.itemCount).toBe(2);
    });

    it('rejects a tampered manifest and duplicate IDs', () => {
        const built = BuildCatalog([{ ID: 'E-1' }, { ID: 'E-2' }], (e) => e.ID);
        expect(VerifyCatalogManifest({ ...built.Manifest, items: built.Manifest.items.slice(1) })).toBe(false);
        const dup = [built.Manifest.items[0], built.Manifest.items[0]];
        expect(VerifyCatalogManifest({ ...built.Manifest, items: dup, manifestHash: HashCatalogManifest(dup) })).toBe(false);
    });

    it('gives two separate builds of the same data the same manifest hash', () => {
        const a = BuildCatalog([sampleEntity(), { ID: 'E-2' }], (e) => String(e.ID));
        const b = BuildCatalog([{ ID: 'E-2' }, shuffledEntity()], (e) => String(e.ID));
        expect(b.Ref.manifestHash).toBe(a.Ref.manifestHash);
    });

    it('refuses duplicate item IDs when building', () => {
        expect(() => BuildCatalog([{ ID: 'E-1' }, { ID: 'e-1' }], (e) => e.ID)).toThrow(/more than once/);
    });
});

describe('DiffCatalogItems', () => {
    it('returns every item when nothing was accepted, and only changed items after', () => {
        const first = BuildCatalog([{ ID: 'E-1', D: 'a' }, { ID: 'E-2', D: 'b' }], (e) => e.ID);
        expect(DiffCatalogItems(first, null)).toHaveLength(2);

        const second = BuildCatalog([{ ID: 'E-1', D: 'a' }, { ID: 'E-2', D: 'changed' }], (e) => e.ID);
        expect(DiffCatalogItems(second, first.Manifest).map((i) => i.id)).toEqual(['E-2']);
    });
});
