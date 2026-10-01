/**
 * @fileoverview The one piece of component-registry identity that both repositories share.
 *
 * A component spec stores the *name* of the registry it came from, and MJ resolves that
 * name to a URI at render time (`ComponentRegistryResolver.getRegistryByName` matches on
 * `Name`). The name is therefore the persisted identity of the origin server: the Skip
 * brain stamps it into every spec it produces, and the Skip Client SDK creates the
 * Component Registry record carrying it.
 *
 * Only the default belongs here. Everything else about registry naming is one-sided:
 *
 *   - `SKIP_REGISTRY_NAME` is read by the **brain** alone (the SDK deliberately learns the
 *     name over HTTP rather than from its own environment), so it lives in Skip-Brain.
 *   - The `REGISTRY_URI_OVERRIDE_*` / `REGISTRY_API_KEY_*` derivation is used by the
 *     **SDK** alone, so it lives in `@askskip/core`.
 *
 * Putting either here would imply a shared contract that does not exist, and would invite
 * the other side to start depending on it.
 */

/**
 * Registry name used when no environment configures one — production.
 *
 * Shared because both sides fall back to it independently: the brain when
 * `SKIP_REGISTRY_NAME` is unset, and the SDK when the brain reports no name (unreachable,
 * or a build predating per-environment naming). If those two defaults ever disagreed, a
 * client would create a registry record under one name while the brain stamped specs with
 * another — surfacing only as `Registry not found: <name>` at render time, long after the
 * mistake.
 *
 * Each Skip environment otherwise publishes under its own name (`Skip-Stage`,
 * `Skip-Local`) so a spec stays bound to the server that can actually serve it. Production
 * keeps the bare name, so every component stored before per-environment naming existed
 * continues to resolve with no migration.
 */
export const DEFAULT_SKIP_REGISTRY_NAME = 'Skip';
