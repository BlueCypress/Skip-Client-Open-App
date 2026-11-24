# Upgrading the Skip Client Open App in a client MJ environment

This guide covers moving a client's MJ environment to a newer version of the Skip Client Open App.

The app is `skip-client`, published from this repo.
In a client repo it adds one dependency, `@askskip/server`, to `apps/MJAPI/package.json`. It also owns the
`skip_client` schema and adds a `dynamicPackages.server` entry to `mj.config.cjs`.

## Before you start

1. **Check which database you're about to change.** The command migrates whatever database `.env.local` points at.
   Some client repos' local env files point at **production**. If the target is prod, make sure that's what you
   intend. The migrations only go forward, and there is no rollback.
2. **Check the MJ version.** The new release's `mjVersionRange` must include the client's MJ version. As of 0.3.11
   that range is `>=6.1.5 <7.0.0`. If the client's MJ is outside it, upgrade MJ first.
3. **Set a GitHub token.** The engine reads releases from the private repo, so it needs `GITHUB_TOKEN` or
   `openApps.github.token` in `mj.config.cjs`. The npm registry auth must also be current, because the engine
   checks it before changing anything.
4. **Create a branch** in the client repo. Use the main clone, not a worktree.
5. **Check the current and available versions:**
   ```bash
   npm run env -- mj app info skip-client
   npm run env -- mj app check-updates
   ```

## Steps

### 1. Run the upgrade from the repo root

The engine uses the current working directory as the repo root, so run the command from there.

```bash
npm run env -- mj app upgrade skip-client --verbose

# To pin a specific version:
npm run env -- mj app upgrade skip-client --version 0.3.11 --verbose
```

The command does the following, in this order:

- runs the new migrations in the `skip_client` schema
- updates `@askskip/server` in `apps/MJAPI/package.json`
- **runs `npm install`**, which updates `package-lock.json`
- updates `mj.config.cjs`, if the new version changes its entries
- runs the app's post-upgrade hook
- records the upgrade in the Open App history

You don't need to run CodeGen. The app's entity metadata ships in its migrations, and its entity classes ship in
its npm packages.

### 2. Build the repo

```bash
npm ci           # optional: install the way CI does, from the lockfile
npm run build
```

### 3. Test locally

Restart MJAPI (`npm run start:api`) and run one Skip request end to end.

### 4. Review and commit

The diff should only touch:

- `apps/MJAPI/package.json`
- `package-lock.json`
- `mj.config.cjs` (only if the new version changes its entries)

Commit those files, push, and open the PR.

### 5. Deploy with CI/CD

- **Legacy repos (CASE-MJ):** merging to `main` deploys MJAPI, because a change to `package.json` triggers the
  path filter.
- **MJ Central repos (ACR, PLUS):** `_mjc_deploy-api.yml` only runs when dispatched by hand, so dispatch it after
  the merge.

Neither pipeline runs the Skip Client migrations. Those already ran in step 1.

### 6. Confirm the upgrade worked

- `npm run env -- mj app info skip-client` shows the new version with status `Active`.
- A Skip request against the deployed MJAPI succeeds.

## If something fails

- **A migration fails:** the app's status becomes `Error`. Fix the cause and run the same command again. It picks
  up from the last migration that succeeded.
- **`npm install` fails:** the engine restores `package.json`. If that restore also fails, the app ends up
  `Disabled`. In that case, fix the install, run `npm install`, then run
  `npm run env -- mj app enable skip-client`.
- **Gap between database and code:** the database is on the new version from step 1, but the deployed MJAPI stays
  on the old package until step 5. Keep that gap short.

## MJ Central clients: alternative route

ACR and PLUS have an `mj-app-manage.yml` workflow. It runs `npx mj app upgrade "$APP_NAME"` in CI, using that
environment's DB secrets, and commits the package changes back to the repo. If MJ Central manages the client, this
route is often cleaner than running the upgrade from a laptop.

## Reference

- `mj app upgrade` source: MJ `packages/MJCLI/src/commands/app/upgrade.ts` and `UpgradeApp` in
  `packages/OpenApp/Engine/src/install/install-orchestrator.ts`
- App manifest: [`mj-app.json`](mj-app.json)
