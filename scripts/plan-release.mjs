#!/usr/bin/env node
/**
 * Durable release planner. Anchors the next version to what is ACTUALLY PUBLISHED on npm — never
 * to whatever the files happen to say — so a wrong version in the files can't cause a jumped or
 * skipped release. Fails loudly on any mismatch.
 *
 *   base      = highest version published across all workspace packages (0.0.0 if none published)
 *   expected  = base bumped by <level>
 *   fileVer   = the version currently in the files (mj-app.json; check:lockstep already guarantees
 *               every package + the manifest agree and internal deps are pinned exact)
 *
 * Valid states:
 *   fileVer === base      -> fresh release: bump to expected.                  (mode=fresh)
 *   fileVer === expected  -> a prior release bumped the files but its publish step didn't finish;
 *                            re-publish the same version (idempotent).         (mode=resume)
 *   anything else         -> FAIL: the files disagree with npm; refuse to release.
 *
 * Example the check catches: npm latest is 1.0.1, you ask for a patch (expected 1.0.2), but the
 * files say 1.1.0 — neither base nor expected, so the release is refused instead of jumping.
 *
 * Usage: node scripts/plan-release.mjs <patch|minor|major>
 * Prints KEY=VALUE lines (next, base, mode) to stdout for `>> "$GITHUB_OUTPUT"`; diagnostics go
 * to stderr. Exits non-zero on mismatch.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { repoRoot, readJSON, workspacePackages } from './workspaces.mjs';

const level = process.argv[2];
if (!['patch', 'minor', 'major'].includes(level)) {
  console.error(`✖ usage: plan-release.mjs <patch|minor|major> (got "${level ?? ''}")`);
  process.exit(2);
}

const CORE = /^(\d+)\.(\d+)\.(\d+)/;
const parse = (v) => {
  const m = CORE.exec(v ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const gt = (a, b) => {
  const A = parse(a), B = parse(b);
  for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] > B[i];
  return false;
};
const bump = (v, lvl) => {
  const [a, b, c] = parse(v);
  return lvl === 'major' ? `${a + 1}.0.0` : lvl === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
};

const publishedVersion = (name) => {
  try {
    return execFileSync('npm', ['view', name, 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null; // 404 / never published
  }
};

const pkgs = workspacePackages();
const published = pkgs.map((p) => ({ name: p.json.name, version: publishedVersion(p.json.name) }));
const base = published.reduce((max, p) => (p.version && (!max || gt(p.version, max)) ? p.version : max), null) ?? '0.0.0';

const fileVer = readJSON(join(repoRoot, 'mj-app.json')).version;
const expected = bump(base, level);

const report = published.map((p) => `    ${p.name}: ${p.version ?? '(unpublished)'}`).join('\n');
console.error(
  `Published on npm:\n${report}\n` +
  `  base (max published) = ${base}\n` +
  `  files                = ${fileVer}\n` +
  `  level                = ${level}\n` +
  `  expected next        = ${expected}`,
);

let next, mode;
if (fileVer === base) {
  next = expected;
  mode = 'fresh';
} else if (fileVer === expected) {
  next = fileVer;
  mode = 'resume';
} else {
  console.error(
    `\n✖ version mismatch — refusing to release.\n` +
    `  The files are at ${fileVer}, but for a "${level}" release off npm ${base} the next version is ${expected}.\n` +
    `  Files must be at ${base} (fresh release) or ${expected} (resuming a failed publish).\n` +
    `  Reconcile with 'npm run version:lockstep <version>' before releasing.`,
  );
  process.exit(1);
}

console.error(`\n✓ plan: ${mode} release -> ${next}`);
console.log(`next=${next}`);
console.log(`base=${base}`);
console.log(`mode=${mode}`);
