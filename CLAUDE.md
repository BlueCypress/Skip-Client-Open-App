# Skip Client Open App

A MemberJunction Open App that installs Skip's client-side footprint onto an MJ instance.

## Repository Structure

```
mj-app.json                         # Open App manifest (version, mjVersionRange, hooks)
migrations/                         # SQL Server migration (Skip identity seed)
migrations-pg/                      # PostgreSQL counterpart
packages/types/                     # @askskip/types — Skip request/response TypeScript types
packages/core/                      # @askskip/core — config, record helpers, install/uninstall hooks
packages/server/                    # @askskip/server — SkipProxyAgent, SkipSDK, callback provisioner, middleware
CONFIGURATION.md                    # Full configuration reference (env vars, skip.config.cjs)
PUBLISHING.md                       # npm publishing guide (changesets workflow)
```

## Build

```bash
npm install
npm run build      # builds all packages in dependency order
```

Per-package watch: `npm run watch:types` / `npm run watch:core` / `npm run watch:server`.

## Versioning

This repo uses **[@changesets/cli](https://github.com/changesets/changesets)** for versioning. All `@askskip/*` packages are versioned in **lockstep** (via `"fixed"` in `.changeset/config.json`).

### Creating a changeset

```bash
npm run change     # interactive prompt
```

Or create `.changeset/<name>.md` manually:

```markdown
---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

Description of changes
```

Include the changeset file in your PR. The publish workflow consumes it on merge to `main`.

## Branch Workflow

- **Feature branches** target `next` via PR
- **`next`** merges to `main` for releases
- **`main`** auto-publishes via the publish workflow, then merges back to `next`

## Key Files

| File | Purpose |
|---|---|
| `packages/core/src/skip-config.ts` | Config interfaces, defaults, `getSkipConfig()`, `resolveSkipApiKey()`, `skip.config.cjs` loader |
| `packages/core/src/skip-records.ts` | Creates/removes the Skip AI Agent and component registry records |
| `packages/core/src/setup.ts` | Interactive post-install setup wizard |
| `packages/server/src/skip-sdk.ts` | SkipSDK — builds and sends requests to the Skip Brain API |
| `packages/server/src/skip-agent.ts` | SkipProxyAgent — MJ agent that delegates to Skip via the SDK |
| `packages/server/src/skip-middleware.ts` | Server middleware — validates prerequisites at boot |
| `packages/server/src/skip-callback-key-provisioner.ts` | Auto-provisions scoped API keys for Skip callbacks |

## Code Quality

- **No `any` types** — use proper MJ entity subclasses and typed properties
- **Use entity subclasses** (e.g., `MJAIAgentEntity`, `MJComponentRegistryEntity`) not `BaseEntity`
- **Use typed property accessors** (e.g., `agent.Name = 'Skip'`) not `.Set('Name', 'Skip')`
- **Build after changes**: `npm run build`
- Follow MemberJunction patterns — see the workspace `CLAUDE.md` at `../CLAUDE.md` for full guidelines

## Configuration

See [CONFIGURATION.md](CONFIGURATION.md) for:
- Environment variables (required and optional)
- `skip.config.cjs` entity-filtering options
- Callback URL construction
- API key management
