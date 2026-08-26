/**
 * Width limits for query profiling.
 *
 * The constant lives behind {@link getPrivacyPolicy} so that relocating it into
 * the Open App's `mj-app.json` `configuration` schema later is a one-function
 * change rather than a scatter of edits. There is deliberately no per-request or
 * per-caller override: this gate exists so the client's own server decides what
 * leaves it, and a caller-supplied policy would defeat the point.
 *
 * ## Why there are no privacy constants here any more
 *
 * This file previously carried a k-anonymity floor, a cardinality ceiling, a
 * value-length bound and a name/type sensitivity deny-list. All of them existed
 * to govern one feature: the domain-value pass, which emitted literal column
 * values for low-cardinality columns so the Query Writer could see that a status
 * is spelled `'COMPLETED'` rather than `'Completed'`.
 *
 * That pass has been removed, because MJ already answers the same question by a
 * better route. `__mj.EntityFieldValue` is populated from CHECK constraints
 * (parsed by CodeGen, authoritative) and from DBAutoDoc's LLM enum detection,
 * and `SkipSDK.packFieldValues` ships those values — plus, for
 * `ValuesToPackWithSchema='All'` and `ValueListType='ListOrUserEntry'`, a live
 * `SELECT DISTINCT` — into every Skip request payload. The Query Writer prompt
 * already instructs the model to read them.
 *
 * Metadata is also the *better* answer, not merely the cheaper one. It describes
 * the column's full domain, whereas the profile could only report values that
 * survived the candidate query's own filters — which is circular when the filter
 * is the thing being debugged.
 *
 * The consequence is that the profile now has no path by which a row value can
 * leave the database at all: every statistic it emits is a count, a ratio, or a
 * numeric bound. The privacy rules did not become unenforced — they became
 * inapplicable.
 */

/** Tunable limits governing a profile's width. */
export interface PrivacyPolicy {
    /**
     * Width cap (D2). A safety valve against pathologically wide results, not a
     * cost control — statistic count was measured to have almost no effect on
     * runtime, so this is not buying performance.
     */
    MaxProfiledColumns: number;
}

const POLICY: PrivacyPolicy = {
    MaxProfiledColumns: 15,
};

export function getPrivacyPolicy(): PrivacyPolicy {
    return POLICY;
}
