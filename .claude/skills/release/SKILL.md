---
name: release
description: Prepare a new Skip Client release by analyzing changes since the last git tag, determining the version bump (patch/minor/major), updating package.json files, and adding a CHANGELOG entry.
disable-model-invocation: true
allowed-tools: Bash(git *) Read Edit Grep Glob
---

# Prepare Skip Client Release

Analyze all changes since the last release tag and prepare the next version.

## Step 1: Gather Context

Run these commands to understand what changed:

```!
git describe --tags --abbrev=0 2>/dev/null || echo "no-tags-yet"
```

```!
git log $(git describe --tags --abbrev=0 2>/dev/null || echo --root)..HEAD --oneline --no-merges
```

## Step 2: Analyze and Classify Changes

Read the commit list above and classify each change into one of these categories. Then determine the version bump:

| Bump | Trigger | Examples |
|------|---------|---------|
| **Patch** | Code-only changes | Bug fixes, config tweaks, SDK logic, dependency bumps |
| **Minor** | Schema or feature changes | Database migrations, new config options, new features |
| **Major** | Breaking or architectural | MJ version upgrades, breaking public API changes, type changes in @askskip/types |

Use the **highest applicable bump**. For example, if there are 5 patches and 1 migration, it's a minor bump.

To help classify, check for:
- Migration files: `git diff --name-only $(git describe --tags --abbrev=0 2>/dev/null || echo --root)..HEAD -- migrations/`
- Type changes: `git diff --name-only $(git describe --tags --abbrev=0 2>/dev/null || echo --root)..HEAD -- packages/types/`
- MJ version changes: check if `@memberjunction/*` versions changed in `package.json`

## Step 3: Determine the New Version

Read the current version from the root `package.json` and compute the next version based on your analysis.

## Step 4: Present Plan to User

Before making any changes, present:
1. The proposed version bump (patch/minor/major) with justification
2. A summary of the key changes grouped by category (Added, Changed, Fixed, Removed)
3. The new version number

Ask the user to confirm before proceeding.

## Step 5: Apply Changes

After user confirmation:

1. **Update `version`** in the root `package.json`
2. **Update `version`** in `packages/core/package.json`
3. **Update `version`** in `packages/server/package.json`
4. **Update `version`** in `packages/types/package.json`
5. **Add a new entry** to `CHANGELOG.md` at the top (below the header, above the previous release entry). Create the file if it doesn't exist.

### CHANGELOG Entry Format

Use this exact format, including only the sections that have entries:

```markdown
## [X.Y.Z] - YYYY-MM-DD

Brief one-line summary of this release.

### Added
- New feature or capability descriptions

### Changed
- Modifications to existing functionality

### Fixed
- Bug fix descriptions

### Removed
- Removed features or capabilities
```

Use today's date. Write entries from the user's perspective (what changed in the product), not developer perspective (which files were modified). Group related commits into single entries where appropriate rather than listing every commit individually.

## Step 6: Summary

After applying changes, show:
- The version bump: `vOLD -> vNEW`
- Remind the user to review the changelog entry and commit when ready
