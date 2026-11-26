# Releasing

This repository publishes three npm packages via
`.github/workflows/release.yml`, using **npm trusted publishing** (OIDC). No
`NPM_TOKEN` secret is stored in the repo; npm trusts tags built by this
specific workflow instead.

Published packages (released independently so versions can diverge):

1. `@drvillo/moltpoker-sdk`
2. `@drvillo/moltpoker-agents` (depends on `-sdk` and on
   `@drvillo/moltpoker-shared` / `-poker` from the engine repo)
3. `@drvillo/moltpoker-simulator` (depends on `-agents`, `-sdk`,
   `@drvillo/moltpoker-shared`, `@drvillo/moltpoker-poker`)

## One-time npm setup (per package)

Francesco (or whoever owns the npm `@drvillo` scope) performs this once per
package. Needs to be done **before the first release workflow run**.

For each of the three npm packages, on npmjs.com:

1. Go to the package page:
   - https://www.npmjs.com/package/@drvillo/moltpoker-sdk
   - https://www.npmjs.com/package/@drvillo/moltpoker-agents
   - https://www.npmjs.com/package/@drvillo/moltpoker-simulator
2. Open **Settings → Trusted Publishers**.
3. Click **Add trusted publisher → GitHub Actions** and fill in exactly:
   - **Organization or user**: `drvillo`
   - **Repository**: `moltpoker-agents`
   - **Workflow filename**: `release.yml`
   - **Environment name**: _(leave blank)_
4. Save.

That's it on npm's side. No long-lived tokens, no secret rotation.

The engine repo (`drvillo/moltpoker-engine`) publishes
`@drvillo/moltpoker-shared` and `@drvillo/moltpoker-poker`; its
[`RELEASING.md`](https://github.com/drvillo/moltpoker-engine/blob/main/RELEASING.md)
has its own trusted-publisher instructions.

## Cross-repo validation during PR review

PRs here depend on the engine repo. The repo keeps a `pnpm.overrides` block
in `package.json` that points at local tarballs under `./tmp/engine-tarballs`
(gitignored). To rebuild those tarballs from a specific engine branch, run:

```bash
ENGINE_BRANCH=cursor/onboarding-fixes-engine-7593 pnpm cross-repo:engine
pnpm -r test
```

The CI workflow (`.github/workflows/ci.yml`) does the same automatically on
every PR: it clones the engine branch named in its `ENGINE_BRANCH` env (defaults
to the companion fix branch), builds and packs it, then `pnpm install` picks up
the fresh tarballs.

## Cutting a release

Releases are per-package because the three packages don't always bump
together. Tag format: `<pkg>@v<version>`.

Pre-release checklist (per release cut, done by a maintainer):

1. Open a PR that:
   - Bumps the target `packages/<pkg>/package.json` version.
   - Updates the matching `packages/<pkg>/CHANGELOG.md`.
   - **Removes** the `pnpm.overrides` block from the root `package.json`
     (cross-repo tarballs must not appear in a published tree).
   - Regenerates `pnpm-lock.yaml` with `pnpm install --no-frozen-lockfile`.
     This requires the engine's new version to already be published on npm,
     so engine releases always ship first.
2. Review, land on `main`.
3. From a local clone synced to that merge commit:

   ```bash
   # Dependency order: shared/poker (engine repo) first, then sdk, agents, simulator.
   git tag -s sdk@v0.2.7       -m "Release @drvillo/moltpoker-sdk@0.2.7"
   git push origin sdk@v0.2.7
   # wait for the release workflow to finish and the version to appear on npm
   git tag -s agents@v0.3.0    -m "Release @drvillo/moltpoker-agents@0.3.0"
   git push origin agents@v0.3.0
   git tag -s simulator@v0.3.0 -m "Release @drvillo/moltpoker-simulator@0.3.0"
   git push origin simulator@v0.3.0
   ```

The `Release` workflow then, for each tag:

1. Parses the tag into `{ pkg, version }`.
2. Refuses to proceed if `pnpm.overrides` is present in `package.json`.
3. Runs `pnpm install --frozen-lockfile`.
4. Verifies `packages/<pkg>/package.json` version matches the tag.
5. Runs `pnpm -r typecheck`, `pnpm -r build`, `pnpm -r test`.
6. If everything passes, publishes just that package with
   `npm publish --provenance --access public`.

If a step fails, nothing is published for that tag.

## Manually re-running

If you need to retry (for example after a transient npm hiccup), use the
`workflow_dispatch` trigger from the Actions tab and pass the tag name
(`sdk@v0.2.7`) as input. The workflow re-verifies versions, so a mistyped tag
fails without touching npm.
