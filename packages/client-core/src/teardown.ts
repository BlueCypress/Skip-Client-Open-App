/**
 * Skip Client — in-process pre-remove teardown.
 *
 * Referenced by the app manifest as `hooks.preRemoveModule: "@askskip/client-core/teardown"`.
 * The Open App engine's RemoveApp() does NOT clean records the app seeded into the MJ core
 * (`__mj`) schema — its built-in metadata cleanup only covers the app's own schema. So this
 * hook reverses the identity footprint the install migration created, plus the scoped
 * callback API key(s) the provisioner minted at runtime (which are in no migration).
 *
 * Deletion order is FK-safe: API Key Scopes -> API Keys -> User Roles -> Entity Permissions
 * -> User -> Role. It never throws — failures are logged so removal can proceed.
 */
import { LogStatus, LogError, RunView } from '@memberjunction/core';
import type { UserInfo, BaseEntity } from '@memberjunction/core';
import { removeSkipRecords } from './skip-records.js';

interface SkipHookPayload {
    App: { ID: string; Name: string; [k: string]: unknown };
    RepoRoot: string;
    Provider: unknown; // IMetadataProvider
    ContextUser: unknown; // UserInfo
    Callbacks?: { OnLog?: (message: string) => void };
    Manifest: unknown;
}

// Stable identifiers seeded by V202606171200__skip_client_security_seed.sql.
const SKIP_SERVICE_USER_ID = '0199FC9E-1468-57FC-8A4E-EF1131DA76EB';
const SKIP_SERVICE_ROLE_ID = '9933BBB6-4139-4256-8087-64F4B9E4351F';
const USER_ROLE_IDS = ['65BC9077-D7B9-49BE-B610-90CA037217DC', '60022E69-E534-4AE6-B399-814B36F721A3'];
const ENTITY_PERMISSION_IDS = [
    'B7C1A009-197B-4987-9C45-11AE070AE02F',
    '14E94742-B25D-478A-9409-394E658B32A7',
    'F1BD10D7-86C7-43BD-A8E0-75B77C2BA503',
    '7E6AD1F0-1DAB-4441-923C-338997702ABC',
    '52D4A00C-AE6A-4C73-B4B0-C40D922054EE',
    '22A6A4DC-39DF-4E3D-AC46-CAB491F7B308',
    '21E86DC8-3E03-41DC-B8E6-B36324666C21',
    '14BA1F89-0FB7-43E9-A283-2EB9A9FF4BBF',
];

export default async function teardown(payload: SkipHookPayload): Promise<void> {
    const contextUser = payload.ContextUser as UserInfo;
    const log = (m: string) => (payload.Callbacks?.OnLog ? payload.Callbacks.OnLog(m) : LogStatus(m));
    const rv = new RunView();

    log('Removing Skip Client identity records...');
    try {
        // 1. Runtime-provisioned scoped callback keys (owned by the Skip Service Account)
        //    and their API Key Scopes. Delete the scopes first (FK to the key).
        const keys = await rv.RunView<BaseEntity>(
            {
                EntityName: 'MJ: API Keys',
                ExtraFilter: `UserID='${SKIP_SERVICE_USER_ID}'`,
                ResultType: 'entity_object',
            },
            contextUser,
        );
        for (const key of keys.Results ?? []) {
            const keyID = (key as unknown as { ID: string }).ID;
            const scopes = await rv.RunView<BaseEntity>(
                {
                    EntityName: 'MJ: API Key Scopes',
                    ExtraFilter: `APIKeyID='${keyID}'`,
                    ResultType: 'entity_object',
                },
                contextUser,
            );
            for (const scope of scopes.Results ?? []) {
                await deleteEntity(scope, log);
            }
            await deleteEntity(key, log);
        }

        // 2. Skip AI Agent + component registry records (created by the setup hook)
        await removeSkipRecords(contextUser, log);

        // 3. Entity Permissions (the 8 seeded rows)
        await deleteByIDs(rv, contextUser, 'MJ: Entity Permissions', ENTITY_PERMISSION_IDS, log);
        // 3. User Roles (the 2 seeded links)
        await deleteByIDs(rv, contextUser, 'MJ: User Roles', USER_ROLE_IDS, log);
        // 4. Skip Service Account user
        await deleteByIDs(rv, contextUser, 'MJ: Users', [SKIP_SERVICE_USER_ID], log);
        // 5. Skip Service role
        await deleteByIDs(rv, contextUser, 'MJ: Roles', [SKIP_SERVICE_ROLE_ID], log);

        log('✓ Skip Client identity records removed. Note: generic API scopes and MJAPI ceiling grants are MJ-core records and are intentionally left in place.');
    } catch (e) {
        LogError(`[skip-client teardown] ${e instanceof Error ? e.message : String(e)}`);
    }
}

async function deleteByIDs(
    rv: RunView,
    contextUser: UserInfo,
    entityName: string,
    ids: string[],
    log: (m: string) => void,
): Promise<void> {
    if (!ids.length) return;
    const inList = ids.map((id) => `'${id}'`).join(',');
    const res = await rv.RunView<BaseEntity>(
        { EntityName: entityName, ExtraFilter: `ID IN (${inList})`, ResultType: 'entity_object' },
        contextUser,
    );
    for (const rec of res.Results ?? []) {
        await deleteEntity(rec, log);
    }
}

async function deleteEntity(entity: BaseEntity, log: (m: string) => void): Promise<void> {
    try {
        const ok = await entity.Delete();
        if (!ok) {
            log(`  ⚠ Failed to delete a ${entity.EntityInfo?.Name ?? 'record'} (${(entity as unknown as { ID?: string }).ID ?? '?'})`);
        }
    } catch (e) {
        log(`  ⚠ Error deleting record: ${e instanceof Error ? e.message : String(e)}`);
    }
}
