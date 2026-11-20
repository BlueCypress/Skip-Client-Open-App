/**
 * Client metadata catalog: the content-addressed form in which the Skip SDK sends its entity and
 * query catalogs to the Skip Brain (Skip-Brain plan `client-metadata-catalog-cache.md`, §4).
 *
 * Exported as the subpath `@askskip/types/catalog` so `node:crypto` stays out of the main entry point.
 *
 * Every item is one canonical JSON string. Its hash covers the format version and the string's exact UTF-8
 * bytes. A manifest lists the items of one kind as `id:hash` lines, and its hash is what a normal request
 * carries. The Brain never re-serializes: it hashes the exact string it received.
 *
 * Any change to the canonical form, the item hash or the manifest serialization must bump
 * {@link SKIP_CATALOG_FORMAT_VERSION}, which invalidates every stored hash at once.
 */
import { createHash } from 'node:crypto';

export * from './catalog-types.js';
import {
    SKIP_CATALOG_FORMAT_VERSION,
    SKIP_CATALOG_VOLATILE_KEYS,
    type SkipCatalogItem,
    type SkipCatalogManifest,
    type SkipCatalogManifestEntry,
    type SkipCatalogRef,
} from './catalog-types.js';

// ── Canonical form ─────────────────────────────────────────────────────────────────────────────

/** A JSON value as `JSON.parse` returns it. */
export type CatalogJSONValue = string | number | boolean | null | CatalogJSONValue[] | { [key: string]: CatalogJSONValue };
type CatalogJSONObject = { [key: string]: CatalogJSONValue };

function isJSONObject(value: CatalogJSONValue): value is CatalogJSONObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Plain code-unit comparison: never locale-dependent, so every process orders identically. */
function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function sortKeyOf(value: CatalogJSONValue): { sequence: number | null; id: string } | null {
    if (!isJSONObject(value) || typeof value.ID !== 'string') {
        return null;
    }
    const sequence = typeof value.Sequence === 'number' ? value.Sequence : null;
    return { sequence, id: value.ID.toLowerCase() };
}

/**
 * Orders an array of records that carry a string `ID`: by `Sequence` (when present) and then by ID. That covers
 * entity fields (Sequence, ID), field values (Sequence, ID), relationships and organic keys (ID), and a query's
 * fields, parameters and entities. Any other array keeps its order, since its order may carry meaning.
 */
function sortCatalogArray(items: CatalogJSONValue[]): CatalogJSONValue[] {
    const keys = items.map(sortKeyOf);
    if (keys.some((k) => k === null)) {
        return items;
    }
    const indexes = items.map((_, i) => i);
    indexes.sort((a, b) => {
        const ka = keys[a]!;
        const kb = keys[b]!;
        if (ka.sequence !== kb.sequence) {
            return (ka.sequence ?? Number.MAX_SAFE_INTEGER) - (kb.sequence ?? Number.MAX_SAFE_INTEGER);
        }
        return compareStrings(ka.id, kb.id);
    });
    return indexes.map((i) => items[i]);
}

function writeCanonical(value: CatalogJSONValue, out: string[]): void {
    if (Array.isArray(value)) {
        out.push('[');
        sortCatalogArray(value).forEach((item, i) => {
            if (i > 0) out.push(',');
            writeCanonical(item, out);
        });
        out.push(']');
        return;
    }
    if (isJSONObject(value)) {
        const keys = Object.keys(value).filter((k) => !SKIP_CATALOG_VOLATILE_KEYS.has(k)).sort(compareStrings);
        out.push('{');
        keys.forEach((key, i) => {
            if (i > 0) out.push(',');
            out.push(JSON.stringify(key), ':');
            writeCanonical(value[key], out);
        });
        out.push('}');
        return;
    }
    out.push(JSON.stringify(value));
}

/**
 * Serializes one catalog item (an entity as `EntityInfo.toJSON()` gives it, or a query object) to its canonical
 * string: the JSON the SDK would send today, with object keys sorted recursively, ID-keyed arrays sorted, nulls
 * kept and volatile timestamp keys removed. Input order never changes the output.
 */
export function CanonicalizeCatalogItem(item: object): string {
    // A JSON round trip first, so toJSON() methods, Dates and undefined behave exactly as on the wire today.
    const plain = JSON.parse(JSON.stringify(item)) as CatalogJSONValue;
    const out: string[] = [];
    writeCanonical(plain, out);
    return out.join('');
}

// ── Hashing ────────────────────────────────────────────────────────────────────────────────────

function sha256Hex(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Lowercase hex SHA-256 over the format version and the item's exact UTF-8 bytes. */
export function HashCatalogItemContent(content: string, formatVersion: number = SKIP_CATALOG_FORMAT_VERSION): string {
    return sha256Hex(`skip-catalog-item:v${formatVersion}\n${content}`);
}

/** True when `item.hash` is the hash of `item.content` under the given format version. */
export function VerifyCatalogItem(item: SkipCatalogItem, formatVersion: number): boolean {
    return typeof item.content === 'string' && HashCatalogItemContent(item.content, formatVersion) === item.hash;
}

/** Entries sorted by lowercase ID, the one order the manifest is serialized in. */
export function SortCatalogManifestEntries(entries: readonly SkipCatalogManifestEntry[]): SkipCatalogManifestEntry[] {
    return [...entries].sort((a, b) => compareStrings(a.id.toLowerCase(), b.id.toLowerCase()));
}

/** The manifest's one serialization: a version line, then `id:hash` lines sorted by ID. IDs are lowercased. */
export function SerializeCatalogManifest(entries: readonly SkipCatalogManifestEntry[], formatVersion: number = SKIP_CATALOG_FORMAT_VERSION): string {
    const lines = SortCatalogManifestEntries(entries).map((e) => `${e.id.toLowerCase()}:${e.hash}`);
    return [`skip-catalog-manifest:v${formatVersion}`, ...lines].join('\n');
}

/** Lowercase hex SHA-256 of {@link SerializeCatalogManifest}. */
export function HashCatalogManifest(entries: readonly SkipCatalogManifestEntry[], formatVersion: number = SKIP_CATALOG_FORMAT_VERSION): string {
    return sha256Hex(SerializeCatalogManifest(entries, formatVersion));
}

/** True when the manifest's hash matches its entries, and no ID appears twice. */
export function VerifyCatalogManifest(manifest: SkipCatalogManifest): boolean {
    if (!Array.isArray(manifest.items)) {
        return false;
    }
    const ids = new Set(manifest.items.map((e) => e.id.toLowerCase()));
    return ids.size === manifest.items.length && HashCatalogManifest(manifest.items, manifest.formatVersion) === manifest.manifestHash;
}

// ── Building a catalog (client side) ───────────────────────────────────────────────────────────

/** One kind's catalog in canonical form: the ref, the manifest, and every item's content keyed by lowercase ID. */
export interface BuiltCatalog {
    Ref: SkipCatalogRef;
    Manifest: SkipCatalogManifest;
    /** Lowercase ID → item */
    Items: ReadonlyMap<string, SkipCatalogItem>;
}

/**
 * Canonicalizes and hashes every item of one kind. `getID` returns the client's ID for an item. Throws when two
 * items share an ID, because the manifest could not identify them.
 */
export function BuildCatalog<T extends object>(sourceItems: readonly T[], getID: (item: T) => string): BuiltCatalog {
    const items = new Map<string, SkipCatalogItem>();
    for (const source of sourceItems) {
        const id = getID(source);
        const key = id.toLowerCase();
        if (items.has(key)) {
            throw new Error(`Catalog item ID ${id} appears more than once`);
        }
        const content = CanonicalizeCatalogItem(source);
        items.set(key, { id, hash: HashCatalogItemContent(content), content });
    }
    const entries = SortCatalogManifestEntries([...items.values()].map((i) => ({ id: i.id, hash: i.hash })));
    const manifestHash = HashCatalogManifest(entries);
    return {
        Ref: { manifestHash, formatVersion: SKIP_CATALOG_FORMAT_VERSION, itemCount: entries.length },
        Manifest: { manifestHash, formatVersion: SKIP_CATALOG_FORMAT_VERSION, items: entries },
        Items: items,
    };
}

/**
 * The items of `current` the Brain is expected to lack: every item whose hash isn't in `accepted` (the last
 * manifest the Brain accepted for this kind), or every item when nothing was accepted yet.
 */
export function DiffCatalogItems(current: BuiltCatalog, accepted: SkipCatalogManifest | null): SkipCatalogItem[] {
    const known = new Set((accepted?.items ?? []).map((e) => e.hash));
    return [...current.Items.values()].filter((i) => !known.has(i.hash));
}
