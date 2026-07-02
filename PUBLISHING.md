# Publishing the Skip Client packages

> **Public packages, public repo.** All packages are published **publicly** to the **`@askskip`**
> npm org, and this GitHub repo is public. Each `package.json` pins `publishConfig.access = "public"`
> so a plain `npm publish` publishes the scoped package publicly (no `--access` flag needed). Anyone
> can install them — including `mj app install` — with **no npm authentication**.

This repo is an **npm workspaces monorepo**. The package list is derived from the root `workspaces`
field — `npm run list:packages` prints it in dependency order — so the packaging scripts and CI pick
up new packages automatically. Today it publishes:

| Package | Path | What it is | npm deps |
| --- | --- | --- | --- |
| **`@askskip/types`** | [`packages/types`](packages/types) | Skip request/response types shared with the Skip API (extracted from the former `@memberjunction/skip-types`). | a few `@memberjunction/*` type packages (light) |
| **`@askskip/core`** | [`packages/core`](packages/core) | Shared foundation: config + API-key resolver, Skip record helpers, and the install (`setup`) / uninstall (`teardown`) hooks. | `core`, `credentials` (light) |
| **`@askskip/server`** | [`packages/server`](packages/server) | Server runtime: SkipProxyAgent, SkipSDK, callback-key provisioner, middleware, `registerSkip`. | the heavy AI/server set **+ `@askskip/core` + `@askskip/types`** |

**Every workspace package and `mj-app.json` share one version** and are always released together — so
the npm packages, the Open App manifest, and the release tag never drift. Any internal `@askskip/*`
dependency is pinned at an **exact, lockstep version** (e.g. `0.0.2`, not a range) — `@askskip/server`,
for instance, pins both `@askskip/core` and `@askskip/types` exactly. A CI check
(`npm run check:lockstep`) fails the build if any package or the manifest diverges, or an internal
dep isn't an exact pin. Internal dependencies only ever point one way (`server → core`, `server →
types`, never the reverse), which keeps the install hooks free of the runtime's heavy dependencies and
avoids circular dependencies.

Most releases are **automated** — see [Releases (manual)](#releases-manual). The
[one-time bootstrap](#one-time-bootstrap-per-package) must be done once per package before
automation works.

---

## How automated publishing works

| Workflow | File | Trigger | What it does |
| --- | --- | --- | --- |
| **CI** | `.github/workflows/ci.yml` | PRs touching `packages/**` | `npm ci` + **`npm run check:lockstep`** + `npm run build` (whole workspace, in dependency order). No registry auth needed — internal `@askskip/*` deps resolve to the local workspace, never the registry. |
| **Release & publish** | `.github/workflows/publish.yml` | **Manual only** — Actions tab → Run workflow | Versions the app in lockstep (**`bump=auto`** → minor if `migrations/`/`metadata/`/`mj-app.json` changed since the last release tag, else patch; or pick patch/minor/major), bumps every package + internal pins + the manifest, commits the bump `[skip ci]`, tags `vX.Y.Z`, builds, and publishes every package (in dependency order) publicly via **trusted publishing (OIDC)** with provenance. |

The publish step **loops over every workspace package in dependency order** (from
`node scripts/list-packages.mjs`), so a lockstep release publishes each dependency before its
dependents. Each package publishes only when its own `package.json` version isn't yet on the registry
— so the workflow is **idempotent**, you release simply by bumping the version on `main`, and adding a
new package needs no workflow change.

**Authentication** uses npm **trusted publishing** (OIDC), so there is no `NPM_TOKEN` secret. The npm
CLI detects the GitHub Actions OIDC environment and authenticates as the trusted publisher configured
for each package on npmjs.com.

**Provenance.** Because the repo is **public**, trusted publishing attaches a **provenance
attestation** automatically (the publish step also passes `--provenance` explicitly). Published
versions show a verified "Built and signed on GitHub Actions" badge on npm.

---

## Local build

```bash
npm install        # at repo root — installs deps and symlinks internal @askskip/* packages together
npm run build      # builds every package in dependency order (declared `workspaces` order)
```

`npm run build` runs `npm run build --workspaces --if-present`, so it builds each package (in the order
they appear in the root `workspaces` field — keep that in **dependency order**) and picks up new
packages automatically. Per-package watch during development: `npm run watch:types` /
`npm run watch:core` / `npm run watch:server`.

---

## One-time bootstrap (per package)

Trusted publishing can only be configured for a package that **already exists** on npm, so the
**first publish of each package is a manual, token-based bootstrap**. Publish in dependency order
(a dependency before its dependents) — run `npm run list:packages` to see that order. A brand-new
package (e.g. `@askskip/types` was added after the initial release) needs this same one-time
bootstrap the first time it publishes.

### Prerequisites

- An account in the **`@askskip`** org with **publish** rights. (Public packages are free — no paid
  npm plan required.)
- Node **≥ 22.14.0** and npm **≥ 11.5.1** locally (`npm install -g npm@latest` if needed).

### 1. First publish (manual, token-based)

```bash
npm login
npm install
npm run build

# Publish dependencies FIRST — go in `npm run list:packages` order. publishConfig.access=public
# publishes each scoped package publicly, so no --access flag is needed:
cd packages/types  && npm publish && cd ../..
cd packages/core   && npm publish && cd ../..
cd packages/server && npm publish && cd ../..
```

Verify:

```bash
npm view @askskip/types version
npm view @askskip/core version
npm view @askskip/server version
```

### 2. Configure the trusted publisher on npmjs.com (for EACH package)

For **each** workspace package (`@askskip/types`, `@askskip/core`, `@askskip/server`, and any added later):

1. npmjs.com → the package → **Settings → Trusted Publishing**.
2. Add a **GitHub Actions** trusted publisher:
   - **Organization / user:** `BlueCypress`
   - **Repository:** `Skip-Client-Open-App`
   - **Workflow filename:** `publish.yml`
   - **Environment:** _(leave blank)_
3. **Allowed actions:** ensure **`npm publish`** is selected. (Trusted-publisher configs created
   after 2026-05-20 require you to pick at least one allowed action explicitly.)
4. Save.

After each package is configured, every version bump released from `main` publishes automatically.

---

## Releases (manual)

> **Releases are manual for now — nothing publishes on merge.** A maintainer triggers a release from
> the **Actions** tab → **Release & publish** → **Run workflow**.

Pick the **`bump`** input:

| `bump` | Result |
|---|---|
| **`auto`** (default) | **minor** if `migrations/`, `metadata/`, or `mj-app.json` changed since the last release tag, else **patch** |
| `patch` / `minor` / `major` | force that level (use `major` for breaking releases) |

The workflow then:

1. Resolves the bump level (auto from the last-tag diff, or the level you picked).
2. Runs `npm run version:lockstep <next>` — bumps every workspace package (+ exact internal pins) and
   `mj-app.json` — and re-checks lockstep.
3. Commits `chore(release): vX.Y.Z … [skip ci]`, tags `vX.Y.Z`, and pushes both to `main`.
4. Publishes every package in dependency order publicly (with provenance). A package is a no-op if
   that version is already on npm.

> **Don't bump versions inside a PR** — the release workflow owns versioning; branches stay at the
> current released version. To bump locally for any reason, use `npm run version:lockstep <version>`
> (never `npm version -w <pkg>`, which bumps one package and leaves the pin behind — the lockstep
> check rejects that).

> **Branch protection:** the workflow pushes the release commit + tag to `main`, so the GitHub Actions
> token must be allowed to push to `main` (if `main` is protected, let the actions bot bypass, or use
> a PAT / GitHub App token). The push happens **before** publishing, so a rejected push fails the run
> without publishing to npm.

---

## Manual publish fallback (if CI is unavailable)

A maintainer with org publish rights can publish by hand. **Build first, and publish in dependency
order** (`npm run list:packages`):

```bash
npm install && npm run build
cd packages/types  && npm publish && cd ../..
cd packages/core   && npm publish && cd ../..
cd packages/server && npm publish && cd ../..
```

Skip a package whose version is already published. (`publishConfig.access=public` keeps these
public; a local manual publish won't attach provenance — only the OIDC CI publish does.)

---

## Consuming the packages

The packages are **public**, so **no npm authentication is required**. Any environment — developer
machines, CI, and the MJ instance running `mj app install` — can install them directly:

```bash
npm install @askskip/server   # pulls in @askskip/core
```

No `.npmrc` token entry is needed for the `@askskip` scope.

---

## Verifying a release

```bash
npm view @askskip/server version
npm view @askskip/core version
npm view @askskip/types version

# Inspect exactly what would be packed, without publishing:
cd packages/server && npm pack --dry-run
```

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Publish workflow ran but published nothing | Neither package's `package.json` version changed. Bump the one(s) you want to release. |
| `npm error 403 ... you do not have permission` (CI) | Trusted publisher not configured for that package, or its repo/workflow fields don't match, or `npm publish` isn't an allowed action. Re-check [step 2](#2-configure-the-trusted-publisher-on-npmjscom-for-each-package); each package is configured separately; the workflow file must be `publish.yml`. |
| Package accidentally published as **private/restricted** | `publishConfig.access` is `public` in every `package.json` — keep it, and don't pass `--access restricted`. To fix an already-restricted package, change its visibility in npm package settings (or `npm access public @askskip/<pkg>`). |
| `npm error 402 / cannot publish over existing version` | That exact version is already published (npm versions are immutable). Bump and retry. |
| Provenance missing on a release | Provenance is attached only by the **OIDC CI publish** from this **public** repo. A local manual publish won't have it; re-publish a new version via CI to attach provenance. |
| OIDC / `id-token` errors in CI | The job needs `permissions: id-token: write` (already set) and npm **≥ 11.5.1** (the workflow upgrades npm). |
| First-ever publish fails via OIDC | Expected — trusted publishing needs the package to exist first. Do the [manual bootstrap](#1-first-publish-manual-token-based). |

---

## Reference

- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [npm package provenance](https://docs.npmjs.com/generating-provenance-statements)
- Workflows: [`.github/workflows/publish.yml`](.github/workflows/publish.yml), [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
