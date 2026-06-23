-- ============================================================================
-- Skip Client Open App — security identity seed
--
-- Deploys the Skip-specific identity records ONLY on instances that install this
-- app (the Open App engine runs this against the consumer DB at install time).
-- These records are the client-side half of the scoped-API-key callback scheme:
--   * Skip Service role          — owns the scoped callback key, CRUD on Query* entities
--   * Skip Service Account user  — the user the scoped key resolves to (skip-service@skip.internal)
--   * Skip Service + UI roles    — UI gives broad read; Skip Service gives Query CRUD
--   * 8 entity permissions       — full CRUD on the MJ Query* entity family for the Skip Service role
--
-- The generic scope catalog (view:batch, query:create/update/delete/test, search:execute)
-- and the MJAPI application-scope ceiling grants are NOT seeded here — they are generic
-- MJ-core records that ship with MJ core. The scoped API key + its per-key scope grants
-- are NOT seeded — they are minted at runtime by the callback-key provisioner.
--
-- Placeholders (substituted by the Open App migration runner):
--   ${mjSchema}            -> MJ core schema (default '__mj')
--   ${flyway:defaultSchema}-> this app's schema ('skip_client'); unused here (records live in __mj)
--
-- Idempotent: every insert is guarded by the record's stable GUID, so re-install /
-- upgrade is a no-op. Reversed by the preRemove teardown hook in @bluecypress/skip-client.
-- ============================================================================

SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- ── Skip Service role ───────────────────────────────────────────────────────
IF NOT EXISTS (SELECT 1 FROM [${mjSchema}].[Role] WHERE [ID] = '9933BBB6-4139-4256-8087-64F4B9E4351F')
BEGIN
    INSERT INTO [${mjSchema}].[Role] ([ID], [Name], [Description])
    VALUES (
        '9933BBB6-4139-4256-8087-64F4B9E4351F',
        'Skip Service',
        'Role for the Skip Service Account. Grants CRUD on query-related entities needed for Skip callback operations (query creation, update, deletion). Pair with the UI role for broad read access.'
    );
END

-- ── Skip Service Account user ───────────────────────────────────────────────
IF NOT EXISTS (SELECT 1 FROM [${mjSchema}].[User] WHERE [ID] = '0199FC9E-1468-57FC-8A4E-EF1131DA76EB')
BEGIN
    INSERT INTO [${mjSchema}].[User] ([ID], [Name], [FirstName], [LastName], [Email], [Type], [IsActive], [LinkedRecordType])
    VALUES (
        '0199FC9E-1468-57FC-8A4E-EF1131DA76EB',
        'Skip Service Account',
        'Skip',
        'Service',
        'skip-service@skip.internal',
        'User',
        1,
        'None'
    );
END

-- ── User-Role links (UI for broad read; Skip Service for Query CRUD) ─────────
IF NOT EXISTS (SELECT 1 FROM [${mjSchema}].[UserRole] WHERE [ID] = '65BC9077-D7B9-49BE-B610-90CA037217DC')
BEGIN
    INSERT INTO [${mjSchema}].[UserRole] ([ID], [UserID], [RoleID])
    VALUES (
        '65BC9077-D7B9-49BE-B610-90CA037217DC',
        '0199FC9E-1468-57FC-8A4E-EF1131DA76EB',
        (SELECT [ID] FROM [${mjSchema}].[Role] WHERE [Name] = 'UI')
    );
END

IF NOT EXISTS (SELECT 1 FROM [${mjSchema}].[UserRole] WHERE [ID] = '60022E69-E534-4AE6-B399-814B36F721A3')
BEGIN
    INSERT INTO [${mjSchema}].[UserRole] ([ID], [UserID], [RoleID])
    VALUES (
        '60022E69-E534-4AE6-B399-814B36F721A3',
        '0199FC9E-1468-57FC-8A4E-EF1131DA76EB',
        '9933BBB6-4139-4256-8087-64F4B9E4351F'
    );
END

-- ── Entity permissions: full CRUD for Skip Service on the MJ Query* family ───
-- EntityID resolved by entity name; permission row keyed by its stable GUID.
DECLARE @SkipServiceRoleID UNIQUEIDENTIFIER = '9933BBB6-4139-4256-8087-64F4B9E4351F';

;WITH SkipPerms ([ID], [EntityName]) AS (
    SELECT 'B7C1A009-197B-4987-9C45-11AE070AE02F', 'MJ: Queries'           UNION ALL
    SELECT '14E94742-B25D-478A-9409-394E658B32A7', 'MJ: Query Categories'  UNION ALL
    SELECT 'F1BD10D7-86C7-43BD-A8E0-75B77C2BA503', 'MJ: Query Fields'      UNION ALL
    SELECT '7E6AD1F0-1DAB-4441-923C-338997702ABC', 'MJ: Query Parameters'  UNION ALL
    SELECT '52D4A00C-AE6A-4C73-B4B0-C40D922054EE', 'MJ: Query Entities'    UNION ALL
    SELECT '22A6A4DC-39DF-4E3D-AC46-CAB491F7B308', 'MJ: Query Permissions' UNION ALL
    SELECT '21E86DC8-3E03-41DC-B8E6-B36324666C21', 'MJ: Query Dependencies'UNION ALL
    SELECT '14BA1F89-0FB7-43E9-A283-2EB9A9FF4BBF', 'MJ: Query SQLs'
)
INSERT INTO [${mjSchema}].[EntityPermission]
    ([ID], [EntityID], [RoleID], [CanCreate], [CanRead], [CanUpdate], [CanDelete], [Type])
SELECT
    p.[ID],
    e.[ID],
    @SkipServiceRoleID,
    1, 1, 1, 1,
    'Allow'
FROM SkipPerms p
INNER JOIN [${mjSchema}].[Entity] e ON e.[Name] = p.[EntityName]
WHERE NOT EXISTS (
    SELECT 1 FROM [${mjSchema}].[EntityPermission] ep WHERE ep.[ID] = p.[ID]
);

COMMIT TRANSACTION;
