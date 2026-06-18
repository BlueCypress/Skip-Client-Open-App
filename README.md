# Skip Client Open App

An MemberJunction [Open App](https://github.com/MemberJunction/MJ) that installs the **Skip
client-side footprint** onto an MJ instance — and only onto the instances that actually use Skip.
It replaces the previous approach of baking Skip's agent code and security records into MJ core
(which shipped them to every MJ deployment).

## What it deploys (only on install)

- **Server package `@memberjunction/skip-client`** (`packages/skip-client`): the `SkipProxyAgent`,
  `SkipSDK`, the scoped callback-key provisioner, and a `BaseServerMiddleware` that activates them.
  It is wired into MJAPI via the manifest's `packages.server` bootstrap entry (`registerSkip`).
- **Skip identity records** (`migrations/`): a `Skip Service` role, a `Skip Service Account` user
  (`skip-service@skip.internal`), its UI + Skip Service role links, and full CRUD permissions on the
  MJ Query\* entity family — all written into the MJ core (`__mj`) schema via an idempotent migration.
- **Skip metadata records** (created by the in-process setup hook via the entity framework): the
  **"Skip" AI Agent** (`DriverClass=SkipProxyAgent` — this is what `@skip` resolves to) and the **"Skip"
  component registry** (`registry.askskip.ai`). These previously shipped in MJ core metadata to every
  instance; they now exist only where the app is installed, so a vanilla MJ instance no longer
  advertises a Skip agent it can't run. Removed on uninstall.
- **A reserved schema slot** (`skip_client`) for any future client-side Skip tables (none today).

## Security model

Skip calls back into the client MJAPI using a **scoped API key** (not the unrestricted system key).
The key is minted at runtime by the callback-key provisioner for the Skip Service Account and granted
exactly the scopes Skip needs. The generic pieces this relies on — the resolver scope checks, the
`view:batch` / `query:create|update|delete|test` / `search:execute` scope definitions, and the MJAPI
application-scope ceiling grants — live in **MJ core** (they are inert on instances without a scoped
key) and are a prerequisite for this app. See `skip-client-open-app-implementation-plan.md`.

## Prerequisites

- An MJ core build that includes:
  - the `dynamicPackages.server` runtime loader in `createMJServer()`,
  - the Open App **interactive callback engine** (`hooks.postInstallModule` / `preRemoveModule` +
    interactive prompt callbacks), and
  - the slimmed scoped-API-key changes (resolver scope checks + the generic scopes + MJAPI grants).
- `MJ_BASE_ENCRYPTION_KEY` set on the client (so the Skip API key can be stored encrypted).

## Install / configure / remove

```bash
mj app install https://github.com/BlueCypress/Skip-Client-Open-App
```

Install runs the migration (seeding the Skip identity into `__mj`), npm-installs
`@memberjunction/skip-client`, wires it into `mj.config.cjs`, then runs the **in-process setup wizard**
(`hooks.postInstallModule`) which prompts for the Skip API key + endpoint, stores the key in the MJ
encrypted credential store, and reports the non-secret settings to set as MJAPI env vars. Restart MJAPI
to activate the Skip proxy agent.

```bash
mj app remove skip-client
```

Remove runs the **in-process teardown** (`hooks.preRemoveModule`), which deletes the Skip identity
records and any runtime-provisioned `Skip Callback:` API keys from `__mj` (FK-safe), then drops the
`skip_client` schema. The generic MJ-core scopes/grants are intentionally left in place.

## Config / env vars

| Env var | Purpose | Stored as |
|---|---|---|
| `ASK_SKIP_CHAT_URL` | Skip API endpoint the client posts to | env (read at runtime) |
| `ASK_SKIP_API_KEY` | Outbound key sent to the Skip API | encrypted credential `Skip API Key` (env fallback) |
| `ASK_SKIP_ORGANIZATION_ID` / `ASK_SKIP_ORGANIZATION_INFO` | Org identifiers | env |
| `MJ_BASE_ENCRYPTION_KEY` | Encrypts the stored Skip API key | env (required) |
| `GRAPHQL_BASE_URL` / `MJAPI_PUBLIC_URL` / `GRAPHQL_PORT` / `GRAPHQL_ROOT_PATH` | Build the callback URL Skip uses | env |

## Layout

```
mj-app.json                         # Open App manifest
migrations/                         # Skyway migration: Skip identity -> __mj
packages/skip-client/               # @memberjunction/skip-client server package
skip-client-open-app-implementation-plan.md   # full design + MJ-core changes
```
