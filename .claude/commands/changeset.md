# Generate Changeset

Create a changeset file for the current branch's changes following Skip Client Open App's versioning conventions.

## Instructions

1. **Check for new migration files:**
   - **CRITICAL**: Only check for migrations that were ADDED IN THIS BRANCH
   - Run: `git diff next...HEAD --name-only | grep -E "^migrations(-pg)?/"`
   - **IMPORTANT**: Use `next` branch as baseline (NOT `main`) to avoid counting migrations from other merged branches
   - If the command returns any files, these are NEW migrations added in this branch → use `minor` bumps
   - If the command returns empty (no new migration files), use `patch` bumps

2. **Find modified packages:**
   - Compare against `next` branch for TypeScript changes
   - Run: `git diff next...HEAD --name-only | grep "^packages/" | cut -d'/' -f2 | sort -u`
   - For each modified package directory, read its `package.json` to get the exact package name
   - **All `@askskip/*` packages are versioned in lockstep** (configured via `"fixed"` in `.changeset/config.json`)
   - Therefore, **always include all three packages** in the changeset, even if only one was modified:
     - `@askskip/types`
     - `@askskip/core`
     - `@askskip/server`

3. **Analyze commit messages:**
   - Run: `git log next...HEAD --oneline --no-merges`
   - Use commit messages to generate a concise, descriptive summary (1-3 sentences)
   - Include bullet points for each distinct change

4. **Create changeset file:**
   - Generate a random filename in format: `adjective-noun-verb.md` (e.g., `happy-dragons-fly.md`)
   - Create file in `.changeset/` directory
   - Use this exact format:

```markdown
---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

Summary of changes based on commit messages

- First change description
- Second change description
```

5. **Commit the changeset:**
   - Stage the new changeset file: `git add .changeset/<filename>.md`
   - Create a commit with message: `docs(changeset): <summary>`
   - Use the same summary text from the changeset file
   - Example: `git commit -m "docs(changeset): scope reconciliation and eval databasePlatform forwarding"`

## Versioning Rules

- **Patch bump**: All TypeScript code changes, bug fixes, documentation updates (DEFAULT)
- **Minor bump**: ONLY when NEW migration files were ADDED IN THIS BRANCH in `migrations/` or `migrations-pg/`
- **Major bump**: NEVER use without explicit user approval (breaking changes)

## Important Notes

- Never use the interactive `npx changeset add` command (has TTY issues in automated environments)
- Always create changeset files manually
- All `@askskip/*` packages must use the same bump level (lockstep versioning)
- **ALWAYS use `next` branch as baseline** for both migration and package comparisons
- If no migrations AND no package changes, ask the user what changed

## Example Output

If there are new migrations:

```markdown
---
"@askskip/types": minor
"@askskip/core": minor
"@askskip/server": minor
---

Add Skip identity seed migration for PostgreSQL

- Add PostgreSQL migration for Skip identity seed
- Add SQL Server migration for Skip identity seed
```

If there are only code changes (no migrations):

```markdown
---
"@askskip/types": patch
"@askskip/core": patch
"@askskip/server": patch
---

Scope reconciliation and eval databasePlatform forwarding

- Callback key provisioner reconciles scopes on existing keys at startup
- Added narrowly-scoped entity CRUD scopes for query-family entities
- Moved databasePlatform resolution into buildBaseRequest
```
