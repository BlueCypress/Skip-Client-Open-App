/**
 * @bluecypress/skip-client — Skip Client Open App server package.
 *
 * Bundles the Skip client-side agent code (SkipProxyAgent, SkipSDK), the scoped
 * callback-key provisioner, the server middleware that activates it, and the
 * Skip client config helpers. Loaded ONLY on MJ instances that install the Skip
 * Client Open App: `mj app install` writes a `dynamicPackages.server` entry whose
 * StartupExport is {@link registerSkip}, which MJAPI's createMJServer() invokes at
 * boot. Importing this module triggers the `@RegisterClass` decorators for
 * SkipProxyAgent and SkipMiddleware.
 *
 * The install/uninstall wizard modules are NOT re-exported here — they are separate
 * package entry points referenced by the app manifest's in-process hooks:
 *   - hooks.postInstallModule -> "@bluecypress/skip-client/setup"
 *   - hooks.preRemoveModule   -> "@bluecypress/skip-client/teardown"
 */
import { LogStatus } from '@memberjunction/core';
import { SkipProxyAgent } from './skip-agent.js';
import { SkipMiddleware } from './skip-middleware.js';

export * from './skip-config.js';
export * from './skip-sdk.js';
export * from './skip-agent.js';
export * from './skip-callback-key-provisioner.js';
export * from './skip-middleware.js';

/**
 * Open App server bootstrap entry point — referenced by the manifest as
 * `packages.server[].startupExport`. Importing this package already runs the
 * `@RegisterClass` decorators for SkipProxyAgent and SkipMiddleware; this function
 * makes that explicit (and tree-shake-proof) and logs activation. The actual scoped
 * callback key is minted lazily on the first Skip request by the provisioner.
 */
export function registerSkip(): void {
    // Reference the decorated classes so bundlers cannot drop the registration side effects.
    void SkipProxyAgent;
    void SkipMiddleware;
    LogStatus('[skip-client] Skip Client Open App server package registered (SkipProxyAgent + middleware).');
}
