/**
 * Read-Only Notetaker / Canon Provenance Helpers (`notetaker-canon-bridge`).
 *
 * Per MemberJunction/MJ #6675 Decisions 3 & 4:
 * - Note-to-Canon promotion lives once in MJ Core (tracked in MJ #6213), where any
 *   machine-promoted row is written as `Origin = 'Inferred'`, `Status = 'Proposed'`
 *   behind the `Graph: Approve Edges` gate — never `Origin = 'Declared'` from the client.
 * - Client `MJ: AI Agent Notes` are sent to Skip Brain as notes (`request.notes`),
 *   clearly labelled as agent notes and NEVER auto-synthesized into `request.canon`.
 * - This module provides read-only classification (using the shipped Canon vocabulary:
 *   `Policy`, `Metric`, `Process`, `Role`, `Domain`, `Term`) and provenance annotation
 *   indicating when a note already has a `SourcedFrom` edge in `MJ Canon`.
 */

import type {
    SkipAPIAgentNote,
    SkipCanonConceptType,
    SkipCanonMetadata,
} from '@askskip/types';

/** Read-only classification result for a single `SkipAPIAgentNote`. */
export interface NoteCanonClassification {
    disposition: 'canon_candidate' | 'agent_behavior_only';
    suggestedConceptType?: SkipCanonConceptType;
    reason: string;
}

/** Shipped `MJ: Graph Concepts` concept types (per MJ #6675 Decision 5). */
export const SHIPPED_CANON_CONCEPT_TYPES: readonly SkipCanonConceptType[] = [
    'Policy',
    'Metric',
    'Process',
    'Role',
    'Domain',
    'Term',
];

const DOMAIN_METRIC_REGEX =
    /\b(sum\s*\(|count\s*\(|avg\s*\(|net\s+recognized\s+revenue|recognized\s+revenue|gross\s+margin|mrr|arr|churn\s+rate|at[- ]risk\s+revenue|threshold|formula|kpi|metric\s*:)/i;
const DOMAIN_POLICY_REGEX =
    /\b(policy\s*:|board\s+threshold|governance\s+rule|compliance\s+rule|must\s+exclude|exclude\s+draft|exclude\s+void|exclude\s+sandbox)/i;
const DOMAIN_PROCESS_REGEX =
    /\b(process\s*:|workflow|approval\s+step|onboarding\s+procedure|renewal\s+cycle|closeout\s+steps)/i;
const DOMAIN_ROLE_REGEX =
    /\b(role\s*:|steward|data\s+owner|approver|executive\s+sponsor|committee\s+chair)/i;
const DOMAIN_DOMAIN_REGEX =
    /\b(domain\s*:|subject\s+area|bounded\s+context|segment|cohort|tier)/i;
const DOMAIN_TERM_REGEX =
    /\b(defined\s+as|means\s+|refers\s+to|synonym\s+for|always\s+use\s+`?[a-zA-Z0-9_.:-]+`?\s+(?:instead\s+of|over))/i;

/**
 * Classifies a `SkipAPIAgentNote` (read-only) as either a `'canon_candidate'` (defines a
 * business term, metric, policy, process, role, or domain — which belongs in `MJ: Graph Concepts`
 * via MJ Core's `Inferred` + `Proposed` promotion pipeline) or `'agent_behavior_only'`
 * (agent guardrail / formatting preference that stays in `MJ: AI Agent Notes`).
 */
export function classifyNoteForCanon(note: SkipAPIAgentNote): NoteCanonClassification {
    const text = (note.note ?? '').trim();
    if (!text) {
        return { disposition: 'agent_behavior_only', reason: 'Empty note text' };
    }

    const suggestedConceptType = inferShippedConceptType(text, note.agentNoteType);
    if (!suggestedConceptType) {
        return {
            disposition: 'agent_behavior_only',
            reason: 'Note expresses agent behavior or formatting guidance without a business concept definition',
        };
    }

    return {
        disposition: 'canon_candidate',
        suggestedConceptType,
        reason: `Candidate ${suggestedConceptType} concept for MJ Core promotion (Origin='Inferred', Status='Proposed')`,
    };
}

function inferShippedConceptType(
    text: string,
    noteTypeName: string | undefined,
): SkipCanonConceptType | null {
    const typeLower = (noteTypeName ?? '').toLowerCase();
    if (typeLower.includes('metric') || typeLower.includes('kpi') || DOMAIN_METRIC_REGEX.test(text)) {
        return 'Metric';
    }
    if (typeLower.includes('policy') || DOMAIN_POLICY_REGEX.test(text)) {
        return 'Policy';
    }
    if (typeLower.includes('process') || typeLower.includes('workflow') || DOMAIN_PROCESS_REGEX.test(text)) {
        return 'Process';
    }
    if (typeLower.includes('role') || DOMAIN_ROLE_REGEX.test(text)) {
        return 'Role';
    }
    if (typeLower.includes('domain') || typeLower.includes('segment') || typeLower.includes('cohort') || DOMAIN_DOMAIN_REGEX.test(text)) {
        return 'Domain';
    }
    if (typeLower.includes('term') || typeLower.includes('definition') || DOMAIN_TERM_REGEX.test(text)) {
        return 'Term';
    }
    return null;
}

/**
 * Returns the set of `MJ: AI Agent Notes` IDs that are already linked to an approved
 * `MJ Canon` concept via a `SourcedFrom` edge. Does NOT mutate `canon` or synthesize
 * any Canon concepts/edges.
 */
export function findPromotedNoteIds(canon: SkipCanonMetadata | undefined): Set<string> {
    const promoted = new Set<string>();
    if (!canon?.edges?.length) {
        return promoted;
    }
    for (const edge of canon.edges) {
        if (edge.edgeType.trim().toLowerCase() !== 'sourcedfrom') {
            continue;
        }
        const targetEntity = edge.targetEntityName.trim().toLowerCase();
        const sourceEntity = edge.sourceEntityName.trim().toLowerCase();
        if (targetEntity === 'mj: ai agent notes' && edge.targetRecordID) {
            promoted.add(edge.targetRecordID.toLowerCase());
        } else if (sourceEntity === 'mj: ai agent notes' && edge.sourceRecordID) {
            promoted.add(edge.sourceRecordID.toLowerCase());
        }
    }
    return promoted;
}
