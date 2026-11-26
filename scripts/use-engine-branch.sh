#!/usr/bin/env bash
# Cross-repo validation helper.
#
# Clones the companion drvillo/moltpoker-engine branch, builds its two
# packages, packs them as tarballs, and rewrites this repo's pnpm.overrides
# so `pnpm install` picks up the engine PR instead of the npm registry.
#
# Usage:
#   ENGINE_BRANCH=cursor/onboarding-fixes-engine-7593 ./scripts/use-engine-branch.sh
#   # then:
#   pnpm install
#
# The release workflow does NOT call this: it installs against pnpm-lock.yaml,
# which must resolve to already-published npm versions.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE_BRANCH="${ENGINE_BRANCH:-main}"
ENGINE_REMOTE="${ENGINE_REMOTE:-https://github.com/drvillo/moltpoker-engine.git}"
WORK_DIR="${WORK_DIR:-$(mktemp -d)/engine-src}"
TARBALL_DIR="${TARBALL_DIR:-${REPO_ROOT}/tmp/engine-tarballs}"

echo "[cross-repo] cloning ${ENGINE_REMOTE}@${ENGINE_BRANCH} into ${WORK_DIR}"
mkdir -p "${WORK_DIR}" "${TARBALL_DIR}"
git clone --depth 1 --branch "${ENGINE_BRANCH}" "${ENGINE_REMOTE}" "${WORK_DIR}"

pushd "${WORK_DIR}" >/dev/null
pnpm install --frozen-lockfile
pnpm -r build
pushd packages/shared >/dev/null
pnpm pack --pack-destination "${TARBALL_DIR}"
popd >/dev/null
pushd packages/poker >/dev/null
pnpm pack --pack-destination "${TARBALL_DIR}"
popd >/dev/null
popd >/dev/null

SHARED_TGZ=$(ls "${TARBALL_DIR}"/drvillo-moltpoker-shared-*.tgz | head -1)
POKER_TGZ=$(ls "${TARBALL_DIR}"/drvillo-moltpoker-poker-*.tgz | head -1)

if [ -z "${SHARED_TGZ}" ] || [ -z "${POKER_TGZ}" ]; then
  echo "[cross-repo] FATAL: could not find engine tarballs in ${TARBALL_DIR}" >&2
  exit 1
fi

echo "[cross-repo] rewriting pnpm.overrides to point at:"
echo "  @drvillo/moltpoker-shared -> file:${SHARED_TGZ}"
echo "  @drvillo/moltpoker-poker  -> file:${POKER_TGZ}"

node - <<NODE
const fs = require('fs')
const path = require('path')
const pkgPath = path.join(process.env.REPO_ROOT || process.cwd(), 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.pnpm = pkg.pnpm ?? {}
pkg.pnpm.overrides = Object.assign({}, pkg.pnpm.overrides ?? {}, {
  '@drvillo/moltpoker-shared': 'file:${SHARED_TGZ}',
  '@drvillo/moltpoker-poker':  'file:${POKER_TGZ}',
})
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
NODE

cd "${REPO_ROOT}"
echo "[cross-repo] done. Running: pnpm install --no-frozen-lockfile"
REPO_ROOT="${REPO_ROOT}" pnpm install --no-frozen-lockfile
echo "[cross-repo] now run: pnpm -r test"
