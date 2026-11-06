/**
 * Deterministic metadata canonicalization and SHA-256 content hashing for Skip's
 * content-addressed Metadata Cache protocol (`SkipClientCapability.MetadataCache`).
 *
 * Ensures that identical metadata collections produce byte-for-byte identical JSON
 * strings and SHA-256 hashes regardless of database driver row ordering or JS property
 * insertion order.
 */

import { createHash } from 'crypto';
import {
    SkipMetadataRef,
    SkipMetadataSection,
    SkipServerCapability,
} from '@askskip/types';

/** Current serialization and canonicalization format version. */
export const METADATA_CACHE_FORMAT_VERSION = 1;

/** Result of canonicalizing a metadata section. */
export interface CanonicalizedMetadataSection {
    /** Deterministic JSON representation of the section value. */
    canonicalJson: string;
    /** Content-addressed reference summarizing the canonicalized payload. */
    ref: SkipMetadataRef;
}

/**
 * Normalizes a string or unknown identifier for deterministic case-insensitive sorting.
 */
function normalizeId(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : String(value ?? '');
}

/**
 * Compares two numbers with a fallback tie-breaker string.
 */
function compareSequenceThenId(
    aSeq: unknown,
    bSeq: unknown,
    aId: unknown,
    bId: unknown,
): number {
    const numA = typeof aSeq === 'number' && Number.isFinite(aSeq) ? aSeq : Number.MAX_SAFE_INTEGER;
    const numB = typeof bSeq === 'number' && Number.isFinite(bSeq) ? bSeq : Number.MAX_SAFE_INTEGER;
    if (numA !== numB) {
        return numA - numB;
    }
    return normalizeId(aId).localeCompare(normalizeId(bId));
}

/**
 * Recursively sorts object keys alphabetically and strips `undefined` properties.
 * Preserves array ordering (arrays are sorted by section-specific rules prior to key sorting).
 */
export function sortObjectKeysRecursively(value: unknown): unknown {
    if (value === null || value === undefined) {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => sortObjectKeysRecursively(item));
    }
    if (typeof value === 'object') {
        if (value instanceof Date) {
            return value.toISOString();
        }
        const record = value as Record<string, unknown>;
        const sorted: Record<string, unknown> = {};
        const keys = Object.keys(record).sort();
        for (const key of keys) {
            const propVal = record[key];
            if (propVal !== undefined) {
                sorted[key] = sortObjectKeysRecursively(propVal);
            }
        }
        return sorted;
    }
    return value;
}

/**
 * Converts an entity item (or `EntityInfo` instance with `.SimpleObject` / plain object)
 * into a canonically sorted plain object.
 */
function canonicalizeEntityItem(entity: Record<string, unknown>): Record<string, unknown> {
    const plain = convertToPlainRecord(entity);
    const clone: Record<string, unknown> = { ...plain };

    if (Array.isArray(clone.Fields)) {
        clone.Fields = [...(clone.Fields as Record<string, unknown>[])]
            .map((field) => {
                const plainField = convertToPlainRecord(field);
                const fieldClone: Record<string, unknown> = { ...plainField };
                if (Array.isArray(fieldClone.EntityFieldValues)) {
                    fieldClone.EntityFieldValues = [...(fieldClone.EntityFieldValues as Record<string, unknown>[])]
                        .map((v) => convertToPlainRecord(v))
                        .sort((a, b) => normalizeId(a.ID ?? a.Value).localeCompare(normalizeId(b.ID ?? b.Value)));
                }
                return fieldClone;
            })
            .sort((a, b) => compareSequenceThenId(a.Sequence, b.Sequence, a.ID ?? a.Name, b.ID ?? b.Name));
    }

    if (Array.isArray(clone.RelatedEntities)) {
        clone.RelatedEntities = [...(clone.RelatedEntities as Record<string, unknown>[])]
            .map((rel) => convertToPlainRecord(rel))
            .sort((a, b) => normalizeId(a.ID).localeCompare(normalizeId(b.ID)));
    }

    if (Array.isArray(clone.OrganicKeys)) {
        clone.OrganicKeys = [...(clone.OrganicKeys as Record<string, unknown>[])]
            .map((ok) => convertToPlainRecord(ok))
            .sort((a, b) => normalizeId(a.ID ?? a.Name).localeCompare(normalizeId(b.ID ?? b.Name)));
    }

    if (Array.isArray(clone.EntityFieldValues)) {
        clone.EntityFieldValues = [...(clone.EntityFieldValues as Record<string, unknown>[])]
            .map((v) => convertToPlainRecord(v))
            .sort((a, b) => normalizeId(a.ID ?? a.Value).localeCompare(normalizeId(b.ID ?? b.Value)));
    }

    return clone;
}

/**
 * Converts a query item into a canonically sorted plain object.
 */
function canonicalizeQueryItem(query: Record<string, unknown>): Record<string, unknown> {
    const plain = convertToPlainRecord(query);
    const clone: Record<string, unknown> = { ...plain };

    if (Array.isArray(clone.Fields)) {
        clone.Fields = [...(clone.Fields as Record<string, unknown>[])]
            .map((f) => convertToPlainRecord(f))
            .sort((a, b) => compareSequenceThenId(a.Sequence, b.Sequence, a.ID ?? a.Name, b.ID ?? b.Name));
    }

    if (Array.isArray(clone.Parameters)) {
        clone.Parameters = [...(clone.Parameters as Record<string, unknown>[])]
            .map((p) => convertToPlainRecord(p))
            .sort((a, b) => normalizeId(a.ID ?? a.Name).localeCompare(normalizeId(b.ID ?? b.Name)));
    }

    if (Array.isArray(clone.Entities)) {
        clone.Entities = [...(clone.Entities as Record<string, unknown>[])]
            .map((e) => convertToPlainRecord(e))
            .sort((a, b) => normalizeId(a.ID ?? eIdFallback(a)).localeCompare(normalizeId(b.ID ?? eIdFallback(b))));
    }

    return clone;
}

function eIdFallback(record: Record<string, unknown>): unknown {
    return record.EntityID ?? record.Entity;
}

/**
 * Safely unwraps objects with custom `.toJSON()` so all properties serialize consistently.
 */
function convertToPlainRecord(item: unknown): Record<string, unknown> {
    if (!item || typeof item !== 'object') {
        return {};
    }
    const candidate = item as { toJSON?: () => unknown };
    if (typeof candidate.toJSON === 'function') {
        const jsonVal = candidate.toJSON();
        if (jsonVal && typeof jsonVal === 'object' && !Array.isArray(jsonVal)) {
            return jsonVal as Record<string, unknown>;
        }
    }
    return item as Record<string, unknown>;
}

/**
 * Sorts a section's items and nested collections according to its deterministic rules,
 * then recursively sorts all object keys.
 */
export function normalizeMetadataSectionValue(
    section: SkipMetadataSection,
    value: unknown,
): { normalized: unknown; itemCount: number } {
    switch (section) {
        case 'entities': {
            const arr = Array.isArray(value) ? value : [];
            const sorted = arr
                .map((item) => canonicalizeEntityItem(item as Record<string, unknown>))
                .sort((a, b) => normalizeId(a.ID ?? a.Name).localeCompare(normalizeId(b.ID ?? b.Name)));
            return {
                normalized: sortObjectKeysRecursively(sorted),
                itemCount: sorted.length,
            };
        }
        case 'queries': {
            const arr = Array.isArray(value) ? value : [];
            const sorted = arr
                .map((item) => canonicalizeQueryItem(item as Record<string, unknown>))
                .sort((a, b) => normalizeId(a.ID ?? a.Name).localeCompare(normalizeId(b.ID ?? b.Name)));
            return {
                normalized: sortObjectKeysRecursively(sorted),
                itemCount: sorted.length,
            };
        }
        case 'queryCatalog': {
            const arr = Array.isArray(value) ? value : [];
            const sorted = arr
                .map((item) => convertToPlainRecord(item))
                .sort((a, b) => {
                    const catCmp = normalizeId(a.CategoryPath).localeCompare(normalizeId(b.CategoryPath));
                    if (catCmp !== 0) {
                        return catCmp;
                    }
                    return normalizeId(a.Name ?? a.ID).localeCompare(normalizeId(b.Name ?? b.ID));
                });
            return {
                normalized: sortObjectKeysRecursively(sorted),
                itemCount: sorted.length,
            };
        }
        case 'notes':
        case 'noteTypes': {
            const arr = Array.isArray(value) ? value : [];
            const sorted = arr
                .map((item) => convertToPlainRecord(item))
                .sort((a, b) => normalizeId(a.id ?? a.ID).localeCompare(normalizeId(b.id ?? b.ID)));
            return {
                normalized: sortObjectKeysRecursively(sorted),
                itemCount: sorted.length,
            };
        }
        case 'canon': {
            const record = convertToPlainRecord(value);
            const rawConcepts = Array.isArray(record.concepts) ? record.concepts : [];
            const rawEdges = Array.isArray(record.edges) ? record.edges : [];

            const sortedConcepts = rawConcepts
                .map((c) => {
                    const plain = convertToPlainRecord(c);
                    const clone: Record<string, unknown> = { ...plain };
                    if (Array.isArray(clone.aliases)) {
                        clone.aliases = [...(clone.aliases as unknown[])]
                            .map((alias) => String(alias))
                            .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
                    }
                    if (Array.isArray(clone.synonyms)) {
                        clone.synonyms = [...(clone.synonyms as unknown[])]
                            .map((syn) => String(syn))
                            .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
                    }
                    return clone;
                })
                .sort((a, b) => {
                    const rankA = typeof a.precedenceRank === 'number' ? a.precedenceRank : 0;
                    const rankB = typeof b.precedenceRank === 'number' ? b.precedenceRank : 0;
                    if (rankA !== rankB) {
                        return rankB - rankA; // Descending by precedenceRank
                    }
                    return normalizeId(a.id ?? a.ID).localeCompare(normalizeId(b.id ?? b.ID));
                });

            const sortedEdges = rawEdges
                .map((e) => convertToPlainRecord(e))
                .sort((a, b) => normalizeId(a.id ?? a.ID).localeCompare(normalizeId(b.id ?? b.ID)));

            const rawAbvs = Array.isArray(record.alternateBaseViews) ? record.alternateBaseViews : [];
            const sortedAbvs = rawAbvs
                .map((abv) => convertToPlainRecord(abv))
                .sort((a, b) => compareSequenceThenId(a.priority, b.priority, a.id ?? a.ID, b.id ?? b.ID));

            const canonObj: Record<string, unknown> = {
                concepts: sortedConcepts,
                edges: sortedEdges,
            };
            if (sortedAbvs.length > 0) {
                canonObj.alternateBaseViews = sortedAbvs;
            }
            if (typeof record.domainDocument === 'string' && record.domainDocument.length > 0) {
                canonObj.domainDocument = record.domainDocument;
            } else if (typeof record.renderedDocument === 'string' && record.renderedDocument.length > 0) {
                canonObj.domainDocument = record.renderedDocument;
            }

            return {
                normalized: sortObjectKeysRecursively(canonObj),
                itemCount: sortedConcepts.length + sortedEdges.length + sortedAbvs.length,
            };
        }
    }
}

/**
 * Computes the hex-encoded SHA-256 digest of `${formatVersion}:${canonicalJson}`.
 */
export function computeMetadataSectionHash(
    canonicalJson: string,
    formatVersion: number = METADATA_CACHE_FORMAT_VERSION,
): string {
    return createHash('sha256')
        .update(`${formatVersion}:${canonicalJson}`, 'utf8')
        .digest('hex');
}

/**
 * Canonicalizes a metadata section into deterministic JSON and returns both the
 * serialized string and its {@link SkipMetadataRef}.
 */
export function canonicalizeMetadataSection(
    section: SkipMetadataSection,
    value: unknown,
    formatVersion: number = METADATA_CACHE_FORMAT_VERSION,
): CanonicalizedMetadataSection {
    const { normalized, itemCount } = normalizeMetadataSectionValue(section, value);
    const canonicalJson = JSON.stringify(normalized);
    const byteLength = Buffer.byteLength(canonicalJson, 'utf8');
    const hash = computeMetadataSectionHash(canonicalJson, formatVersion);

    return {
        canonicalJson,
        ref: {
            hash,
            formatVersion,
            itemCount,
            byteLength,
        },
    };
}

// ─── Brain Capability Registry (per Skip API Base URL) ───────────────────────

/**
 * Tracks server capabilities advertised by each Skip Brain URL (via
 * `GET /registry/api/v1/registry` or `SkipAPIResponse.serverCapabilities`).
 */
const brainCapabilitiesByUrl = new Map<string, Set<string>>();

function normalizeBrainUrl(apiUrl: string): string {
    return apiUrl.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Records the capabilities advertised by a Skip Brain endpoint.
 */
export function recordBrainCapabilities(apiUrl: string, capabilities: readonly string[] | undefined | null): void {
    if (!apiUrl || !Array.isArray(capabilities)) {
        return;
    }
    const key = normalizeBrainUrl(apiUrl);
    brainCapabilitiesByUrl.set(key, new Set(capabilities));
}

/**
 * Returns true when the given Skip Brain endpoint has advertised `metadataCache`
 * in its `serverCapabilities`.
 */
export function brainSupportsMetadataCache(apiUrl: string): boolean {
    if (!apiUrl) {
        return false;
    }
    const caps = brainCapabilitiesByUrl.get(normalizeBrainUrl(apiUrl));
    return caps?.has(SkipServerCapability.MetadataCache) ?? false;
}

/**
 * Clears cached brain capabilities (used in unit tests).
 */
export function clearBrainCapabilities(): void {
    brainCapabilitiesByUrl.clear();
}
