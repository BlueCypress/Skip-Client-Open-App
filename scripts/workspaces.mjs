// Shared workspace discovery for the lockstep + packaging scripts.
// Reads the root package.json "workspaces" field and resolves it to the actual package
// dirs, in declared order. Everything that needs "the list of packages" goes through here,
// so adding a package to `workspaces` automatically includes it everywhere — no script edits.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));

/**
 * Resolve the root "workspaces" globs to package dirs.
 * Exact entries (e.g. "packages/core") keep their declared order — this is the dependency
 * order the build/publish steps rely on. A "dir/*" glob expands alphabetically.
 */
export function workspaceDirs(root = repoRoot) {
  const rootPkg = readJSON(join(root, 'package.json'));
  const patterns = Array.isArray(rootPkg.workspaces)
    ? rootPkg.workspaces
    : (rootPkg.workspaces?.packages ?? []);
  const dirs = [];
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const base = join(root, pattern.slice(0, -2));
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const dir = join(base, entry.name);
        if (entry.isDirectory() && existsSync(join(dir, 'package.json'))) dirs.push(dir);
      }
    } else if (existsSync(join(root, pattern, 'package.json'))) {
      dirs.push(join(root, pattern));
    }
  }
  return dirs;
}

/** All workspace packages (declared order), each as { dir, pkgPath, json }. */
export function workspacePackages(root = repoRoot) {
  return workspaceDirs(root).map((dir) => {
    const pkgPath = join(dir, 'package.json');
    return { dir, pkgPath, json: readJSON(pkgPath) };
  });
}
