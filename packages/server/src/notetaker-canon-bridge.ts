/**
 * Notetaker → `"MJ Canon"` Bridge (`SkipNotetakerCanonBridge`).
 *
 * Bridges MemberJunction's Notetaker (`MemoryManagerAgent` / `MJ: AI Agent Notes`) and legacy
 * `Skip.Note` Markdown documents into `"MJ Canon"` (`SkipCanonMetadata`, `MJ: Graph Concepts`,
 * and `MJ: Graph Edges`) so domain-bearing notes discovered during conversations are communicated
 * to `Skip-Brain` as governed `<mj_canon>` rules with `SourcedFrom` provenance.
 */

import { createHash } from 'crypto';
import type { BaseEntity, IMetadataProvider, UserInfo } from '@memberjunction/core';
import type {
    SkipAPIAgentNote,
    SkipCanonConceptSummary,
    SkipCanonEdgeSummary,
    SkipCanonMetadata,
} from '@askskip/types';

/** Optional schema/query catalog context for resolving entity and query names in notes. */
export interface NoteCanonCatalogContext {
    entities?: Array<{ ID: string; Name: string; SchemaName?: string; BaseView?: string; BaseTable?: string }>;
    queries?: Array<{ ID: string; Name: string; CategoryPath?: string }>;
}

/** Structured Canon concept and edges extracted from a single Notetaker note or Markdown section. */
export interface CanonCandidateExtraction {
    sourceNoteId: string;
    concept?: SkipCanonConceptSummary;
    edges: SkipCanonEdgeSummary[];
    rationale: string;
}

/** Classification result for a single `SkipAPIAgentNote`. */
export interface NoteCanonClassification {
    disposition: 'canon_candidate' | 'tactical_only';
    extraction?: CanonCandidateExtraction;
    reason: string;
}

/** Options for parsing legacy multi-section Markdown note files into Canon candidates. */
export interface ParseMarkdownNotesOptions {
    sourceName?: string;
    catalog?: NoteCanonCatalogContext;
}

/** Options for persisting a promoted `SkipAPIAgentNote` into `"MJ Canon"` database entities. */
export interface PromoteNoteToCanonOptions {
    graphId?: string;
    catalog?: NoteCanonCatalogContext;
    onInvalidateCache?: () => void;
}

/** Result of promoting a `SkipAPIAgentNote` into `"MJ Canon"` database entities. */
export interface PromoteNoteToCanonResult {
    promoted: boolean;
    disposition: 'canon_candidate' | 'tactical_only';
    conceptId?: string;
    edgeIds: string[];
    reason: string;
}

const DOMAIN_METRIC_REGEX =
    /\b(sum\s*\(|count\s*\(|avg\s*\(|net\s+recognized\s+revenue|recognized\s+revenue|gross\s+margin|mrr|arr|churn\s+rate|at[- ]risk\s+revenue|threshold|formula|kpi|metric\s*:)/i;
const DOMAIN_SEGMENT_REGEX =
    /\b(segment|cohort|tier|expansion\s+ready|enterprise\s+account|mid[- ]market|health\s*score\s*>=|support\s*risk\s*tier|qualified\s+account)/i;
const DOMAIN_POLICY_REGEX =
    /\b(policy\s*:|board\s+threshold|governance\s+rule|compliance\s+rule|must\s+exclude|exclude\s+draft|exclude\s+void|exclude\s+sandbox)/i;

const PREFER_INSTEAD_OF_REGEX =
    /\b(?:always\s+)?(?:use|prefer|query)\s+`?([a-zA-Z0-9_.:-]+)`?\s+(?:instead\s+of|over|rather\s+than)\s+`?([a-zA-Z0-9_.:-]+)`?/gi;
const NEVER_USE_PREFER_REGEX =
    /\b(?:never\s+(?:use|query)|do\s+not\s+(?:use|query)|avoid)\s+`?([a-zA-Z0-9_.:-]+)`?[^.\n]*?\b(?:use|prefer|query)\s+`?([a-zA-Z0-9_.:-]+)`?/gi;
const MEASURES_QUERY_REGEX =
    /\b(?:stored\s+)?query\s+`?([a-zA-Z0-9_/-]+)`?\s+(?:measures|computes|calculates)\s+["'`]?([^"'`.;\n]+)["'`]?/gi;

/**
 * Deterministically derives a UUID-shaped or stable slug ID from a seed string.
 */
export function deriveNoteCanonId(prefix: string, seed: string): string {
    const digest = createHash('sha256').update(`${prefix}:${seed}`, 'utf8').digest('hex').slice(0, 24);
    return `${prefix}-${digest}`;
}

/**
 * Classifies a `SkipAPIAgentNote` from the Notetaker as either `'canon_candidate'`
 * (governed domain concept, metric formula, cohort rule, or table/view precedence)
 * or `'tactical_only'` (user formatting preference, UI preference, or tactical instruction).
 */
export function classifyNoteForCanon(
    note: SkipAPIAgentNote,
    catalog?: NoteCanonCatalogContext,
): NoteCanonClassification {
    const text = (note.note ?? '').trim();
    if (!text) {
        return { disposition: 'tactical_only', reason: 'Empty note text' };
    }

    const preferredPairs = extractPreferredOverPairs(text);
    const measuredBindings = extractMeasuresBindings(text);
    const conceptType = inferConceptType(text, note.agentNoteType);

    if (!conceptType && preferredPairs.length === 0 && measuredBindings.length === 0) {
        return {
            disposition: 'tactical_only',
            reason: 'Note expresses tactical or formatting guidance without domain concepts or table precedence',
        };
    }

    const concept = conceptType ? buildConceptFromNote(note, text, conceptType, catalog) : undefined;
    const edges = buildEdgesFromNote(note, text, concept, preferredPairs, measuredBindings, catalog);

    return {
        disposition: 'canon_candidate',
        extraction: {
            sourceNoteId: note.id,
            concept,
            edges,
            rationale: `Promoted from Notetaker (${note.agentNoteType || note.type})`,
        },
        reason: concept
            ? `Classified as ${concept.conceptType} concept "${concept.displayName || concept.name}" with ${edges.length} edge(s)`
            : `Extracted ${edges.length} governed edge(s) from note`,
    };
}

function inferConceptType(
    text: string,
    noteTypeName: string | undefined,
): 'Metric' | 'Segment' | 'Policy' | null {
    const typeLower = (noteTypeName ?? '').toLowerCase();
    if (typeLower.includes('metric') || typeLower.includes('kpi') || DOMAIN_METRIC_REGEX.test(text)) {
        return 'Metric';
    }
    if (typeLower.includes('segment') || typeLower.includes('cohort') || DOMAIN_SEGMENT_REGEX.test(text)) {
        return 'Segment';
    }
    if (typeLower.includes('policy') || DOMAIN_POLICY_REGEX.test(text)) {
        return 'Policy';
    }
    return null;
}

function extractConceptHeading(text: string, fallbackType: string, noteId: string): { name: string; displayName: string } {
    const colonMatch = text.match(/^(?:#+\s*)?([A-Za-z0-9][A-Za-z0-9 _/-]{2,60}?)\s*[:—-]\s+/);
    if (colonMatch) {
        const cleaned = colonMatch[1]
            .replace(/^(?:cfo|board|company|global|domain)\s+policy\s*$/i, '')
            .trim();
        if (cleaned.length >= 3) {
            return { name: cleaned, displayName: cleaned };
        }
    }
    const quotedMatch = text.match(/["']([A-Z][A-Za-z0-9 _-]{2,50})["']/);
    if (quotedMatch) {
        return { name: quotedMatch[1].trim(), displayName: quotedMatch[1].trim() };
    }
    const namedMetricMatch = text.match(
        /\b(Net Recognized Revenue|Recognized Revenue|Board At-Risk Revenue Threshold|At-Risk Revenue|Expansion Ready Account|Active Member|Enterprise Segment)\b/i,
    );
    if (namedMetricMatch) {
        return { name: namedMetricMatch[1], displayName: namedMetricMatch[1] };
    }
    const firstClause = text.split(/[.;\n]/)[0].trim().slice(0, 48);
    const label = firstClause.length >= 4 ? firstClause : `${fallbackType} (${noteId.slice(0, 8)})`;
    return { name: label, displayName: label };
}

function extractAntiDefinition(text: string): string | null {
    const antiMatch = text.match(
        /\b(?:never\s+(?:use|include)|do\s+not\s+(?:use|include|confuse\s+with)|must\s+exclude|exclude)\s+([^.;\n]+)/i,
    );
    return antiMatch ? antiMatch[1].trim() : null;
}

function buildConceptFromNote(
    note: SkipAPIAgentNote,
    text: string,
    conceptType: 'Metric' | 'Segment' | 'Policy',
    catalog?: NoteCanonCatalogContext,
): SkipCanonConceptSummary {
    const { name, displayName } = extractConceptHeading(text, conceptType, note.id);
    const ownerEntityName = resolveReferencedEntityName(text, catalog);
    return {
        id: deriveNoteCanonId('note-concept', note.id),
        name,
        displayName,
        conceptType,
        status: 'Active',
        definition: text,
        antiDefinition: extractAntiDefinition(text),
        ownerEntityName,
        precedenceRank: note.type === 'Global' ? 95 : 75,
        confidenceScore: 0.9,
    };
}

function extractPreferredOverPairs(text: string): Array<{ preferred: string; deprecated: string }> {
    const pairs: Array<{ preferred: string; deprecated: string }> = [];
    const seen = new Set<string>();

    const addPair = (preferred: string, deprecated: string) => {
        const p = preferred.replace(/^`|`$/g, '').replace(/[.,;:]+$/, '').trim();
        const d = deprecated.replace(/^`|`$/g, '').replace(/[.,;:]+$/, '').trim();
        if (!p || !d || p.toLowerCase() === d.toLowerCase()) return;
        const key = `${p.toLowerCase()}>>${d.toLowerCase()}`;
        if (!seen.has(key)) {
            seen.add(key);
            pairs.push({ preferred: p, deprecated: d });
        }
    };

    for (const match of text.matchAll(PREFER_INSTEAD_OF_REGEX)) {
        addPair(match[1], match[2]);
    }
    for (const match of text.matchAll(NEVER_USE_PREFER_REGEX)) {
        addPair(match[2], match[1]);
    }
    return pairs;
}

function extractMeasuresBindings(text: string): Array<{ queryName: string; targetConcept: string }> {
    const bindings: Array<{ queryName: string; targetConcept: string }> = [];
    for (const match of text.matchAll(MEASURES_QUERY_REGEX)) {
        const queryName = match[1].trim();
        const targetConcept = match[2].trim();
        if (queryName && targetConcept) {
            bindings.push({ queryName, targetConcept });
        }
    }
    return bindings;
}

function resolveCatalogToken(
    token: string,
    catalog?: NoteCanonCatalogContext,
): { entityName: string; recordId: string } {
    const clean = token.replace(/[.,;:]+$/, '').trim();
    const lower = clean.toLowerCase();
    const strippedSchema = lower.includes('.') ? lower.split('.').pop()! : lower;

    const matchedQuery = catalog?.queries?.find(
        (q) => q.Name.toLowerCase() === lower || q.Name.toLowerCase() === strippedSchema,
    );
    if (matchedQuery) {
        return { entityName: 'MJ: Queries', recordId: matchedQuery.ID };
    }

    const matchedEntity = catalog?.entities?.find(
        (e) =>
            e.Name.toLowerCase() === lower ||
            e.Name.toLowerCase() === strippedSchema ||
            e.BaseView?.toLowerCase() === strippedSchema ||
            e.BaseTable?.toLowerCase() === strippedSchema,
    );
    if (matchedEntity) {
        return { entityName: 'MJ: Entities', recordId: matchedEntity.ID };
    }

    return { entityName: 'MJ: Entities', recordId: clean };
}

function resolveReferencedEntityName(text: string, catalog?: NoteCanonCatalogContext): string | null {
    if (!catalog?.entities) return null;
    const lowerText = text.toLowerCase();
    for (const entity of catalog.entities) {
        const candidates = [entity.Name, entity.BaseView, entity.BaseTable].filter(
            (v): v is string => typeof v === 'string' && v.length > 0,
        );
        if (candidates.some((c) => lowerText.includes(c.toLowerCase()))) {
            return entity.Name;
        }
    }
    return null;
}

function buildEdgesFromNote(
    note: SkipAPIAgentNote,
    text: string,
    concept: SkipCanonConceptSummary | undefined,
    preferredPairs: Array<{ preferred: string; deprecated: string }>,
    measuredBindings: Array<{ queryName: string; targetConcept: string }>,
    catalog?: NoteCanonCatalogContext,
): SkipCanonEdgeSummary[] {
    const edges: SkipCanonEdgeSummary[] = [];

    for (const pair of preferredPairs) {
        const src = resolveCatalogToken(pair.preferred, catalog);
        const tgt = resolveCatalogToken(pair.deprecated, catalog);
        edges.push({
            id: deriveNoteCanonId('note-edge-pref', `${note.id}:${pair.preferred}:${pair.deprecated}`),
            edgeType: 'Preferred Over',
            sourceEntityName: src.entityName,
            sourceRecordID: src.recordId,
            targetEntityName: tgt.entityName,
            targetRecordID: tgt.recordId,
            direction: 'Directed',
            weight: 1,
            confidenceScore: 0.92,
            status: 'Approved',
            rationale: text,
            predicate: null,
            origin: 'Notetaker',
        });
    }

    for (const binding of measuredBindings) {
        const qToken = resolveCatalogToken(binding.queryName, catalog);
        const targetId = concept ? concept.id : binding.targetConcept;
        edges.push({
            id: deriveNoteCanonId('note-edge-meas', `${note.id}:${binding.queryName}:${targetId}`),
            edgeType: 'Measures',
            sourceEntityName: qToken.entityName,
            sourceRecordID: qToken.recordId,
            targetEntityName: 'MJ: Graph Concepts',
            targetRecordID: targetId,
            direction: 'Directed',
            weight: 1,
            confidenceScore: 0.9,
            status: 'Approved',
            rationale: text,
            predicate: null,
            origin: 'Notetaker',
        });
    }

    if (concept) {
        edges.push({
            id: deriveNoteCanonId('note-edge-src', `${note.id}:${concept.id}`),
            edgeType: 'SourcedFrom',
            sourceEntityName: 'MJ: Graph Concepts',
            sourceRecordID: concept.id,
            targetEntityName: 'MJ: AI Agent Notes',
            targetRecordID: note.id,
            direction: 'Directed',
            weight: 1,
            confidenceScore: 1,
            status: 'Approved',
            rationale: `Promoted from AI Agent Note (${note.agentNoteType || note.type})`,
            predicate: null,
            origin: 'Notetaker',
        });
    }

    return edges;
}

/**
 * Enriches a client's `SkipCanonMetadata` payload with domain-bearing `SkipAPIAgentNote`s
 * classified by `classifyNoteForCanon`. Deduplicates against existing concepts and edges
 * so governed database rows always take precedence over Notetaker-derived candidates.
 */
export function enrichCanonWithAgentNotes(
    canon: SkipCanonMetadata | undefined,
    notes: SkipAPIAgentNote[] | undefined,
    catalog?: NoteCanonCatalogContext,
): SkipCanonMetadata | undefined {
    if (!notes || notes.length === 0) {
        return canon;
    }

    const candidates = notes
        .map((n) => classifyNoteForCanon(n, catalog))
        .filter((c): c is NoteCanonClassification & { extraction: CanonCandidateExtraction } =>
            c.disposition === 'canon_candidate' && Boolean(c.extraction),
        )
        .map((c) => c.extraction);

    if (candidates.length === 0) {
        return canon;
    }

    const existingConcepts = canon?.concepts ? [...canon.concepts] : [];
    const existingEdges = canon?.edges ? [...canon.edges] : [];
    const conceptNames = new Set(existingConcepts.map((c) => c.name.trim().toLowerCase()));
    const edgeKeys = new Set(
        existingEdges.map(
            (e) =>
                `${e.edgeType.toLowerCase()}|${e.sourceEntityName.toLowerCase()}|${e.sourceRecordID.toLowerCase()}|${e.targetEntityName.toLowerCase()}|${e.targetRecordID.toLowerCase()}`,
        ),
    );

    const addedConcepts: SkipCanonConceptSummary[] = [];
    const addedEdges: SkipCanonEdgeSummary[] = [];

    for (const item of candidates) {
        if (item.concept && !conceptNames.has(item.concept.name.trim().toLowerCase())) {
            conceptNames.add(item.concept.name.trim().toLowerCase());
            existingConcepts.push(item.concept);
            addedConcepts.push(item.concept);
        }
        for (const edge of item.edges) {
            const key = `${edge.edgeType.toLowerCase()}|${edge.sourceEntityName.toLowerCase()}|${edge.sourceRecordID.toLowerCase()}|${edge.targetEntityName.toLowerCase()}|${edge.targetRecordID.toLowerCase()}`;
            if (!edgeKeys.has(key)) {
                edgeKeys.add(key);
                existingEdges.push(edge);
                addedEdges.push(edge);
            }
        }
    }

    const domainDocument = appendNotetakerSectionToDomainDocument(
        canon?.domainDocument,
        addedConcepts,
        addedEdges,
    );

    return {
        concepts: existingConcepts,
        edges: existingEdges,
        ...(canon?.alternateBaseViews?.length ? { alternateBaseViews: canon.alternateBaseViews } : {}),
        ...(domainDocument ? { domainDocument } : {}),
    };
}

function appendNotetakerSectionToDomainDocument(
    baseDoc: string | undefined,
    addedConcepts: SkipCanonConceptSummary[],
    addedEdges: SkipCanonEdgeSummary[],
): string | undefined {
    const preferredEdges = addedEdges.filter((e) => e.edgeType === 'Preferred Over');
    if (addedConcepts.length === 0 && preferredEdges.length === 0) {
        return baseDoc;
    }

    const lines: string[] = [];
    if (baseDoc && baseDoc.trim().length > 0) {
        lines.push(baseDoc.trim(), '');
    } else {
        lines.push('# MJ Canon — Governed Domain Knowledge', '');
    }

    lines.push('## Notetaker-Derived Canon Rules (MJ: AI Agent Notes)');
    for (const edge of preferredEdges) {
        const why = edge.rationale ? ` — ${edge.rationale}` : '';
        lines.push(
            `- **PREFER** \`${edge.sourceEntityName}\` (\`${edge.sourceRecordID}\`) **OVER** \`${edge.targetEntityName}\` (\`${edge.targetRecordID}\`) [Origin: Notetaker]${why}`,
        );
    }
    for (const c of addedConcepts) {
        const anti = c.antiDefinition ? ` *(Do NOT confuse with: ${c.antiDefinition})*` : '';
        lines.push(`- **${c.displayName || c.name}** [${c.conceptType}, Origin: Notetaker]: ${c.definition}${anti}`);
    }

    return lines.join('\n');
}

/**
 * Parses legacy multi-section `Skip.Note` Markdown documents (such as `PLUS_DataExpert.md` or
 * `MoreCheese_DataExpert.md`) containing headings and request-pattern tables into structured
 * `"MJ Canon"` concept and edge candidates.
 */
export function parseMarkdownNotesToCanon(
    markdown: string,
    options?: ParseMarkdownNotesOptions,
): CanonCandidateExtraction[] {
    const sourceName = options?.sourceName ?? 'markdown-note';
    const catalog = options?.catalog;
    const sections = markdown.split(/^##+\s+/m).filter((s) => s.trim().length > 0);
    const extractions: CanonCandidateExtraction[] = [];

    for (let i = 0; i < sections.length; i++) {
        const lines = sections[i].trim().split('\n');
        const heading = lines[0].replace(/^#+\s*/, '').trim();
        const body = lines.slice(1).join('\n').trim();
        if (!heading || !body) continue;

        const syntheticNote: SkipAPIAgentNote = {
            id: deriveNoteCanonId('md-section', `${sourceName}:${i}:${heading}`),
            agentNoteTypeId: 'markdown-import',
            agentNoteType: heading,
            createdAt: new Date(0),
            updatedAt: new Date(0),
            note: `${heading}: ${body}`,
            type: 'Global',
            userId: null,
            user: null,
        };

        const tableEdges = parseMarkdownTablePrecedenceEdges(body, syntheticNote.id, catalog);
        const classification = classifyNoteForCanon(syntheticNote, catalog);
        if (classification.disposition === 'canon_candidate' && classification.extraction) {
            const combinedEdges = [...classification.extraction.edges, ...tableEdges];
            extractions.push({
                ...classification.extraction,
                edges: combinedEdges,
            });
        } else if (tableEdges.length > 0) {
            extractions.push({
                sourceNoteId: syntheticNote.id,
                edges: tableEdges,
                rationale: `Extracted from Markdown table in section "${heading}"`,
            });
        }
    }

    return extractions;
}

function parseMarkdownTablePrecedenceEdges(
    body: string,
    sourceId: string,
    catalog?: NoteCanonCatalogContext,
): SkipCanonEdgeSummary[] {
    const edges: SkipCanonEdgeSummary[] = [];
    const lines = body
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('|') && l.endsWith('|'));

    if (lines.length < 3) return edges;

    const headers = lines[0]
        .split('|')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
    const prefIdx = headers.findIndex((h) => h.includes('prefer') || h.includes('canonical') || h.includes('use'));
    const avoidIdx = headers.findIndex((h) => h.includes('avoid') || h.includes('deprecated') || h.includes('instead'));
    const rationaleIdx = headers.findIndex((h) => h.includes('rationale') || h.includes('notes') || h.includes('why'));

    if (prefIdx === -1 || avoidIdx === -1) return edges;

    for (const rowLine of lines.slice(2)) {
        if (/^\|[\s:-]+\|$/.test(rowLine)) continue;
        const cells = rowLine
            .split('|')
            .slice(1, -1)
            .map((c) => c.replace(/`/g, '').trim());
        const preferred = cells[prefIdx];
        const avoided = cells[avoidIdx];
        const rationale = rationaleIdx >= 0 ? cells[rationaleIdx] : null;
        if (!preferred || !avoided || preferred === '-' || avoided === '-') continue;

        const src = resolveCatalogToken(preferred, catalog);
        const tgt = resolveCatalogToken(avoided, catalog);
        edges.push({
            id: deriveNoteCanonId('md-table-pref', `${sourceId}:${preferred}:${avoided}`),
            edgeType: 'Preferred Over',
            sourceEntityName: src.entityName,
            sourceRecordID: src.recordId,
            targetEntityName: tgt.entityName,
            targetRecordID: tgt.recordId,
            direction: 'Directed',
            weight: 1,
            confidenceScore: 0.95,
            status: 'Approved',
            rationale: rationale || `Markdown table rule: prefer ${preferred} over ${avoided}`,
            predicate: null,
            origin: 'Notetaker',
        });
    }

    return edges;
}

/**
 * Promotes a domain-bearing `SkipAPIAgentNote` into physical `"MJ Canon"` entities
 * (`MJ: Graph Concepts` and `MJ: Graph Edges`, including a `SourcedFrom` provenance edge
 * back to `MJ: AI Agent Notes`).
 */
export async function promoteNoteToCanon(
    note: SkipAPIAgentNote,
    provider: IMetadataProvider,
    contextUser: UserInfo,
    options?: PromoteNoteToCanonOptions,
): Promise<PromoteNoteToCanonResult> {
    const classification = classifyNoteForCanon(note, options?.catalog);
    if (classification.disposition !== 'canon_candidate' || !classification.extraction) {
        return {
            promoted: false,
            disposition: 'tactical_only',
            edgeIds: [],
            reason: classification.reason,
        };
    }

    const { concept, edges } = classification.extraction;
    let savedConceptId: string | undefined;
    const savedEdgeIds: string[] = [];

    if (concept) {
        const conceptEntity = (await provider.GetEntityObject<BaseEntity>(
            'MJ: Graph Concepts',
            contextUser,
        )) as unknown as Record<string, unknown>;
        if (typeof conceptEntity.NewRecord === 'function') {
            (conceptEntity.NewRecord as () => void)();
        }
        if (options?.graphId) {
            conceptEntity.GraphID = options.graphId;
        }
        conceptEntity.Name = concept.name;
        conceptEntity.DisplayName = concept.displayName ?? concept.name;
        conceptEntity.ConceptType = concept.conceptType;
        conceptEntity.Status = 'Approved';
        conceptEntity.Definition = concept.definition;
        conceptEntity.AntiDefinition = concept.antiDefinition ?? null;
        conceptEntity.PrecedenceRank = concept.precedenceRank;
        conceptEntity.ConfidenceScore = concept.confidenceScore ?? 0.9;

        const saved = typeof conceptEntity.Save === 'function' ? await (conceptEntity.Save as () => Promise<boolean>)() : false;
        if (saved) {
            savedConceptId = String(conceptEntity.ID ?? concept.id);
        }
    }

    for (const edge of edges) {
        const edgeEntity = (await provider.GetEntityObject<BaseEntity>(
            'MJ: Graph Edges',
            contextUser,
        )) as unknown as Record<string, unknown>;
        if (typeof edgeEntity.NewRecord === 'function') {
            (edgeEntity.NewRecord as () => void)();
        }
        if (options?.graphId) {
            edgeEntity.GraphID = options.graphId;
        }
        edgeEntity.EdgeType = edge.edgeType;
        edgeEntity.SourceEntity = edge.sourceEntityName;
        edgeEntity.SourceRecordID =
            edge.sourceEntityName === 'MJ: Graph Concepts' && savedConceptId
                ? savedConceptId
                : edge.sourceRecordID;
        edgeEntity.TargetEntity = edge.targetEntityName;
        edgeEntity.TargetRecordID =
            edge.targetEntityName === 'MJ: Graph Concepts' && savedConceptId
                ? savedConceptId
                : edge.targetRecordID;
        edgeEntity.Direction = edge.direction;
        edgeEntity.Weight = edge.weight;
        edgeEntity.Confidence = edge.confidenceScore ?? 0.9;
        edgeEntity.Status = 'Approved';
        edgeEntity.Description = edge.rationale ?? null;
        edgeEntity.Origin = 'Notetaker';

        const saved = typeof edgeEntity.Save === 'function' ? await (edgeEntity.Save as () => Promise<boolean>)() : false;
        if (saved) {
            savedEdgeIds.push(String(edgeEntity.ID ?? edge.id));
        }
    }

    options?.onInvalidateCache?.();

    return {
        promoted: Boolean(savedConceptId || savedEdgeIds.length > 0),
        disposition: 'canon_candidate',
        conceptId: savedConceptId,
        edgeIds: savedEdgeIds,
        reason: classification.reason,
    };
}
