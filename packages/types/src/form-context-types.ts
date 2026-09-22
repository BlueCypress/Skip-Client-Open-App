/**
 * The MJ form composition snapshot — what is on the entity form the user is looking at.
 *
 * Structural mirror of `FormCompositionSnapshot` in `@memberjunction/ng-base-forms`, kept
 * independent so this package stays free of Angular dependencies. **Field names must match**:
 * the value crosses the wire as plain JSON from the MJ shell, with no translation layer to
 * catch a rename on either side.
 */

/** Where on the entity form a panel mounts. */
export type SkipFormContextSlot = 'top-area' | 'before-fields' | 'after-fields' | 'after-related' | 'after-everything';

/** One input inside a field section. */
export interface SkipFormContextField {
    Name: string;
    Label: string;
}

/** One field section on the form. */
export interface SkipFormContextSection {
    Key: string;
    Title: string;
    Variant: string;
    /** Rail group key, or null when the section is not in any first-class group. */
    Group: string | null;
    Hidden: boolean;
    /**
     * The inputs this section draws. Present so a panel author can see what the form
     * already shows; a section with no fields of its own, such as a related grid, has none.
     * Optional so an older client's snapshot still parses.
     */
    Fields?: SkipFormContextField[];
}

/** One related-record grid on the form. */
export interface SkipFormContextRelated {
    Entity: string;
    JoinField: string;
    SectionKey: string;
    Inclusion: 'Primary' | 'More' | 'None' | 'Auto';
    /** baked = in the template; stock = container fill-in; claimed = a contribution replaced it. */
    Source: 'baked' | 'stock' | 'claimed';
}

/** One contribution already installed on the form. */
export interface SkipFormContextContribution {
    Key: string;
    Slot: SkipFormContextSlot;
    Source: 'class' | 'metadata';
    Title: string;
    Presentation: 'panel' | 'bare';
    Hidden: boolean;
    Precedence: number;
}

/** The composition of one entity form, as the shell resolved it. */
export interface SkipFormContext {
    Entity: string;
    /**
     * Which record the composition describes, as `PrimaryKey.ToString()`.
     *
     * The app context is global and replaced wholesale by whichever surface published last,
     * so a consumer cannot assume the snapshot belongs to the record under discussion.
     */
    RecordPrimaryKey: string;
    Layout: 'accordion' | 'left-nav';
    Sections: SkipFormContextSection[];
    Related: SkipFormContextRelated[];
    Contributions: SkipFormContextContribution[];
    SlotsPresent: SkipFormContextSlot[];
    ChromeRuleCount: number;
}
