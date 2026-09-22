import { describe, it, expect } from 'vitest';
import { ExtractFormContext } from '../../src/skip-agent.js';

/**
 * The MJ shell publishes the open form's composition into the app context snapshot as
 * `AdditionalContext.Form`. `ExtractFormContext` is the one place that reads it back out,
 * so it is also the one place that decides what counts as a usable snapshot.
 *
 * It is deliberately strict: a half-built snapshot reaching Skip is worse than none at all,
 * because an agent would treat a missing `Sections` array as "this form has no sections"
 * and design a panel around a form it has misread.
 */
const form = {
    Entity: 'MJ: Users',
    RecordPrimaryKey: 'ID|7',
    Layout: 'accordion',
    Sections: [],
    Related: [],
    Contributions: [],
    SlotsPresent: ['after-everything'],
    ChromeRuleCount: 0,
};

describe('ExtractFormContext', () => {
    it('reads AdditionalContext.Form from the app context snapshot', () => {
        expect(ExtractFormContext({ appContext: { App: { Name: 'Explorer' }, AdditionalContext: { Form: form } } })).toEqual(form);
    });

    it('returns null when there is no snapshot, no AdditionalContext, or no Form', () => {
        expect(ExtractFormContext(undefined)).toBeNull();
        expect(ExtractFormContext({})).toBeNull();
        expect(ExtractFormContext({ appContext: { App: { Name: 'x' } } })).toBeNull();
    });

    it('rejects a snapshot missing the arrays an agent would misread as empty', () => {
        expect(ExtractFormContext({ appContext: { AdditionalContext: { Form: { Entity: 'x' } } } })).toBeNull();
        const { Sections: _dropped, ...noSections } = form;
        expect(ExtractFormContext({ appContext: { AdditionalContext: { Form: noSections } } })).toBeNull();
    });

    it('rejects a non-object Form', () => {
        expect(ExtractFormContext({ appContext: { AdditionalContext: { Form: 'MJ: Users' } } })).toBeNull();
        expect(ExtractFormContext({ appContext: { AdditionalContext: { Form: null } } })).toBeNull();
    });
});
