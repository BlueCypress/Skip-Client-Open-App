# Skip Client Configuration

This document covers all configuration options for the Skip Client Open App.

## Environment Variables

Set these in your MJAPI environment (`.env` file or hosting platform).

### Required

| Variable | Purpose |
|---|---|
| `ASK_SKIP_API_KEY` | Outbound API key for authenticating with the Skip API. Stored encrypted by the setup wizard; env var is a fallback. |
| `MJ_BASE_ENCRYPTION_KEY` | Encryption key for the MJ credential store. Generate with `openssl rand -base64 32`. |

Organization identification is handled automatically via the Skip API key -- no separate org ID or info variables are needed.

### Optional

| Variable | Default | Purpose |
|---|---|---|
| `ASK_SKIP_URL` | `https://brain-prod.askskip.ai` | Skip API base URL. Only set this when pointing at a non-production Skip instance. The `/chat` and `/eval/*` endpoints are derived automatically. |
| `GRAPHQL_BASE_URL` | `http://localhost` | MJAPI base URL used to construct the callback URL that Skip Brain calls back to. |
| `MJAPI_PUBLIC_URL` | _(none)_ | Public-facing callback URL. When set, takes precedence over `GRAPHQL_BASE_URL:GRAPHQL_PORT`. Use this when MJAPI is behind a reverse proxy or tunnel (e.g., ngrok). |
| `GRAPHQL_PORT` | `4000` | MJAPI port, appended to `GRAPHQL_BASE_URL` when `MJAPI_PUBLIC_URL` is not set. |
| `GRAPHQL_ROOT_PATH` | `/` | GraphQL endpoint path, appended to the callback URL. |
| `DB_PLATFORM` | _(none)_ | Database platform. Set to `postgresql` if running against PostgreSQL; otherwise SQL Server is assumed. Uses the same env var as MJ's `resolveDbPlatformFromEnv()`. Legacy `DB_PROVIDER` is still accepted as a fallback. Tells Skip Brain which SQL dialect to generate. |
| `REGISTRY_URI_OVERRIDE_SKIP` | _(derived from `ASK_SKIP_URL`)_ | Component registry base URI, e.g. `https://brain-dev.askskip.ai/registry`. Only needed when the registry lives somewhere other than the brain in `ASK_SKIP_URL`. Read directly by MJ's `ComponentRegistryResolver`. |
| `REGISTRY_API_KEY_SKIP` | _(derived from the Skip API key)_ | API key for the component registry. Only needed when the registry requires a different key than `ASK_SKIP_API_KEY`. |

### Component Registry URI

Skip components are served from a registry whose base URI is stored on the `MJ: Component Registries` record named `Skip`. The URI is resolved in this order, and the resolved value is what setup persists on that record:

1. **`REGISTRY_URI_OVERRIDE_SKIP`** — an explicit registry override wins outright. Use it to point the registry at a different host than the chat endpoint.
2. **`ASK_SKIP_URL`** — with no explicit override, the configured brain serves its own registry, so `<ASK_SKIP_URL>/registry` is used.
3. **The stored record value** — with neither variable set, the record is left as-is. On an instance that has never overridden it, that is the production default `https://brain-prod.askskip.ai/registry`.

The env-var name is derived by MemberJunction from the registry record's `Name` (`Skip`), uppercased with non-alphanumeric characters replaced by underscores — hence `REGISTRY_URI_OVERRIDE_SKIP`. The same rule gives `REGISTRY_API_KEY_SKIP`.

Setup runs on install, on every `mj app upgrade`, and on every MJAPI boot (middleware self-heal). Because step 3 falls back to the stored value, a manually corrected row survives those re-runs — but setting either env var makes the environment authoritative and rewrites the row to match.

### Callback URL Construction

The callback URL is how Skip Brain reaches back to your MJAPI to run views, queries, and other operations. It is constructed as:

- **If `MJAPI_PUBLIC_URL` is set:** uses that value directly
- **Otherwise:** `${GRAPHQL_BASE_URL}:${GRAPHQL_PORT}${GRAPHQL_ROOT_PATH}`

Examples:
```
# Behind ngrok:
MJAPI_PUBLIC_URL=https://abc123.ngrok.io

# Direct access (default):
# http://localhost:4000/
```

## skip.config.cjs

An optional configuration file placed in the MJAPI working directory (next to `mj.config.cjs`). Controls which entity metadata is included in the payload sent to the Skip Brain API.

The setup wizard (`mj app install`) offers to create this file with sensible defaults. If the file is absent, built-in defaults are used (identical to what the wizard generates).

### Full Example

```javascript
/**
 * Skip Client configuration.
 *
 * Controls which MJ entity metadata is sent to the Skip Brain API.
 * Edit the lists below to include/exclude entities from the Skip payload.
 */
module.exports = {
    entitiesToSend: {
        // Schemas whose entities are excluded from the Skip metadata payload.
        // The __mj schema contains internal MJ infrastructure entities that
        // Skip generally doesn't need (and that add noise to the AI context).
        excludeSchemas: ['__mj'],

        // Specific entity names to include even when their schema is excluded
        // above. These are __mj entities that Skip uses for context -- tags,
        // lists, and content management entities.
        includeEntitiesFromExcludedSchemas: [
            'MJ: Tags',
            'MJ: Tagged Items',
            'MJ: Lists',
            'MJ: List Details',
            'MJ: Content Items',
            'MJ: Content Item Tags',
            'MJ: Content Item Attributes',
            'MJ: Content Sources',
            'MJ: Content Types',
            'MJ: Content Process Runs',
        ],
    },
};
```

### Configuration Properties

#### `entitiesToSend.excludeSchemas`

**Type:** `string[]`
**Default:** `['__mj']`

Database schemas to exclude from the entity metadata payload. Entities belonging to these schemas are not sent to Skip unless they appear in `includeEntitiesFromExcludedSchemas`.

Excluding the `__mj` schema filters out hundreds of internal MJ infrastructure entities (migrations, audit logs, system tables) that are irrelevant to data analysis and would inflate the AI context window.

#### `entitiesToSend.includeEntitiesFromExcludedSchemas`

**Type:** `string[]`
**Default:** See example above

Specific entity names to include in the payload even if their schema is in `excludeSchemas`. Use MJ entity display names (e.g., `'MJ: Tags'`, not table names).

Add entities here when Skip needs visibility into MJ infrastructure entities for your use case. For example, if you want Skip to query Content Items or work with Tags/Lists, those must be included here since they live in the `__mj` schema.

### How It's Loaded

1. On MJAPI startup, `@askskip/core` attempts to `require('./skip.config.cjs')` from the working directory
2. If found, the `entitiesToSend` section is merged with defaults (missing properties fall back to defaults)
3. If not found, built-in defaults are used silently -- no error, no warning
4. The entity filter is applied in `SkipSDK.refreshSkipEntities()` before each request

### Creating the File

**During install:**
```bash
mj app install https://github.com/BlueCypress/Skip-Client-Open-App --verbose
# The wizard will prompt: "Create a skip.config.cjs file with default entity-filtering settings?"
```

**Manually:**
Create `skip.config.cjs` in your MJAPI working directory using the example above.

**After creating or editing:** restart MJAPI for changes to take effect (the entity cache refreshes periodically, but a restart ensures immediate pickup).

## API Key Management

### Skip API Key (outbound)

The key sent to the Skip Brain API (`x-api-key` header). Two storage options:

1. **Encrypted credential store (preferred):** The setup wizard stores the key as `"Skip API Key"` in the MJ credential store, encrypted with `MJ_BASE_ENCRYPTION_KEY`. The SDK resolves it via `CredentialEngine` at runtime.
2. **Environment variable (fallback):** Set `ASK_SKIP_API_KEY` in the MJAPI environment. Used when the credential store is unavailable or the key hasn't been stored yet.

### Callback Key (inbound)

A scoped API key that Skip Brain uses to call back into your MJAPI. Managed automatically:

1. On the first Skip request, the callback-key provisioner creates a scoped key for the `skip-service@skip.internal` service account
2. The raw key is sent to Skip once; Skip stores it encrypted in its own credential store
3. On subsequent requests (and after MJAPI restarts), the key is not re-sent -- Skip already has it

The callback key is granted exactly these scopes: `view:run`, `view:batch`, `query:run`, `query:create`, `query:update`, `query:delete`, `query:test`, `search:execute`, `prompt:execute`, `agent:execute`, `embedding:generate`.

## Source Files

| File | Purpose |
|---|---|
| [`packages/core/src/skip-config.ts`](packages/core/src/skip-config.ts) | Config interfaces, defaults, `getSkipConfig()`, `resolveSkipApiKey()` |
| [`packages/core/src/setup.ts`](packages/core/src/setup.ts) | Interactive setup wizard, skip.config.cjs generation |
| [`packages/server/src/skip-sdk.ts`](packages/server/src/skip-sdk.ts) | SDK that consumes config and builds Skip API requests |
| [`packages/server/src/skip-callback-key-provisioner.ts`](packages/server/src/skip-callback-key-provisioner.ts) | Auto-provisions scoped callback keys |
| [`packages/server/src/skip-middleware.ts`](packages/server/src/skip-middleware.ts) | Server middleware that validates prerequisites at boot |
