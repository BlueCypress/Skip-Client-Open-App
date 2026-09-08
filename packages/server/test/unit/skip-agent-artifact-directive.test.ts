/**
 * @fileoverview SkipProxyAgent must forward Skip's artifactRequest to the MJ framework as an
 * artifactDirective on BOTH response phases (#529). Without it, MJ versions whatever
 * sourceArtifactId the client sent — a new-topic build becomes vN of the previous artifact.
 */
import { describe, it, expect, vi } from 'vitest';
import { SkipResponsePhase } from '@askskip/types';
import type {
    SkipAPIAnalysisCompleteResponse,
    SkipAPIClarifyingQuestionResponse,
    SkipAPIArtifactRequest,
} from '@askskip/types';

vi.mock('@memberjunction/ai-agents', () => ({ BaseAgent: class MockBaseAgent {} }));
vi.mock('@memberjunction/global', () => ({ RegisterClass: () => (target: unknown) => target }));
vi.mock('@memberjunction/core', () => ({ LogStatus: vi.fn(), LogError: vi.fn(), RunView: class {}, UserInfo: class {} }));
vi.mock('@memberjunction/data-context', () => ({ DataContext: class {} }));
vi.mock('./skip-sdk.js', () => ({ SkipSDK: class {} }));

import { SkipProxyAgent, mapArtifactRequestToDirective } from '../../src/skip-agent.js';

type Directive = { behavior: string; targetArtifactId?: string; name?: string; description?: string } | undefined;
type Handlers = {
    handleAnalysisComplete(r: SkipAPIAnalysisCompleteResponse): { step: string; artifactDirective?: Directive };
    handleClarifyingQuestion(r: SkipAPIClarifyingQuestionResponse): { step: string; artifactDirective?: Directive; newPayload?: unknown };
};

const NEW: SkipAPIArtifactRequest = { action: 'new_artifact', name: 'Entity Catalog Explorer', description: 'Schema explorer' };
const VERSION: SkipAPIArtifactRequest = { action: 'new_artifact_version', artifactId: 'art-A', name: 'AI Operations Dashboard', description: 'v3' };

function agent(): Handlers {
    return new SkipProxyAgent() as unknown as Handlers;
}

function analysisComplete(extra: Partial<SkipAPIAnalysisCompleteResponse>): SkipAPIAnalysisCompleteResponse {
    return {
        success: true,
        responsePhase: SkipResponsePhase.analysis_complete,
        messages: [{ role: 'system', content: 'Built it', conversationDetailID: 'cd-1' }],
        componentOptions: [{ option: { name: 'EntityCatalogExplorer', title: 'Entity Catalog Explorer' }, AIRank: 1, AIRankExplanation: '' }],
        ...extra,
    } as unknown as SkipAPIAnalysisCompleteResponse;
}

function clarifying(extra: Partial<SkipAPIClarifyingQuestionResponse>): SkipAPIClarifyingQuestionResponse {
    return {
        success: true,
        responsePhase: SkipResponsePhase.clarifying_question,
        messages: [],
        clarifyingQuestion: 'Review the PRD',
        payload: { name: 'EntityCatalogExplorer', functionalRequirements: 'F'.repeat(60) },
        ...extra,
    } as unknown as SkipAPIClarifyingQuestionResponse;
}

describe('mapArtifactRequestToDirective', () => {
    it('maps new_artifact to create-new with name/description', () => {
        expect(mapArtifactRequestToDirective(NEW)).toEqual({ behavior: 'create-new', name: 'Entity Catalog Explorer', description: 'Schema explorer' });
    });

    it('maps new_artifact_version to version-source with the target id', () => {
        expect(mapArtifactRequestToDirective(VERSION)).toEqual({ behavior: 'version-source', targetArtifactId: 'art-A', name: 'AI Operations Dashboard', description: 'v3' });
    });

    it('returns undefined for no request', () => {
        expect(mapArtifactRequestToDirective(undefined)).toBeUndefined();
    });
});

describe('SkipProxyAgent artifact directive forwarding', () => {
    it('handleAnalysisComplete forwards the directive', () => {
        const step = agent().handleAnalysisComplete(analysisComplete({ artifactRequest: NEW }));
        expect(step.step).toBe('Success');
        expect(step.artifactDirective).toEqual({ behavior: 'create-new', name: 'Entity Catalog Explorer', description: 'Schema explorer' });
    });

    it('handleAnalysisComplete leaves artifactDirective undefined when Skip sent none (legacy behavior)', () => {
        const step = agent().handleAnalysisComplete(analysisComplete({}));
        expect('artifactDirective' in step).toBe(false);
    });

    it('handleClarifyingQuestion forwards the directive alongside the draft payload', () => {
        const step = agent().handleClarifyingQuestion(clarifying({ artifactRequest: NEW }));
        expect(step.step).toBe('Chat');
        expect(step.newPayload).toMatchObject({ name: 'EntityCatalogExplorer' });
        expect(step.artifactDirective).toEqual({ behavior: 'create-new', name: 'Entity Catalog Explorer', description: 'Schema explorer' });
    });

    it('handleClarifyingQuestion forwards a version-source directive with the target', () => {
        const step = agent().handleClarifyingQuestion(clarifying({ artifactRequest: VERSION }));
        expect(step.artifactDirective).toMatchObject({ behavior: 'version-source', targetArtifactId: 'art-A' });
    });

    it('handleClarifyingQuestion leaves artifactDirective absent when Skip sent none (legacy behavior)', () => {
        const step = agent().handleClarifyingQuestion(clarifying({}));
        expect('artifactDirective' in step).toBe(false);
    });
});
