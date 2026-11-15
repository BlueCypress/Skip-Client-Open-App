/**
 * Which conversation rows Skip receives as history.
 *
 * MJ 6.2 added conversation branches (`ConversationDetail.BranchID`) and reruns that replace an
 * answer (`ConversationDetail.ReplacedAt`). A replaced row is kept for audit but "never shown
 * and never sent to an agent", and an agent only sees the rows on the branch it is answering.
 * MJ's own agent-history loader applies both rules. The Open App supports MJ 6.1.5 through 6.x,
 * and 6.1 has neither column, so each rule is applied only when the host's schema has it.
 */

import { LogStatus, Metadata, UserInfo } from "@memberjunction/core";
import { ConversationEngine } from "@memberjunction/core-entities";

/** MJ 6.2's branch-path filter; not in the 6.1 typings the Open App builds against. */
type BranchPathFilterFresh = (
    conversationId: string,
    branchId: string | null | undefined,
    contextUser: UserInfo
) => Promise<string>;

/** What the host MJ version supports. */
export interface ConversationHistoryCapabilities {
    hasReplacedAt: boolean;
    hasBranchID: boolean;
    /** MJ's filter for the rows on a branch's path (MJ 6.2+). */
    branchPathFilter?: BranchPathFilterFresh;
}

/** Reads the capabilities from the host's entity metadata and ConversationEngine. */
export function resolveConversationHistoryCapabilities(): ConversationHistoryCapabilities {
    const fields = new Metadata().EntityByName('MJ: Conversation Details')?.Fields ?? [];
    const hasField = (name: string) => fields.some(f => f.Name === name);
    return {
        hasReplacedAt: hasField('ReplacedAt'),
        hasBranchID: hasField('BranchID'),
        branchPathFilter: hasBranchPathFilter(ConversationEngine)
            ? ConversationEngine.BranchPathFilterFresh.bind(ConversationEngine)
            : undefined,
    };
}

function hasBranchPathFilter(engine: object): engine is { BranchPathFilterFresh: BranchPathFilterFresh } {
    return 'BranchPathFilterFresh' in engine && typeof engine.BranchPathFilterFresh === 'function';
}

/**
 * The RunView filter for the history rows of a conversation: the rows on `branchId`'s path
 * (the trunk when empty) that no rerun replaced.
 *
 * @param conversationId - A validated conversation UUID
 * @param branchId - The branch being answered (`ExecuteAgentParams.ConversationBranchID` on MJ 6.2+)
 */
export async function buildConversationHistoryFilter(
    conversationId: string,
    branchId: string | null | undefined,
    contextUser: UserInfo,
    capabilities: ConversationHistoryCapabilities
): Promise<string> {
    let filter = `ConversationID='${conversationId}'`;
    if (capabilities.hasBranchID) {
        filter = await branchFilter(filter, conversationId, branchId, contextUser, capabilities);
    }
    if (capabilities.hasReplacedAt) {
        filter = `${filter} AND ReplacedAt IS NULL`;
    }
    return filter;
}

async function branchFilter(
    conversationFilter: string,
    conversationId: string,
    branchId: string | null | undefined,
    contextUser: UserInfo,
    capabilities: ConversationHistoryCapabilities
): Promise<string> {
    if (capabilities.branchPathFilter) {
        return capabilities.branchPathFilter(conversationId, branchId, contextUser);
    }
    if (!branchId?.trim()) {
        return `${conversationFilter} AND BranchID IS NULL`;
    }
    LogStatus(`[SkipProxyAgent] Branch ${branchId} requested, but this MJ version has no branch-path filter; sending every branch's rows`);
    return conversationFilter;
}
