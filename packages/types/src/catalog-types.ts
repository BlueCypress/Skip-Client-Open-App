/**
 * Wire types for the client metadata catalog (Skip-Brain plan `client-metadata-catalog-cache.md`, §4). Pure types
 * and constants, safe for the main entry point; the canonical form and hashing live in `@askskip/types/catalog`.
 */

/** Version of the canonical form and hashing below. Part of every hashed byte string. */
export const SKIP_CATALOG_FORMAT_VERSION = 1;

/** The catalog kinds a request can carry by reference. */
export const SkipCatalogKind = {
    Entities: 'entities',
    Queries: 'queries',
} as const;
export type SkipCatalogKind = typeof SkipCatalogKind[keyof typeof SkipCatalogKind];

/** Every catalog kind, in a fixed order. */
export const SKIP_CATALOG_KINDS: readonly SkipCatalogKind[] = [SkipCatalogKind.Entities, SkipCatalogKind.Queries];

/** Keys left out of the canonical form: they change without a real metadata change (a CodeGen run touches them). */
export const SKIP_CATALOG_VOLATILE_KEYS: ReadonlySet<string> = new Set(['__mj_CreatedAt', '__mj_UpdatedAt']);

// ── Wire types (field names are a contract with the Skip Brain) ────────────────────────────────

/** A reference to one kind's catalog, sent on a normal turn instead of the catalog itself. */
export interface SkipCatalogRef {
    /** Lowercase hex SHA-256 of the canonical manifest */
    manifestHash: string; // case-violation-ok-legacy-back-compat: wire field read by the Skip Brain
    /** The {@link SKIP_CATALOG_FORMAT_VERSION} the hashes were computed with */
    formatVersion: number; // case-violation-ok-legacy-back-compat: wire field read by the Skip Brain
    /** Number of items in the manifest */
    itemCount: number; // case-violation-ok-legacy-back-compat: wire field read by the Skip Brain
}

/** One manifest entry: the client's ID for the entity or query, and its content hash. */
export interface SkipCatalogManifestEntry {
    id: string; // case-violation-ok-legacy-back-compat: wire field read by the Skip Brain
    hash: string; // case-violation-ok-legacy-back-compat: wire field read by the Skip Brain
}

/** The full list of one kind's items, sent only after the Brain reports a miss. */
export interface SkipCatalogManifest {
    manifestHash: string; // case-violation-ok-legacy-back-compat: wire field read by the Skip Brain
    formatVersion: number; // case-violation-ok-legacy-back-compat: wire field read by the Skip Brain
    /** Sorted by ID, as {@link SerializeCatalogManifest} orders them */
    items: SkipCatalogManifestEntry[]; // case-violation-ok-legacy-back-compat: wire field read by the Skip Brain
}

/** One item's content, sent only when the Brain lacks it. */
export interface SkipCatalogItem {
    id: string; // case-violation-ok-legacy-back-compat: wire field read by the Skip Brain
    hash: string; // case-violation-ok-legacy-back-compat: wire field read by the Skip Brain
    /** The exact canonical string the hash was computed over */
    content: string; // case-violation-ok-legacy-back-compat: wire field read by the Skip Brain
}

/** Per-kind refs on a normal request. */
export interface SkipCatalogRefs {
    entities?: SkipCatalogRef; // case-violation-ok-legacy-back-compat: wire field read by the Skip Brain
    queries?: SkipCatalogRef; // case-violation-ok-legacy-back-compat: wire field read by the Skip Brain
}

/** Per-kind manifests on a retry after `catalog_miss`. */
export interface SkipCatalogManifests {
    entities?: SkipCatalogManifest; // case-violation-ok-legacy-back-compat: wire field read by the Skip Brain
    queries?: SkipCatalogManifest; // case-violation-ok-legacy-back-compat: wire field read by the Skip Brain
}

/** Per-kind items on a retry after `catalog_miss`. */
export interface SkipCatalogItems {
    entities?: SkipCatalogItem[]; // case-violation-ok-legacy-back-compat: wire field read by the Skip Brain
    queries?: SkipCatalogItem[]; // case-violation-ok-legacy-back-compat: wire field read by the Skip Brain
}

/** The item IDs of one kind that the Brain still lacks after a retry. */
export interface SkipCatalogMissingItems {
    kind: SkipCatalogKind; // case-violation-ok-legacy-back-compat: wire field read by the Skip SDK
    ids: string[]; // case-violation-ok-legacy-back-compat: wire field read by the Skip SDK
}
