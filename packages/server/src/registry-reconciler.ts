/**
 * @fileoverview Keeps the client's Component Registry records in step with the brain,
 * without depending on the brain being reachable when MJAPI boots.
 *
 * The registry name is a property of the brain, so the client has to ask for it. Asking
 * once at startup is not enough in practice: a developer routinely starts MJAPI and the
 * Skip API hours apart, and a production brain can be down for a maintenance window. A
 * retry with any fixed cap fails both — the cap either expires before the brain returns
 * or costs a poll against a dead host for the life of the process.
 *
 * So reconciliation is driven by *use* instead of by a clock. Every successful call to the
 * brain is proof it is up right now, which is the only moment reconciliation can succeed
 * and the only moment it matters. A client that never uses Skip never makes a call.
 *
 * The ordering works out on its own: a chat request does not need the registry record, and
 * a component must be generated before it can be rendered — so by the time anything
 * resolves a spec, the record created here exists.
 *
 * Rendering never depends on this. The registry API key resolves from the encrypted
 * credential store at fetch time, so a client that booted while the brain was down still
 * serves existing components correctly; reconciliation only has to catch up on records.
 */
import { LogError, LogStatus, Metadata } from '@memberjunction/core';
import type { UserInfo } from '@memberjunction/core';
import { UserCache } from '@memberjunction/sqlserver-dataprovider';
import { ensureSkipRecords, fetchSkipRegistryName, getSkipConfig, resolveSkipApiKey } from '@askskip/core';

/**
 * Minimum gap between name checks once reconciliation has succeeded.
 *
 * A successful check is cheap but not free, and the name changes approximately never —
 * this exists to catch the case where an operator renames the brain's registry while this
 * client keeps running, which would otherwise persist until the next restart.
 */
const RECHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Registry name this process has already reconciled records for, if any. */
let reconciledName: string | null = null;
/** Epoch ms of the last completed check, successful or not. */
let lastCheckedAtMs = 0;
/** Guards against concurrent reconciles when requests arrive in parallel. */
let inFlight = false;

/**
 * Records that startup already reconciled successfully, so the first brain contact does
 * not repeat the work.
 */
export function markRegistryReconciled(registryName: string): void {
    reconciledName = registryName;
    lastCheckedAtMs = Date.now();
}

/** Test seam — clears memoized state. */
export function resetRegistryReconcilerState(): void {
    reconciledName = null;
    lastCheckedAtMs = 0;
    inFlight = false;
}

/** True when enough has changed (or never happened) to justify asking the brain again. */
function shouldCheck(): boolean {
    if (inFlight) {
        return false;
    }
    if (reconciledName === null) {
        return true;
    }
    return Date.now() - lastCheckedAtMs >= RECHECK_INTERVAL_MS;
}

/**
 * Signals that the brain was just reached successfully.
 *
 * Fire-and-forget by design: this runs on the request path and must never delay or fail a
 * user's chat request. Every failure mode inside resolves to "try again on the next
 * successful call".
 */
export function noteBrainContact(contextUser?: UserInfo): void {
    if (!shouldCheck()) {
        return;
    }
    inFlight = true;
    void reconcile(contextUser)
        .catch((e: unknown) => {
            LogError(`[skip-client] Registry reconciliation failed: ${e instanceof Error ? e.message : String(e)}`);
        })
        .finally(() => {
            lastCheckedAtMs = Date.now();
            inFlight = false;
        });
}

async function reconcile(contextUser?: UserInfo): Promise<void> {
    const systemUser = UserCache.Instance.GetSystemUser();
    if (!systemUser) {
        return;
    }

    const config = getSkipConfig();
    const apiKey = config.apiKey ?? (await resolveSkipApiKey(contextUser ?? systemUser));
    const reported = await fetchSkipRegistryName({ skipURL: config.skipURL, apiKey });
    if (!reported) {
        // Still unknown. Leave reconciledName as-is so the next successful call retries;
        // guessing here is what points a production registry at someone's laptop.
        return;
    }

    if (reported === reconciledName) {
        return;
    }

    if (reconciledName === null) {
        LogStatus(`[skip-client] Brain reachable — reconciling Component Registry records for "${reported}".`);
    } else {
        LogStatus(
            `[skip-client] Brain now publishes under "${reported}" (was "${reconciledName}") — ` +
            `reconciling Component Registry records.`,
        );
    }

    await ensureSkipRecords(Metadata.Provider, systemUser, (m) => LogStatus(m), reported);
    reconciledName = reported;
}
