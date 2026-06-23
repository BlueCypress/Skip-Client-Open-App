/**
 * @askskip/client-core — shared foundation for the Skip Client Open App.
 *
 * Holds the pieces used by BOTH lifecycles: the config contract + API-key resolver
 * (skip-config) and the Skip AI Agent / component-registry record helpers (skip-records).
 * The heavy runtime package `@askskip/client` depends on this for those helpers, and the
 * Open App engine resolves the install/uninstall hooks from here:
 *   - hooks.postInstallModule -> "@askskip/client-core/setup"
 *   - hooks.preRemoveModule   -> "@askskip/client-core/teardown"
 *
 * Keeping the kernel here (deps: core + credentials only) is what lets the install hooks
 * run without pulling in the runtime package's heavy AI/server dependencies, and avoids a
 * circular dependency (client -> client-core, never the reverse).
 *
 * `setup`/`teardown` are intentionally NOT re-exported here — they are separate entry
 * points (`./setup`, `./teardown`) imported only by the engine's hook runner.
 */
export * from './skip-config.js';
export * from './skip-records.js';
