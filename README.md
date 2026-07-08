# Skip Client Open App

A MemberJunction [Open App](https://github.com/MemberJunction/MJ) that installs the **Skip client-side footprint** onto an MJ instance. It replaces the previous approach of embedding Skip's agent code into MJ core, so only MJ instances that use Skip have the Skip agent installed.

## Installation Guide

### Prerequisites

Before installing, ensure your MJ environment meets these requirements:

1. **MJ version >= 5.45.0** — run `mj --version` to check
2. **`MJ_BASE_ENCRYPTION_KEY`** set in your MJAPI environment — used to encrypt the stored Skip API key
   ```bash
   # Generate one if you don't have it:
   openssl rand -base64 32
   ```
3. **Skip API key and organization ID** — provided by the Skip team during onboarding
4. **`mj` CLI installed** — `npm install -g @memberjunction/cli`

### Step 1: Configure your project layout (if needed)

If your MJAPI lives in `apps/MJAPI/` (instead of the default `packages/MJAPI/`), add this to your `mj.config.cjs`:

```javascript
openApps: {
    serverPackagePath: 'apps/MJAPI',
    clientPackagePath: 'apps/MJExplorer',
},
```

### Step 2: Install the Open App

```bash
mj app install https://github.com/BlueCypress/Skip-Client-Open-App --verbose
```

The installer will:
1. Run the database migration (creates the Skip Service Account, role, and entity permissions)
2. Install `@askskip/server`, `@askskip/core`, and `@askskip/types` npm packages
3. Add the `dynamicPackages.server` entry to `mj.config.cjs`
4. Run the **interactive setup wizard**, which prompts for:
   - **Skip API base URL** (`ASK_SKIP_URL`) — e.g., `https://brain-prod.askskip.ai`
   - **Skip organization ID** (`ASK_SKIP_ORGANIZATION_ID`)
   - **Skip API key** (`ASK_SKIP_API_KEY`) — stored encrypted in the MJ credential store

### Step 3: Set environment variables

After the setup wizard completes, add these to your MJAPI environment (`.env` file or hosting platform):

```bash
ASK_SKIP_URL=https://brain-prod.askskip.ai
ASK_SKIP_CHAT_URL=https://brain-prod.askskip.ai/chat
ASK_SKIP_ORGANIZATION_ID=<your-org-id>
# ASK_SKIP_API_KEY is stored encrypted in the credential store by the setup wizard.
# Set it here as a fallback only if the credential store is not available:
# ASK_SKIP_API_KEY=skip-xxxxx
```

### Step 4: Restart MJAPI

```bash
# Restart your MJAPI server
npm run start  # or however you start your MJAPI
```

On startup you should see:
```
Loading Open App server packages...
[skip-client] Skip Client Open App server package registered (SkipProxyAgent + middleware).
  Loaded Open App server package: @askskip/server (ran registerSkip)
[skip-client] Skip client ready: service account and required scopes present.
```

### Step 5: Verify

Open MJ Explorer, start a conversation, and type `@skip` followed by a question. The Skip proxy agent should activate and forward the request to the Skip API.

On the first request, the callback key provisioner will automatically:
1. Create a scoped API key on your MJAPI for Skip callbacks
2. Send the key to Skip (one time only)
3. Skip stores it encrypted for future callbacks

## Uninstalling

```bash
mj app remove skip-client
```

This removes the Skip identity records, callback API keys, and the `skip_client` schema. The generic MJ core scopes are left in place (they are inert without a scoped key).

## PostgreSQL support

The migration is authored once, in SQL Server T-SQL, under `migrations/`. A hand-verified
PostgreSQL counterpart lives in `migrations-pg/`. The Open App engine's `DownloadAppMigrations`
(in `@memberjunction/open-app-engine`) is platform-aware: when `mj app install` targets a
Postgres-backed MJ instance it downloads the sibling `migrations-pg/` folder instead of
`migrations/`, falling back to `migrations/` only if no PG variant exists.

To regenerate/verify the PostgreSQL migration after changing `migrations/`:

```bash
npm run mj:migrate:convert   # mj migrate convert --split --source-dir ./migrations --output-dir ./migrations-pg --schema skip_client
```

## Troubleshooting

### "Skip Service Account not found in the user cache"

The MJAPI was started before the Open App migration ran, or the migration failed. Check that the user `skip-service@skip.internal` exists in your `__mj.User` table. If not, re-run: `mj app install https://github.com/BlueCypress/Skip-Client-Open-App`

### "Missing required API scopes"

Your MJ version doesn't include the required API scope definitions. Upgrade to MJ >= 5.44.0 and run `mj migrate`.

### "Your server connection isn't configured (missing: API key)"

The client MJAPI didn't send a callback key to Skip. Check:
- The MJAPI startup log shows `[skip-client] Skip client ready` (not an error)
- The `dynamicPackages.server` entry exists in the config file your MJAPI loads (check the `Config` line in startup output)
- Restart both MJAPI and the Skip API, then retry

### "Invalid API key" on callbacks

The scoped API key stored on Skip doesn't match what's in the client MJAPI's database. This can happen if databases were restored or keys were manually deleted. Fix by deleting the stale records and restarting:

```sql
-- On the client MJAPI database: delete the old callback key
DELETE FROM __mj.APIKeyScope WHERE APIKeyID IN (
    SELECT ID FROM __mj.APIKey WHERE UserID = (
        SELECT ID FROM __mj.[User] WHERE Email = 'skip-service@skip.internal'
    )
);
DELETE FROM __mj.APIKey WHERE UserID = (
    SELECT ID FROM __mj.[User] WHERE Email = 'skip-service@skip.internal'
);
```

Then restart the MJAPI — the provisioner will create a fresh key on the next request.

### PromptCategory warnings at startup

Hundreds of "PromptCategory class does not have a Prompts property" warnings indicate duplicate `@memberjunction/global` packages in `node_modules`. Fix with a clean reinstall:

```bash
rm -rf node_modules package-lock.json
npm install
```

## Configuration Reference

| Env var | Required | Purpose |
|---|:---:|---|
| `ASK_SKIP_URL` | Yes | Skip API base URL (e.g., `https://brain-prod.askskip.ai`) |
| `ASK_SKIP_CHAT_URL` | Yes | Skip chat endpoint (usually `${ASK_SKIP_URL}/chat`) |
| `ASK_SKIP_API_KEY` | Yes* | Outbound API key sent to Skip (*stored encrypted by setup wizard; env is fallback) |
| `ASK_SKIP_ORGANIZATION_ID` | Yes | Your organization's Skip ID |
| `ASK_SKIP_ORGANIZATION_INFO` | No | Optional organization description |
| `MJ_BASE_ENCRYPTION_KEY` | Yes | Encrypts stored credentials (generate with `openssl rand -base64 32`) |
| `GRAPHQL_BASE_URL` | No | MJAPI base URL for callbacks (default: `http://localhost`) |
| `MJAPI_PUBLIC_URL` | No | Public URL for callbacks if behind a proxy (e.g., ngrok URL) |
| `GRAPHQL_PORT` | No | MJAPI port (default: `4000`) |
| `GRAPHQL_ROOT_PATH` | No | GraphQL endpoint path (default: `/`) |

## What it deploys

- **`@askskip/server`** — the `SkipProxyAgent`, `SkipSDK`, scoped callback-key provisioner, and `BaseServerMiddleware` that activates them at MJAPI boot
- **`@askskip/core`** — shared config, record helpers, and the interactive install/uninstall hooks
- **`@askskip/types`** — Skip request/response TypeScript types
- **Skip Service Account** (`skip-service@skip.internal`) — the user the scoped callback key resolves to
- **Skip Service role** — grants CRUD on the MJ Query entity family for callback operations
- **"Skip" AI Agent record** — the agent record that `@skip` resolves to in conversations
- **"Skip" component registry** — the registry entry for `registry.askskip.ai`

## Security model

Skip calls back into the client MJAPI using a **scoped API key** — not the unrestricted system key (`MJ_API_KEY`). The key is minted automatically by the callback-key provisioner for the Skip Service Account and granted exactly the scopes Skip needs (`view:run`, `view:batch`, `query:create/update/delete/test`, `search:execute`, `prompt:execute`, `agent:execute`, `embedding:generate`). The key is sent to Skip once at creation time; Skip stores it encrypted in its credential store.

## Repository layout

```
mj-app.json                         # Open App manifest
migrations/                         # Skyway migration: Skip identity -> __mj (SQL Server)
migrations-pg/                      # PostgreSQL counterpart (see PostgreSQL support above)
packages/types/                     # @askskip/types — Skip request/response types
packages/core/                      # @askskip/core — config, record helpers, install hooks
packages/server/                    # @askskip/server — server runtime package
PUBLISHING.md                       # npm publishing guide
```

## Publishing

See [PUBLISHING.md](PUBLISHING.md) for how npm packages are versioned and published.
