import { describe, it, expect, vi, beforeEach } from 'vitest';

const { runAction, actions } = vi.hoisted(() => ({
    runAction: vi.fn(),
    actions: [] as Array<{ Name: string }>,
}));
vi.mock('@memberjunction/actions', () => ({
    ActionEngineServer: {
        Instance: {
            Config: vi.fn().mockResolvedValue(undefined),
            get Actions() { return actions; },
            RunAction: runAction,
        },
    },
}));

import { ExtractFormContext, LoadFormComposition, BuildFormContext } from '../../src/form-context.js';

const user = { ID: 'u1', Email: 'a@b.c' } as never;
const form = {
    Entity: 'MJ: Users',
    RecordPrimaryKey: 'ID|7',
    FormChoice: { FullCustomForm: false, OverrideID: null, Label: 'Default form' },
    Sections: [{ Key: 'details', Title: 'Details', Variant: 'default', Hidden: false, ContributionKey: null }],
};
const composition = {
    Entity: 'MJ: Users', Layout: 'accordion', FullCustomForm: false, MetadataContributionsEnabled: true,
    Sections: [{ Key: 'details', Title: 'Details', Variant: 'default', Group: null, Hidden: false, Fields: [{ Name: 'Name', Label: 'Name' }] }],
    Related: [], Contributions: [], SlotsPresent: ['after-fields'], ChromeRuleCount: 0, Note: '',
};
const data = (f: unknown) => ({ appContext: { App: { Name: 'Explorer' }, AdditionalContext: { Form: f } } });

beforeEach(() => { runAction.mockReset(); actions.length = 0; });

describe('ExtractFormContext', () => {
    it('reads the compact context and keeps only its four keys', () => {
        expect(ExtractFormContext(data({ ...form, Extra: 1 }))).toEqual(form);
    });
    it('returns null when there is no snapshot, no AdditionalContext, or no Form', () => {
        expect(ExtractFormContext(undefined)).toBeNull();
        expect(ExtractFormContext({})).toBeNull();
        expect(ExtractFormContext({ appContext: { App: { Name: 'x' } } })).toBeNull();
    });
    it('rejects a Form missing Entity, Sections or FormChoice', () => {
        expect(ExtractFormContext(data({ Entity: 'x' }))).toBeNull();
        const { Sections: _s, ...noSections } = form;
        expect(ExtractFormContext(data(noSections))).toBeNull();
        const { FormChoice: _c, ...noChoice } = form;
        expect(ExtractFormContext(data(noChoice))).toBeNull();
        expect(ExtractFormContext(data('MJ: Users'))).toBeNull();
    });
    it('reads a null RecordPrimaryKey for an unsaved record', () => {
        expect(ExtractFormContext(data({ ...form, RecordPrimaryKey: null }))?.RecordPrimaryKey).toBeNull();
    });
});

describe('LoadFormComposition', () => {
    it('returns null when the action is not installed', async () => {
        expect(await LoadFormComposition('MJ: Users', user)).toBeNull();
        expect(runAction).not.toHaveBeenCalled();
    });
    it('runs the action as the user and returns its Result param', async () => {
        actions.push({ Name: 'Get Form Composition For Entity' });
        runAction.mockResolvedValue({ Success: true, Params: [{ Name: 'Result', Value: composition, Type: 'Output' }] });
        expect(await LoadFormComposition('MJ: Users', user)).toEqual(composition);
        const params = runAction.mock.calls[0][0];
        expect(params.ContextUser).toBe(user);
        expect(params.Params).toEqual([{ Name: 'EntityName', Value: 'MJ: Users', Type: 'Input' }]);
    });
    it('returns null when the action fails or throws', async () => {
        actions.push({ Name: 'Get Form Composition For Entity' });
        runAction.mockResolvedValue({ Success: false, Message: 'QUERY_FAILED' });
        expect(await LoadFormComposition('MJ: Users', user)).toBeNull();
        runAction.mockRejectedValue(new Error('boom'));
        expect(await LoadFormComposition('MJ: Users', user)).toBeNull();
    });
});

describe('BuildFormContext', () => {
    it('attaches the composition when it loads', async () => {
        actions.push({ Name: 'Get Form Composition For Entity' });
        runAction.mockResolvedValue({ Success: true, Params: [{ Name: 'Result', Value: composition, Type: 'Output' }] });
        expect(await BuildFormContext(data(form), user)).toEqual({ ...form, Composition: composition });
    });
    it('sends the compact context alone when the composition cannot load', async () => {
        expect(await BuildFormContext(data(form), user)).toEqual(form);
    });
    it('does not load a composition for a full custom form', async () => {
        actions.push({ Name: 'Get Form Composition For Entity' });
        const custom = { ...form, FormChoice: { FullCustomForm: true, OverrideID: 'o1', Label: 'Custom' } };
        expect(await BuildFormContext(data(custom), user)).toEqual(custom);
        expect(runAction).not.toHaveBeenCalled();
    });
    it('returns null without a form', async () => {
        expect(await BuildFormContext(undefined, user)).toBeNull();
    });
});
