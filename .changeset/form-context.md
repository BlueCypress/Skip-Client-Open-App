---
"@askskip/types": minor
"@askskip/server": minor
"@askskip/core": minor
---

Forward the open MJ entity form's composition to Skip as `SkipAPIRequest.formContext`.

When the user is on a record form, the MJ shell publishes that form's composition — its
sections, related grids, the contributions already installed, and the slots it emits — into
the app context. `ExtractFormContext` reads it back out and `SkipSDK` sends it on every
message, so an agent asked to add a panel can see what the form already shows instead of
guessing at section keys and slots.

The snapshot is absent whenever the caller is not on a record form, which is the common case,
and a partial snapshot is rejected rather than forwarded: an agent reading an absent
`Sections` array would conclude the form has no sections and design against a form it has
misread.
