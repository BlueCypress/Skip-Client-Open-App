---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

The Skip callback URL now reaches MJAPI behind a CDN. When `MJAPI_PUBLIC_URL` is a bare origin and GraphQL is served under `GRAPHQL_ROOT_PATH` (for example `/api/`, with the site root serving the web app), the callback is the origin plus that path instead of the bare origin, which answered Skip's calls with the web app's HTML. A public URL that already names a path is used as given. New export: `buildSkipCallbackURL` in `@askskip/core`, used by both the SDK and the boot log line.
