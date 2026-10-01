/**
 * The MJ entity form the user is looking at, as the MJ shell publishes it into
 * `AppContext.AdditionalContext.Form` (`FormAgentContext` in `@memberjunction/ng-base-forms`),
 * plus the server's composition of that form when the client could load it.
 *
 * Field names match MJ's exactly; the value crosses the wire untranslated.
 */

/** Which form the user sees: the generated form, or one full custom form. */
export interface SkipFormChoice {
    /** True when a full custom form owns the whole body, so no section, grid or panel draws. */
    FullCustomForm: boolean;
    /** The `MJ: Entity Form Overrides` row the user sees, or null for the generated form. */
    OverrideID: string | null;
    /** The form's name in the form picker. */
    Label: string;
}

/** One panel the open form draws: a field section, a related grid, or a contribution. */
export interface SkipFormContextSection {
    Key: string;
    Title: string;
    /** 'default' | 'related-entity' | 'inherited' */
    Variant: string;
    Hidden: boolean;
    /** The contribution that draws this section or stands in for it, or null when none does. */
    ContributionKey: string | null;
}

export interface SkipFormCompositionField {
    Name: string;
    Label: string;
}

/** One field section as the server derives it from entity metadata. */
export interface SkipFormCompositionSection {
    Key: string;
    Title: string;
    Variant: string;
    Group: string | null;
    Hidden: boolean;
    Fields: SkipFormCompositionField[];
}

/** One related-record grid the generated form shows. */
export interface SkipFormCompositionRelated {
    Entity: string;
    JoinField: string;
    SectionKey: string;
    Inclusion: 'Primary' | 'More' | 'None' | 'Auto';
    Source: 'baked' | 'stock' | 'claimed';
}

/** One metadata contribution the caller sees on the form. */
export interface SkipFormCompositionContribution {
    Key: string;
    Slot: string;
    Source: 'metadata';
    Title: string;
    Presentation: 'panel' | 'bare';
    Hidden: boolean;
    Precedence: number;
    SortKey: number;
    InSectionKey?: string;
    SectionPosition?: 'start' | 'end';
    FieldNames: string[];
    SectionKeys: string[];
    ReplacesPlace?: string;
}

/** The `Result` of MJ's `Get Form Composition For Entity` action. */
export interface SkipFormComposition {
    Entity: string;
    Layout: 'accordion' | 'left-nav';
    FullCustomForm: boolean;
    MetadataContributionsEnabled: boolean;
    Sections: SkipFormCompositionSection[];
    Related: SkipFormCompositionRelated[];
    Contributions: SkipFormCompositionContribution[];
    SlotsPresent: string[];
    ChromeRuleCount: number;
    Note: string;
}

/** The open form, as `SkipAPIRequest.formContext` carries it. */
export interface SkipFormContext {
    Entity: string;
    /** The record as `CompositeKey.ToURLSegment()` (e.g. `ID|42`); null for a record not saved yet. */
    RecordPrimaryKey: string | null;
    FormChoice: SkipFormChoice;
    /** Every section the open form draws, hidden ones included. Authoritative for section keys. */
    Sections: SkipFormContextSection[];
    /** Fields per section, related grids, slots and metadata contributions; absent when the client could not load them. */
    Composition?: SkipFormComposition;
}
