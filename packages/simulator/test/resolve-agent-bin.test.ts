import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import { resolveAgentBinPath } from '../src/resolve-agent-bin.js'

const existsSyncSpy = vi.hoisted(() => vi.fn<(p: string) => boolean>())

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, existsSync: existsSyncSpy }
})

const startDir = '/fake/project/packages/simulator/src'

beforeEach(() => {
  existsSyncSpy.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveAgentBinPath', () => {
  it('returns explicit path when provided and file exists', () => {
    const explicit = '/custom/agents/dist/cli.js'
    existsSyncSpy.mockImplementation((p) => String(p) === explicit)

    const result = resolveAgentBinPath({
      explicitPath: explicit,
      startDir,
    })

    expect(result).toEqual({ resolvedPath: explicit, source: 'explicit' })
  })

  it('skips explicit path when file does not exist and falls through to dependency', () => {
    const explicit = '/missing/agents/dist/cli.js'
    const depCliPath = '/installed/node_modules/@drvillo/moltpoker-agents/dist/cli.js'

    existsSyncSpy.mockImplementation((p) => String(p) === depCliPath)

    const fakeResolver = () =>
      'file:///installed/node_modules/@drvillo/moltpoker-agents/dist/index.js'

    const result = resolveAgentBinPath({
      explicitPath: explicit,
      startDir,
      resolveModule: fakeResolver,
    })

    expect(result).toEqual({ resolvedPath: depCliPath, source: 'dependency' })
  })

  it('resolves from installed dependency (no explicit path)', () => {
    const depCliPath = '/app/node_modules/@drvillo/moltpoker-agents/dist/cli.js'

    existsSyncSpy.mockImplementation((p) => String(p) === depCliPath)

    const fakeResolver = () =>
      'file:///app/node_modules/@drvillo/moltpoker-agents/dist/index.js'

    const result = resolveAgentBinPath({
      startDir,
      resolveModule: fakeResolver,
    })

    expect(result).toEqual({ resolvedPath: depCliPath, source: 'dependency' })
  })

  it('handles dev-mode resolution where main entry is src/index.ts', () => {
    const depCliPath = '/workspace/packages/agents/dist/cli.js'

    existsSyncSpy.mockImplementation((p) => String(p) === depCliPath)

    const fakeResolver = () =>
      'file:///workspace/packages/agents/src/index.ts'

    const result = resolveAgentBinPath({
      startDir,
      resolveModule: fakeResolver,
    })

    expect(result).toEqual({ resolvedPath: depCliPath, source: 'dependency' })
  })

  it('falls back to monorepo path when dependency dist missing', () => {
    const monorepoCliPath = '/fake/project/packages/agents/dist/cli.js'

    existsSyncSpy.mockImplementation((p) => {
      const s = String(p)
      if (s === path.join('/fake/project', 'pnpm-workspace.yaml')) return true
      if (s === monorepoCliPath) return true
      return false
    })

    // Dependency resolution fails (package not installed)
    const fakeResolver = () => {
      throw new Error('MODULE_NOT_FOUND')
    }

    const result = resolveAgentBinPath({
      startDir,
      resolveModule: fakeResolver,
    })

    expect(result).toEqual({ resolvedPath: monorepoCliPath, source: 'monorepo' })
  })

  it('throws structured error with all attempted paths when nothing resolves', () => {
    existsSyncSpy.mockReturnValue(false)

    const fakeResolver = () => {
      throw new Error('MODULE_NOT_FOUND')
    }

    expect(() =>
      resolveAgentBinPath({
        explicitPath: '/nope/cli.js',
        startDir: '/tmp/no-workspace',
        resolveModule: fakeResolver,
      }),
    ).toThrow(/Cannot resolve @drvillo\/moltpoker-agents CLI binary/)
  })

  it('error message lists all candidates with labels', () => {
    existsSyncSpy.mockReturnValue(false)

    const fakeResolver = () =>
      'file:///fake/node_modules/@drvillo/moltpoker-agents/dist/index.js'

    try {
      resolveAgentBinPath({
        explicitPath: '/custom/path/cli.js',
        startDir: '/tmp/nowhere',
        resolveModule: fakeResolver,
      })
      expect.fail('should have thrown')
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain('[explicit]')
      expect(msg).toContain('/custom/path/cli.js')
      expect(msg).toContain('[dependency]')
      expect(msg).toContain('[monorepo]')
    }
  })

  it('works end-to-end with real import.meta.resolve (no mock resolver)', () => {
    // Let the real import.meta.resolve find @drvillo/moltpoker-agents
    // in the workspace. The resolved dist/cli.js should exist on disk
    // after a build, but since existsSync is mocked, we match based on
    // the path ending with agents/dist/cli.js.
    existsSyncSpy.mockImplementation((p) => {
      return String(p).endsWith('agents/dist/cli.js')
    })

    const result = resolveAgentBinPath({ startDir })

    expect(result.source).toBe('dependency')
    expect(result.resolvedPath).toMatch(/agents\/dist\/cli\.js$/)
  })
})
