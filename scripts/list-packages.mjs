#!/usr/bin/env node
/**
 * List workspace packages in dependency (declared "workspaces") order — used by CI/publish so
 * new packages are picked up automatically without editing the workflows.
 *
 *   node scripts/list-packages.mjs           # "<name>\t<dir>\t<version>" per line (publish order)
 *   node scripts/list-packages.mjs --dirs    # relative dir per line
 *   node scripts/list-packages.mjs --names   # package name per line
 *   node scripts/list-packages.mjs --json    # JSON array
 */
import { relative } from 'node:path';
import { repoRoot, workspacePackages } from './workspaces.mjs';

const mode = process.argv[2] ?? '';
const pkgs = workspacePackages().map(({ dir, json }) => ({
  name: json.name,
  dir: relative(repoRoot, dir),
  version: json.version,
}));

if (mode === '--json') console.log(JSON.stringify(pkgs, null, 2));
else if (mode === '--names') for (const p of pkgs) console.log(p.name);
else if (mode === '--dirs') for (const p of pkgs) console.log(p.dir);
else for (const p of pkgs) console.log(`${p.name}\t${p.dir}\t${p.version}`);
