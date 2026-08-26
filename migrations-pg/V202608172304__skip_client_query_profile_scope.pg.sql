-- ============================================================================
-- MemberJunction PostgreSQL Migration — V202608172304__skip_client_query_profile_scope.sql
-- Hand-ported counterpart of the SQL Server migration of the same name.
--
-- Skip Client Open App — `query:profile` API scope
--
-- Seeds the API scope that guards `TestAndProfileQuerySQL`, the Skip-owned
-- GraphQL resolver this app registers via SkipMiddleware.GetResolverPaths().
--
-- Why this scope is seeded here and not by MJ core:
--   The scope catalog in MJ core (view:*, query:run/read/create/update/delete/test,
--   search:execute, …) describes MJ's own resolvers. `query:profile` describes a
--   resolver that only exists where this app is installed, so MJ has no reason to
--   ship it — and the previous migration's own note is explicit that generic
--   MJ-core scope records are not this app's to seed. The converse holds too: an
--   app-specific resolver's scope IS this app's to seed.
--
-- Why a separate scope rather than reusing `query:test`:
--   Profiling runs the candidate query UNCAPPED to compute statistics over the
--   full result set. That is a different cost profile and a different (narrower)
--   disclosure surface than executing a capped test, and an operator may
--   reasonably want to permit one and not the other. Granting them separately is
--   the only way to make that choice available.
--
-- Degradation when the scope is absent or not granted:
--   `TestAndProfileQuerySQL` still authorizes the call itself against
--   `query:test`, exactly as `TestQuerySQL` does. Only the profile leg is
--   refused, and it is reported as `ProfileUnavailableReason: 'not-authorized'`.
--   Revoking this scope therefore turns profiling off; it never breaks SQL
--   testing.
--
-- Placeholders (substituted by the Open App migration runner):
--   ${mjSchema}             -> MJ core schema (default '__mj')
--   ${flyway:defaultSchema} -> this app's schema ('skip_client'); unused here
--
-- Two records, not one — and the second is easy to miss:
--   1. The scope itself in __mj."APIScope" (the catalog entry).
--   2. An MJAPI application-scope grant in __mj."APIApplicationScope" (the ceiling).
--
-- Authorization is evaluated twice: the API key must hold the scope, AND the
-- application must permit it. `APIKeyEngine.Authorize(hash, 'MJAPI', path, …)`
-- checks the application ceiling independently of the key's own grants, so a key
-- holding query:profile is still denied — "Application does not allow this
-- scope/resource combination" — when no ceiling row exists. MJ core seeds ceiling
-- rows for MJ's own scopes (query:run, query:test, …); it has no reason to seed
-- one for a scope it does not ship, so this app must.
--
-- Idempotent: guarded by the records' stable GUIDs, so re-install / upgrade is a
-- no-op. The per-KEY grant is NOT seeded here — the callback-key provisioner
-- reconciles it onto the Skip callback key at runtime.
-- ============================================================================

SET search_path TO __mj, public;
SET standard_conforming_strings = on;

BEGIN;

/* ── Scope catalog entry ───────────────────────────────────────────────────── */;
-- SQL Server's top-level DECLARE / IF / THROW has no direct equivalent at
-- statement level in PostgreSQL, so the whole guarded insert lives in a DO block
-- (the same idiom the sibling migration uses). RAISE EXCEPTION aborts the
-- transaction, which is what ROLLBACK + THROW did on the SQL Server side.
DO $$
DECLARE
  v_QueryScopeID UUID := (SELECT "ID" FROM "${mjSchema}"."APIScope" WHERE "FullPath" = 'query');
BEGIN
  -- The `query` parent is core MJ metadata present on every supported instance
  -- (>=5.51.0). Its absence means the scope catalog was never deployed, and
  -- inserting a parentless `profile` would both mis-model the hierarchy and risk
  -- colliding on UQ_APIScope_ParentName. Fail loudly rather than seed something
  -- wrong — a silent skip would surface much later as "profiling is always denied".
  IF v_QueryScopeID IS NULL THEN
    RAISE EXCEPTION 'Skip Client: the MJ core API scope ''query'' was not found. Deploy the MJ API scope catalog before installing this app.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "${mjSchema}"."APIScope" WHERE "ID" = '5FB4019D-7DBA-45A3-BDD9-B7995F44073C') THEN
    INSERT INTO "${mjSchema}"."APIScope"
        ("ID", "Name", "ParentID", "FullPath", "Category", "Description", "ResourceType", "IsActive")
    VALUES (
        '5FB4019D-7DBA-45A3-BDD9-B7995F44073C',
        'profile',
        v_QueryScopeID,
        'query:profile',
        'Queries',
        'Compute aggregate statistics over the full, uncapped result set of a transient query via the Skip Client Open App''s TestAndProfileQuerySQL resolver. Returns counts, ratios and numeric ranges only; row values are never returned, and literal values appear only for low-cardinality columns that clear a k-anonymity floor. Implies the cost of executing the query without a row cap.',
        'Query',
        TRUE
    );
  END IF;
END $$;

/* ── MJAPI application ceiling grant ───────────────────────────────────────── */;
-- Without this the scope exists and can be granted to a key, but every call is
-- still denied at the application ceiling.
DO $$
DECLARE
  v_MJAPIAppID UUID := (SELECT "ID" FROM "${mjSchema}"."APIApplication" WHERE "Name" = 'MJAPI');
BEGIN
  IF v_MJAPIAppID IS NULL THEN
    -- Not fatal, unlike the missing `query` parent above. The catalog entry is
    -- valid on any instance, whereas this row is specific to an application MJ
    -- core happens to name 'MJAPI'; a deployment that named it otherwise is
    -- unusual but not corrupt. The consequence is reported at server startup and
    -- in __mj."APIKeyUsageLog", so it will not be silent.
    RAISE NOTICE 'Skip Client: API application ''MJAPI'' not found — skipping the query:profile ceiling grant. Query profiling will be denied until an application-scope grant is added.';
  ELSIF NOT EXISTS (SELECT 1 FROM "${mjSchema}"."APIApplicationScope" WHERE "ID" = 'F7162165-9589-4511-9F4B-4B46EE58CC36') THEN
    -- ResourcePattern/PatternType/IsDeny/Priority mirror the MJ-core rows for the
    -- rest of the query:* family, so profiling is bounded exactly as query:test is.
    INSERT INTO "${mjSchema}"."APIApplicationScope"
        ("ID", "ApplicationID", "ScopeID", "ResourcePattern", "PatternType", "IsDeny", "Priority")
    VALUES (
        'F7162165-9589-4511-9F4B-4B46EE58CC36',
        v_MJAPIAppID,
        '5FB4019D-7DBA-45A3-BDD9-B7995F44073C',
        '*',
        'Include',
        FALSE,
        0
    );
  END IF;
END $$;

COMMIT;
