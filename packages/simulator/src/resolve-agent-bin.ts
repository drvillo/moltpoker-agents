import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

/**
 * Resolve the @drvillo/moltpoker-agents CLI binary path.
 *
 * Candidate order:
 *   1. Explicit override (agentBinPath option) — if present AND file exists
 *   2. Installed dependency — resolve via ESM import.meta.resolve
 *   3. Monorepo dev fallback — walk up from startDir looking for pnpm-workspace.yaml
 *
 * Throws a structured error listing all attempted paths when none resolve.
 */
export function resolveAgentBinPath(opts: {
  /** Caller-provided explicit path (LiveSimulatorOptions.agentBinPath) */
  explicitPath?: string
  /** Directory to anchor monorepo-root search from (typically __dirname) */
  startDir: string
  /**
   * Resolver for the agents package specifier. Defaults to import.meta.resolve.
   * Accepts the same signature: (specifier) => URL string.
   * Injected for testability since import.meta.resolve cannot be mocked.
   */
  resolveModule?: (specifier: string) => string
}): { resolvedPath: string; source: 'explicit' | 'dependency' | 'monorepo' } {
  const candidates: Array<{ label: string; path: string }> = []

  // ── 1. Explicit override ──────────────────────────────────────────────
  if (opts.explicitPath) {
    candidates.push({ label: 'explicit', path: opts.explicitPath })
    if (existsSync(opts.explicitPath)) {
      return { resolvedPath: opts.explicitPath, source: 'explicit' }
    }
  }

  // ── 2. Installed dependency ───────────────────────────────────────────
  // Resolve the main entry of @drvillo/moltpoker-agents via ESM resolution,
  // then derive the package root.  Main entry lands in dist/index.js (prod)
  // or src/index.ts (dev --conditions=development) — one level up from
  // dirname(mainEntry) gives the package root.
  try {
    const resolve = opts.resolveModule ?? import.meta.resolve
    const mainEntryUrl = resolve('@drvillo/moltpoker-agents')
    const mainEntry = mainEntryUrl.startsWith('file:')
      ? fileURLToPath(mainEntryUrl)
      : mainEntryUrl
    const pkgRoot = path.dirname(path.dirname(mainEntry))
    const depCliPath = path.join(pkgRoot, 'dist', 'cli.js')
    candidates.push({ label: 'dependency', path: depCliPath })
    if (existsSync(depCliPath)) {
      return { resolvedPath: depCliPath, source: 'dependency' }
    }
  } catch {
    // Module resolution failed (package not installed) — continue to fallback
  }

  // ── 3. Monorepo dev fallback ──────────────────────────────────────────
  const repoRoot = findRepoRoot(opts.startDir)
  const monorepoCliPath = path.join(repoRoot, 'packages', 'agents', 'dist', 'cli.js')
  candidates.push({ label: 'monorepo', path: monorepoCliPath })
  if (existsSync(monorepoCliPath)) {
    return { resolvedPath: monorepoCliPath, source: 'monorepo' }
  }

  // ── None found ────────────────────────────────────────────────────────
  const tried = candidates.map((c) => `  - [${c.label}] ${c.path}`).join('\n')
  throw new Error(
    `Cannot resolve @drvillo/moltpoker-agents CLI binary.\n` +
      `Tried:\n${tried}\n` +
      `Ensure the agents package is installed or provide an explicit agentBinPath.`,
  )
}

function findRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir)
  const root = path.parse(dir).root
  while (dir !== root) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    dir = path.dirname(dir)
  }
  return process.cwd()
}
