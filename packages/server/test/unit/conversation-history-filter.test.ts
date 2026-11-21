/**
 * @fileoverview Skip must receive the same history MJ's own agents do: on MJ 6.2+ that excludes
 * rows a rerun replaced and rows on other branches; on 6.1 there is nothing to exclude.
 */
import { describe, it, expect, vi } from 'vitest';
import type { UserInfo } from '@memberjunction/core';

vi.mock('@memberjunction/core', () => ({ LogStatus: vi.fn(), Metadata: class {} }));
vi.mock('@memberjunction/core-entities', () => ({ ConversationEngine: class {} }));

import { buildConversationHistoryFilter } from '../../src/conversation-history-filter.js';

const CONVERSATION = '5B0C1D2E-3F40-4A51-8B62-7C83D94EA5F6';
const user = {} as UserInfo;
const mj61 = { hasReplacedAt: false, hasBranchID: false };

describe('buildConversationHistoryFilter', () => {
    it('is the conversation filter alone on MJ 6.1', async () => {
        expect(await buildConversationHistoryFilter(CONVERSATION, undefined, user, mj61))
            .toBe(`ConversationID='${CONVERSATION}'`);
    });

    it("uses MJ's branch-path filter and drops replaced rows on MJ 6.2+", async () => {
        const branchPathFilter = vi.fn().mockResolvedValue(`[ConversationID]='${CONVERSATION}' AND [BranchID] = 'B1'`);

        const filter = await buildConversationHistoryFilter(CONVERSATION, 'B1', user, {
            hasReplacedAt: true, hasBranchID: true, branchPathFilter,
        });

        expect(branchPathFilter).toHaveBeenCalledWith(CONVERSATION, 'B1', user);
        expect(filter).toBe(`[ConversationID]='${CONVERSATION}' AND [BranchID] = 'B1' AND ReplacedAt IS NULL`);
    });

    it('limits a trunk run to trunk rows when the branch-path filter is unavailable', async () => {
        const filter = await buildConversationHistoryFilter(CONVERSATION, undefined, user, {
            hasReplacedAt: true, hasBranchID: true,
        });

        expect(filter).toBe(`ConversationID='${CONVERSATION}' AND BranchID IS NULL AND ReplacedAt IS NULL`);
    });
});
