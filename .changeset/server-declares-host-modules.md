---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

Declare `express`, `type-graphql` and `graphql-type-json` in `@askskip/server`.

The package imported all three without declaring any of them. npm's flat `node_modules` hid
that — the host's copies were visible to us by accident — but pnpm gives a package only what it
declares, so `tsc` failed with TS2307 on all three and the package could not build as a member
of a pnpm workspace (how MJ 6.x and `mj dev workspace` install it).

They are declared as `peerDependencies`, alongside the `@memberjunction/*` entries, because they
must be the MJ host's own copies: the Router we mount belongs to the host's express app, our
resolver's decorators must write into the type-graphql metadata storage the host's schema is
built from, and `GraphQLJSONObject` must come from the host's graphql realm. `@types/express`
is added as a devDependency for the type-only import. No new package enters the dependency tree.
