import { describe, it, expect } from 'vitest';
import {
    classifyNoteForCanon,
    findPromotedNoteIds,
    SHIPPED_CANON_CONCEPT_TYPES,
} from '../../src/notetaker-canon-bridge.js';
import {
    SKIP_DATA_ANSWERER_TEMPLATE_TEXT,
    SKIP_ANALYST_TEMPLATE_TEXT,
    SKIP_SCHEMA_GUIDE_TEMPLATE_TEXT,
} from '@askskip/core';
import type { SkipAPIAgentNote, SkipCanonMetadata } from '@askskip/types';

function makeNote(overrides: Partial<SkipAPIAgentNote>): SkipAPIAgentNote {
    return {
        id: 'note-1',
        agentNoteTypeId: 'type-1',
        note: '',
        type: 'Global',
        user: null,
        createdAt: new Date('2026-11-01T00:00:00Z'),
        updatedAt: new Date('2026-11-01T00:00:00Z'),
        ...overrides,
    };
}

describe('notetaker-canon-bridge (MJ #6675 Decisions 3-5)', () => {
    it('uses only the shipped MJ Canon concept types', () => {
        expect(SHIPPED_CANON_CONCEPT_TYPES).toEqual([
            'Policy',
            'Metric',
            'Process',
            'Role',
            'Domain',
            'Term',
        ]);
    });

    it('classifies domain-bearing notes as read-only canon candidates using shipped vocabulary', () => {
        const metricNote = makeNote({
            note: 'Net Recognized Revenue = SUM(LineTotal) excluding draft invoices.',
        });
        const metricRes = classifyNoteForCanon(metricNote);
        expect(metricRes.disposition).toBe('canon_candidate');
        expect(metricRes.suggestedConceptType).toBe('Metric');
        expect(metricRes.reason).toContain("Origin='Inferred'");
        expect(metricRes.reason).toContain("Status='Proposed'");

        const policyNote = makeNote({
            note: 'Policy: Always exclude void and sandbox records from board reporting.',
        });
        const policyRes = classifyNoteForCanon(policyNote);
        expect(policyRes.disposition).toBe('canon_candidate');
        expect(policyRes.suggestedConceptType).toBe('Policy');

        const behaviorNote = makeNote({
            note: 'Prefer concise bullet points and format currency with two decimal places.',
        });
        const behaviorRes = classifyNoteForCanon(behaviorNote);
        expect(behaviorRes.disposition).toBe('agent_behavior_only');
        expect(behaviorRes.suggestedConceptType).toBeUndefined();
    });

    it('identifies notes already promoted into MJ Canon via SourcedFrom edges without mutating canon', () => {
        const canon: SkipCanonMetadata = {
            concepts: [
                {
                    id: 'c-1',
                    name: 'Open AR',
                    conceptType: 'Metric',
                    status: 'Approved',
                    definition: 'Unpaid invoices',
                    precedenceRank: 0,
                },
            ],
            edges: [
                {
                    id: 'e-1',
                    edgeType: 'SourcedFrom',
                    sourceEntityName: 'MJ: Graph Concepts',
                    sourceRecordID: 'c-1',
                    targetEntityName: 'MJ: AI Agent Notes',
                    targetRecordID: 'NOTE-ABC-123',
                    direction: 'Directed',
                    weight: 1,
                    status: 'Approved',
                    origin: 'Inferred',
                },
            ],
        };

        const promoted = findPromotedNoteIds(canon);
        expect(promoted.has('note-abc-123')).toBe(true);
        expect(promoted.size).toBe(1);
        expect(canon.concepts).toHaveLength(1);
    });

    it('instructs Skip Local sub-agents bound to Get Graph Context to handle AMBIGUOUS_CONCEPT and NO_MATCH', () => {
        for (const prompt of [
            SKIP_DATA_ANSWERER_TEMPLATE_TEXT,
            SKIP_ANALYST_TEMPLATE_TEXT,
            SKIP_SCHEMA_GUIDE_TEMPLATE_TEXT,
        ]) {
            expect(prompt).toContain('AMBIGUOUS_CONCEPT');
            expect(prompt).toContain('NO_MATCH');
            expect(prompt).toContain('Candidates');
            expect(prompt).not.toContain('UsesQuery');
            expect(prompt).not.toContain('DefinesSubsetOf');
            expect(prompt).not.toContain('SupersededBy');
        }
    });
});
