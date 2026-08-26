---
"@askskip/types": minor
"@askskip/core": minor
"@askskip/server": minor
---

**Minimum MemberJunction version is now 5.51.0** (`mjVersionRange` and every
`@memberjunction/*` peer range). 5.45–5.47 lacked `RenderedSQL` on
`TestQuerySQLResult` and `RunQueryResult`, which the new profiling contract
returns; supporting versions that cannot supply it meant either dropping the
field or reading it structurally, and neither is worth carrying now that every
client runs 5.51.0.


Add `TestAndProfileQuerySQL`, a Skip-owned GraphQL resolver that returns MJ's
`TestQuerySQL` result plus, on request, aggregate statistics computed over the
**full uncapped** result set inside the client's own database.

`TestQuerySQL` caps its result with a real SQL `TOP N`, so `RowCount` is a cap
rather than a count and the true cardinality of a result is unknowable from the
response. A caller shown three unordered rows of a needle-in-haystack aggregate
sees zeros everywhere and concludes its join is broken. Profiling answers that
with per-column distinct/null counts, numeric min/max/non-zero counts, and a real
`totalRows` — none of which requires a row to leave the database.

Disclosure is strictly narrower than the call it supersedes. The aggregate SQL is
generated deterministically from the executed result's own columns, so the caller
never selects what is profiled and cannot influence the projection. Literal values
appear only as `domainValues`, behind a cardinality ceiling, a k-anonymity floor
enforced in the `HAVING` clause, and a default-deny sensitivity check — all
evaluated on the client's server.

- New shared contract in `@askskip/types` (`profile-types.ts`). The resolver's
  TypeGraphQL classes `implement` those interfaces, so the wire types cannot drift
  from the shared definition without failing the build.
- `SkipMiddleware.GetResolverPaths()` now registers `resolvers/*Resolver.{js,ts}`.
- Adds `@memberjunction/generic-database-provider`, `sql-parser`, `sql-dialect`
  and `core-entities-server` to `peerDependencies`.

**New `query:profile` API scope**, seeded by
`V202608172304__skip_client_query_profile_scope.sql` and removed on teardown.
The migration seeds **two** records: the `__mj.APIScope` catalog entry and an
`__mj.APIApplicationScope` ceiling grant for the MJAPI application. Authorization
is evaluated at both levels — a key holding the scope is still denied
("Application does not allow this scope/resource combination") without the ceiling
row, and MJ core only ships ceiling rows for scopes MJ itself ships.
MJ core's scope catalog describes MJ's own resolvers, so it has no reason to ship
a scope for one that exists only where this app is installed — the app seeds it,
the callback-key provisioner reconciles it onto the Skip key, and the teardown
hook removes it.

Granting it separately from `query:test` is what makes profiling independently
revocable: profiling runs the candidate query uncapped, which is a different cost
profile than a capped test, and an operator may reasonably permit one and not the
other. Revoking it degrades rather than breaks — the call still authorizes and
returns its test result, with `ProfileUnavailableReason: 'not-authorized'` in
place of statistics.

Additive and inert: nothing calls the resolver until Skip does, and Skip degrades
to `TestQuerySQL` against deployments that predate it.
