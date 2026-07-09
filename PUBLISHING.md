# Publishing the Skip Client packages

> **Public packages, public repo.** All packages are published **publicly** to the **`@askskip`**
> npm org. Each `package.json` pins `publishConfig.access = "public"` so a plain `npm publish`
> publishes the scoped package publicly (no `--access` flag needed). Anyone can install them —
> including `mj app install` — with **no npm authentication**.

This repo is an **npm workspaces monorepo** using **[@changesets/cli](https://github.com/changesets/changesets)** for versioning and publishing, matching the MJ and SaaS repos. Today it publishes:

| Package | Path | What it is |
| --- | --- | --- |
| **`@askskip/types`** | [`packages/types`](packages/types) | Skip request/response types shared with the Skip API |
| **`@askskip/core`** | [`packages/core`](packages/core) | Config, API-key resolver, Skip record helpers, install/uninstall hooks |
| **`@askskip/server`** | [`packages/server`](packages/server) | SkipProxyAgent, SkipSDK, callback-key provisioner, middleware |

**All packages are versioned in lockstep** via the `"fixed"` config in `.changeset/config.json` — a changeset for any one package bumps them all to the same version.

---

## How it works

### 1. Create a changeset (on your feature branch)

```bash
npm run change
```

Follow the prompts to select the bump level (patch/minor/major) and describe your changes. This creates a `.changeset/<random-name>.md` file — commit it with your PR.

You can also create the file manually:

```markdown
---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

Description of your changes
```

### 2. Merge to `next`, then to `main`

PRs target `next`. When `next` merges to `main`, the publish workflow runs automatically.

### 3. Automated publish (on push to `main`)

The [publish workflow](.github/workflows/publish.yml) runs automatically on push to `main`:

1. **Checks for pending changesets** — if none exist, the workflow exits (nothing to release).
2. **`changeset version`** — reads `.changeset/*.md` files, bumps `package.json` versions in lockstep, writes CHANGELOG entries, deletes consumed changeset files.
3. **Syncs `mj-app.json`** — updates both `version` and `mjVersionRange` from the bumped packages.
4. **Builds** all packages in dependency order.
5. **Commits + tags + pushes** — before publishing, so git and npm never drift.
6. **`changeset publish`** — publishes all packages to npm via OIDC trusted publishing with provenance.
7. **Merges `main` back to `next`** — keeps branches in sync.

---

## CI

| Workflow | File | Trigger | What it does |
| --- | --- | --- | --- |
| **CI** | `.github/workflows/ci.yml` | PRs touching `packages/**` | `npm ci` + `npm run build` (whole workspace, in dependency order) |
| **Release & publish** | `.github/workflows/publish.yml` | Push to `main` or manual dispatch | Changeset version + publish + tag + merge back |

---

## Local build

```bash
npm install        # at repo root — installs deps and symlinks internal @askskip/* packages
npm run build      # builds every package in dependency order
```

Per-package watch during development: `npm run watch:types` / `npm run watch:core` / `npm run watch:server`.

---

## One-time bootstrap (per package)

Trusted publishing can only be configured for a package that **already exists** on npm, so the
**first publish of each package is a manual, token-based bootstrap**.

### 1. First publish (manual)

```bash
npm login
npm install && npm run build

cd packages/types  && npm publish && cd ../..
cd packages/core   && npm publish && cd ../..
cd packages/server && npm publish && cd ../..
```

### 2. Configure trusted publisher on npmjs.com (for EACH package)

For each `@askskip/*` package:

1. npmjs.com -> package -> **Settings -> Trusted Publishing**
2. Add **GitHub Actions** trusted publisher:
   - **Organization:** `BlueCypress`
   - **Repository:** `Skip-Client-Open-App`
   - **Workflow filename:** `publish.yml`
   - **Environment:** _(leave blank)_
3. **Allowed actions:** ensure `npm publish` is selected
4. Save

---

## Manual publish fallback

If CI is unavailable, a maintainer with org publish rights can publish by hand:

```bash
npm install && npm run build
cd packages/types  && npm publish && cd ../..
cd packages/core   && npm publish && cd ../..
cd packages/server && npm publish && cd ../..
```

Skip any package whose version is already published.

---

## Consuming the packages

The packages are **public** — no npm authentication required:

```bash
npm install @askskip/server   # pulls in @askskip/core and @askskip/types
```

---

## Verifying a release

```bash
npm view @askskip/server version
npm view @askskip/core version
npm view @askskip/types version
```

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No changeset files, nothing published | Create a changeset on your feature branch: `npm run change` |
| First publish of a new package fails (404) | OIDC can't create packages that don't exist. Do the [manual bootstrap](#1-first-publish-manual) first. |
| `403 ... you do not have permission` (CI) | Trusted publisher not configured for that package. Check [step 2](#2-configure-trusted-publisher-on-npmjscom-for-each-package). |
| `402 / cannot publish over existing version` | That version is already on npm (immutable). Create a new changeset and release again. |
| Provenance missing | Only CI publishes attach provenance. Re-release via CI. |
| OIDC errors | Job needs `permissions: id-token: write` (already set) and npm >= 11.5.1. |

---

## Reference

- [Changesets documentation](https://github.com/changesets/changesets)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [npm package provenance](https://docs.npmjs.com/generating-provenance-statements)
- Workflows: [`.github/workflows/publish.yml`](.github/workflows/publish.yml), [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
