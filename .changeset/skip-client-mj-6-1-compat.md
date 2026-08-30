---
"@askskip/types": minor
"@askskip/core": minor
"@askskip/server": minor
---

Support MemberJunction 6.1 **in addition to** 5.51 — this is an additive compatibility widening, not a migration.

PR #21 widened `mj-app.json` `mjVersionRange` to `>=5.51.0 <7.0.0` so the manifest would accept a 6.x host, but no release was cut afterwards — the `v0.1.0` tag still carries `>=5.51.0 <6.0.0`, and `mj app install` resolves an app's manifest at its release tag, not at `next`. It was also only half the fix: all 25 `@memberjunction/*` specifiers still demanded 5.x, so on a 6.1 host `npm ci` failed with ERESOLVE regardless of what the manifest claimed.

Every consumer-facing `@memberjunction/*` range becomes `^5.51.0 || ^6.1.0-edge.4`. A single span such as `>=5.51.0 <7.0.0` cannot work here: node-semver only matches a prerelease when the range carries a comparator with that same `major.minor.patch`, so `6.1.0-edge.4` fails every plain span. The union is the narrowest expression that admits 5.51.x, 6.1.0-edge.4, and stable 6.x alike. `devDependencies` stay pinned at `^6.1.0-edge.4` — build toolchain only, invisible to consumers.

`mjVersionRange` stays at `>=5.51.0 <7.0.0` (as #21 set it). The Open App engine coerces a prerelease host version to its base before testing the range, so `6.1.0-edge.4` is evaluated as `6.1.0` and satisfies it.

Verified by building the whole workspace twice from one source tree: once resolved against `@memberjunction/core@6.1.0-edge.4` and once forced down to `5.51.0`. Both green, no source changes — which is what makes the dual range honest rather than aspirational.

Keeping 5.51 support is deliberate: `BlueCypress/more-cheese` runs MJ 5.51.0 on stage and prod and depends on `@askskip/server`. Dropping the 5.x floor would have stranded a production environment on 0.1.x.
