#!/usr/bin/env node
/**
 * Enforce lockstep versioning for the app: @askskip/core, @askskip/server, and mj-app.json.
 *
 * "Lockstep" = all three always share the same version AND @askskip/server depends on
 * @askskip/core at that EXACT version (no range), so the npm packages and the Open App
 * manifest (and therefore the release tag) are always released together at one version.
 *
 * Usage:
 *   node scripts/lockstep-version.mjs <version>   Set BOTH packages + the internal pin to <version>.
 *   node scripts/lockstep-version.mjs --check       Verify lockstep; exit non-zero on any mismatch.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(root, 'packages/core/package.json');
const SERVER = join(root, 'packages/server/package.json');
const MANIFEST = join(root, 'mj-app.json');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const write = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + '\n');

const core = read(CORE);
const server = read(SERVER);
const manifest = read(MANIFEST);
const arg = process.argv[2];

if (!arg) {
  console.error('Usage: lockstep-version.mjs <version> | --check');
  process.exit(2);
}

if (arg === '--check') {
  const errors = [];
  if (core.version !== server.version) {
    errors.push(`version mismatch: @askskip/core=${core.version}, @askskip/server=${server.version}`);
  }
  if (manifest.version !== core.version) {
    errors.push(`mj-app.json version "${manifest.version}" must match the package version "${core.version}"`);
  }
  const pin = server.dependencies?.['@askskip/core'];
  if (pin !== core.version) {
    errors.push(`@askskip/server depends on @askskip/core "${pin}" — must be the exact version "${core.version}" (no range)`);
  }
  if (errors.length) {
    console.error('✖ lockstep check failed:');
    for (const e of errors) console.error(`  - ${e}`);
    console.error('  Fix with: npm run version:lockstep <version>');
    process.exit(1);
  }
  console.log(`✓ lockstep OK — @askskip/core, @askskip/server, and mj-app.json all at ${core.version} (exact pin)`);
  process.exit(0);
}

const version = arg.replace(/^v/, '');
if (!SEMVER.test(version)) {
  console.error(`✖ "${arg}" is not a valid semver version`);
  process.exit(2);
}

core.version = version;
server.version = version;
server.dependencies = server.dependencies ?? {};
server.dependencies['@askskip/core'] = version; // exact pin — lockstep
manifest.version = version;
write(CORE, core);
write(SERVER, server);
write(MANIFEST, manifest);
console.log(`✓ set @askskip/core, @askskip/server, and mj-app.json to ${version} (server pins @askskip/core at exact ${version})`);
