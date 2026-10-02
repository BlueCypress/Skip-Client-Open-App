import { LogError, UserInfo } from '@memberjunction/core';
import { ActionEngineServer } from '@memberjunction/actions';
import type { SkipFormChoice, SkipFormComposition, SkipFormContext, SkipFormContextSection } from '@askskip/types';

/** The MJ action that derives a form's composition from metadata, run as the requesting user. */
const COMPOSITION_ACTION_NAME = 'Get Form Composition For Entity';

type Entry = Record<string, unknown>;

/** True for a plain object; false for null, arrays and primitives. */
function isRecord(value: unknown): value is Entry {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** True for a form section entry with a string `Key`. */
function isSection(value: unknown): boolean {
    return isRecord(value) && typeof value.Key === 'string';
}

/** True when the action's `Result` is an object whose lists Skip reads are lists. */
function isComposition(value: unknown): value is SkipFormComposition {
    return isRecord(value)
        && Array.isArray(value.Sections)
        && Array.isArray(value.Related)
        && Array.isArray(value.Contributions)
        && Array.isArray(value.SlotsPresent);
}

/**
 * The open form, read out of the MJ app context snapshot at `appContext.AdditionalContext.Form`.
 * Absent far more often than present: the user has to be on a record form. The `Form` must have
 * an `Entity` that is not blank, a `Sections` list whose entries each have a string `Key`, and a
 * `FormChoice` whose `FullCustomForm` is a boolean; otherwise it returns null.
 */
export function ExtractFormContext(data: Record<string, unknown> | undefined): SkipFormContext | null {
    const appContext = data?.appContext;
    if (!isRecord(appContext)) return null;
    const additional = appContext.AdditionalContext;
    if (!isRecord(additional)) return null;
    const form = additional.Form;
    if (!isRecord(form)) return null;

    if (typeof form.Entity !== 'string' || form.Entity.trim() === '') return null;
    if (!Array.isArray(form.Sections) || !form.Sections.every(isSection)) return null;
    const choice = form.FormChoice;
    if (!isRecord(choice) || typeof choice.FullCustomForm !== 'boolean') return null;

    return {
        Entity: form.Entity,
        RecordPrimaryKey: typeof form.RecordPrimaryKey === 'string' ? form.RecordPrimaryKey : null,
        FormChoice: form.FormChoice as SkipFormChoice,
        Sections: form.Sections as SkipFormContextSection[],
    };
}

/**
 * The server's composition of an entity's form, or null when the action is not installed or not
 * active on this MJ version, refuses, fails, or returns a `Result` without the composition lists.
 * The caller still has the compact context in that case.
 */
export async function LoadFormComposition(entityName: string, contextUser: UserInfo): Promise<SkipFormComposition | null> {
    try {
        const engine = ActionEngineServer.Instance;
        await engine.Config(false, contextUser);
        const action = engine.GetActionByName(COMPOSITION_ACTION_NAME);
        if (!action || action.Status !== 'Active') return null;

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
        if (isComposition(value)) return value;
        LogError(`[SkipProxyAgent] ${COMPOSITION_ACTION_NAME} returned a Result without the composition lists for ${entityName}`);
        return null;
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
