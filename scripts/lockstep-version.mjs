#!/usr/bin/env node
/**
 * Enforce lockstep versioning across ALL workspace packages + mj-app.json.
 *
 * "Lockstep" = every workspace package shares one version, every internal cross-dependency
 * (a dep whose name is another workspace package) is pinned to that EXACT version (no range),
 * and mj-app.json matches — so the npm packages, the Open App manifest, and the release tag
 * always release together at one version.
 *
 * The package list is discovered from the root "workspaces" field (see workspaces.mjs), so
 * adding a package requires no change here — it is picked up automatically.
 *
 * Usage:
 *   node scripts/lockstep-version.mjs <version>   Set every package + internal pin + manifest.
 *   node scripts/lockstep-version.mjs --check      Verify lockstep; non-zero exit on any mismatch.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, readJSON, workspacePackages } from './workspaces.mjs';

const MANIFEST = join(repoRoot, 'mj-app.json');
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const write = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + '\n');

const pkgs = workspacePackages();
const internal = new Set(pkgs.map((p) => p.json.name)); // workspace package names
const manifest = readJSON(MANIFEST);
const names = pkgs.map((p) => p.json.name).join(', ');
const arg = process.argv[2];

if (!arg) {
  console.error('Usage: lockstep-version.mjs <version> | --check');
  process.exit(2);
}

if (arg === '--check') {
  const errors = [];
  const ref = manifest.version; // everything must match the manifest (the app's released version)
  for (const { json } of pkgs) {
    if (json.version !== ref) {
      errors.push(`version mismatch: ${json.name}=${json.version} — must match mj-app.json "${ref}"`);
    }
    for (const section of DEP_SECTIONS) {
      const deps = json[section];
      if (!deps) continue;
      for (const [name, spec] of Object.entries(deps)) {
        if (internal.has(name) && spec !== ref) {
          errors.push(`${json.name} ${section}["${name}"] = "${spec}" — must be the exact version "${ref}" (no range)`);
        }
      }
    }
  }
  if (errors.length) {
    console.error('✖ lockstep check failed:');
    for (const e of errors) console.error(`  - ${e}`);
    console.error('  Fix with: npm run version:lockstep <version>');
    process.exit(1);
  }
  console.log(`✓ lockstep OK — ${pkgs.length} package(s) + mj-app.json all at ${ref} (exact internal pins): ${names}`);
  process.exit(0);
}

const version = arg.replace(/^v/, '');
if (!SEMVER.test(version)) {
  console.error(`✖ "${arg}" is not a valid semver version`);
  process.exit(2);
}

for (const { pkgPath, json } of pkgs) {
  json.version = version;
  for (const section of DEP_SECTIONS) {
    const deps = json[section];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (internal.has(name)) deps[name] = version; // exact pin — lockstep
    }
  }
  write(pkgPath, json);
}
manifest.version = version;
write(MANIFEST, manifest);
console.log(`✓ set ${pkgs.length} package(s) + mj-app.json to ${version} (internal deps pinned exact): ${names}`);
