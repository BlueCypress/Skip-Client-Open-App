---
"@askskip/types": minor
"@askskip/server": minor
"@askskip/core": minor
---

Forward the open MJ entity form to Skip as `SkipAPIRequest.formContext`.

When the user is on a record form, the MJ shell publishes a compact description of it (which
record, which form, which sections it draws) into the app context. `BuildFormContext` reads it
back out, loads the form's composition (fields per section, related grids, slots, installed
contributions) with the `Get Form Composition For Entity` action as the requesting user, and
`SkipSDK` sends both on every message. When the action is not installed or fails, the compact
part is sent alone.

The context is absent whenever the caller is not on a record form, which is the common case.
A `Form` value without `Entity`, `Sections` and `FormChoice` is rejected rather than forwarded.
