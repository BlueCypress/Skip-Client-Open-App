import { LogError, UserInfo } from '@memberjunction/core';
import { ActionEngineServer } from '@memberjunction/actions';
import type { SkipFormChoice, SkipFormComposition, SkipFormContext, SkipFormContextSection } from '@askskip/types';

/** The MJ action that derives a form's composition from metadata, run as the requesting user. */
const COMPOSITION_ACTION_NAME = 'Get Form Composition For Entity';

/**
 * The open form, read out of the MJ app context snapshot at `appContext.AdditionalContext.Form`.
 * Absent far more often than present: the user has to be on a record form. A `Form` without
 * `Entity`, `Sections` and `FormChoice` is not usable and returns null as well.
 */
export function ExtractFormContext(data: Record<string, unknown> | undefined): SkipFormContext | null {
    const appContext = data?.appContext;
    if (!appContext || typeof appContext !== 'object') return null;
    const additional = (appContext as Record<string, unknown>).AdditionalContext;
    if (!additional || typeof additional !== 'object') return null;
    const form = (additional as Record<string, unknown>).Form;
    if (!form || typeof form !== 'object') return null;

    const candidate = form as Record<string, unknown>;
    if (typeof candidate.Entity !== 'string' || candidate.Entity.length === 0) return null;
    if (!Array.isArray(candidate.Sections)) return null;
    const choice = candidate.FormChoice;
    if (!choice || typeof choice !== 'object') return null;
    if (typeof (choice as Record<string, unknown>).FullCustomForm !== 'boolean') return null;

    return {
        Entity: candidate.Entity,
        RecordPrimaryKey: typeof candidate.RecordPrimaryKey === 'string' ? candidate.RecordPrimaryKey : null,
        FormChoice: choice as SkipFormChoice,
        Sections: candidate.Sections as SkipFormContextSection[],
    };
}

/**
 * The server's composition of an entity's form, or null when the action is not installed on
 * this MJ version, refuses, or fails. The caller still has the compact context in that case.
 */
export async function LoadFormComposition(entityName: string, contextUser: UserInfo): Promise<SkipFormComposition | null> {
    try {
        const engine = ActionEngineServer.Instance;
        await engine.Config(false, contextUser);
        const action = engine.Actions.find((a) => a.Name === COMPOSITION_ACTION_NAME);
        if (!action) return null;

        const result = await engine.RunAction({
            Action: action,
            ContextUser: contextUser,
            Params: [{ Name: 'EntityName', Value: entityName, Type: 'Input' }],
            Filters: [],
            SkipActionLog: true,
        });
        if (!result.Success) {
            LogError(`[SkipProxyAgent] ${COMPOSITION_ACTION_NAME} failed for ${entityName}: ${result.Message ?? 'no message'}`);
            return null;
        }
        const value = result.Params?.find((p) => p.Name === 'Result')?.Value;
        return value && typeof value === 'object' ? (value as SkipFormComposition) : null;
    } catch (e) {
        LogError(`[SkipProxyAgent] ${COMPOSITION_ACTION_NAME} threw for ${entityName}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
}

/**
 * The form context Skip receives: the compact context from the app snapshot, with the
 * server's composition attached when the form is not a full custom form and the load works.
 */
export async function BuildFormContext(data: Record<string, unknown> | undefined, contextUser: UserInfo): Promise<SkipFormContext | null> {
    const compact = ExtractFormContext(data);
    if (!compact) return null;
    if (compact.FormChoice.FullCustomForm) return compact;
    const composition = await LoadFormComposition(compact.Entity, contextUser);
    return composition ? { ...compact, Composition: composition } : compact;
}
