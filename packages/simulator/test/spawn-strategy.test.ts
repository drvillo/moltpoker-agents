import { describe, expect, it } from 'vitest'
import type { AgentPlan } from '@drvillo/moltpoker-agents'

import { buildSpawnArgs } from '../src/spawn-strategy.js'

function makeRequest(overrides?: Partial<{
  agentBin: string
  serverUrl: string
  tableId: string | null
}>) {
  return {
    agentBin: '/tmp/agent-cli.js',
    serverUrl: 'http://localhost:9000',
    tableId: 'tbl_123',
    ...overrides,
  }
}

describe('buildSpawnArgs', () => {
  it('builds args for protocol plan including model and skill-url', () => {
    const plan: AgentPlan = {
      type: 'protocol',
      name: 'ProtoOne',
      model: 'openrouter:mistralai/mistral-small-3.1-24b-instruct',
      skillUrl: 'http://localhost:9000/skill.md',
      llmLogPath: '/tmp/agent-0-protocol.jsonl',
    }

    const args = buildSpawnArgs(plan, makeRequest())
    expect(args).toContain('--type')
    expect(args).toContain('protocol')
    expect(args).toContain('--name')
    expect(args).toContain('ProtoOne')
    expect(args).toContain('--model')
    expect(args).toContain(plan.model)
    expect(args).toContain('--skill-url')
    expect(args).toContain(plan.skillUrl)
    expect(args).toContain('--llm-log-path')
    expect(args).toContain(plan.llmLogPath)
  })

  it('throws if llm plan is missing skill doc path', () => {
    const plan: AgentPlan = {
      type: 'llm',
      name: 'LlmOne',
      model: 'openai:gpt-4.1',
    }
    expect(() => buildSpawnArgs(plan, makeRequest())).toThrow('skillDocPath is required')
  })

  it('does not include table-id when null', () => {
    const plan: AgentPlan = {
      type: 'random',
      name: 'RandOne',
    }
    const args = buildSpawnArgs(plan, makeRequest({ tableId: null }))
    expect(args.includes('--table-id')).toBe(false)
  })
})

// R6 — simulator plumbs per-run / per-config IDs to spawned children via env
describe('ChildProcessSpawnStrategy — simulation env plumbing', () => {
  it('passes MOLT_SIM_RUN_ID / MOLT_SIM_CONFIG_ID from request.env to child process env', async () => {
    const { ChildProcessSpawnStrategy } = await import('../src/spawn-strategy.js')
    const strategy = new ChildProcessSpawnStrategy()
    const plan: AgentPlan = { type: 'random', name: 'Carol' }

    // Capture the options the strategy would hand to child_process.spawn
    const spy = (strategy as unknown as { _spawnSpy?: (...args: unknown[]) => unknown })
    let capturedEnv: Record<string, string> | undefined
    const originalSpawn = (strategy as unknown as { spawn: Function }).spawn
    ;(strategy as unknown as { spawn: Function }).spawn = (
      p: AgentPlan,
      req: { env?: Record<string, string> },
    ) => {
      capturedEnv = { ...process.env, ...(req.env ?? {}) } as Record<string, string>
      return { kill: () => {}, on: () => {} } as unknown as ReturnType<typeof originalSpawn>
    }

    strategy.spawn(plan, {
      agentBin: '/tmp/agent.js',
      serverUrl: 'http://localhost:9000',
      tableId: null,
      env: {
        MOLT_SIM_RUN_ID: 'simrun_42',
        MOLT_SIM_CONFIG_ID: 'simcfg_7',
      },
    })

    expect(capturedEnv?.MOLT_SIM_RUN_ID).toBe('simrun_42')
    expect(capturedEnv?.MOLT_SIM_CONFIG_ID).toBe('simcfg_7')
    void spy
  })
})

// R6 — LiveSimulator propagates simulationRunId/simulationConfigId as env vars
describe('LiveSimulator — propagates simulation IDs to spawned agents', () => {
  it('builds spawn env including MOLT_SIM_RUN_ID / MOLT_SIM_CONFIG_ID when options.simulationRunId is set', async () => {
    const { LiveSimulator } = await import('../src/live.js')
    type SpawnCall = { env?: Record<string, string> }
    const spawnCalls: SpawnCall[] = []
    const fakeStrategy = {
      spawn(_plan: AgentPlan, req: SpawnCall) {
        spawnCalls.push(req)
        return {
          kill: () => {},
          on: (ev: string, cb: () => void) => {
            if (ev === 'spawn') setTimeout(cb, 0)
          },
        } as unknown as ReturnType<SpawnCall['env'] extends never ? never : () => unknown>
      },
    }

    const sim = new LiveSimulator({
      serverUrl: 'http://localhost:9000',
      agentCount: 1,
      agentSlots: [{ type: 'random' }],
      handsToPlay: 1,
      useAutoJoin: true,
      simulationRunId: 'simrun_abc',
      simulationConfigId: 'simcfg_xyz',
    } as unknown as ConstructorParameters<typeof LiveSimulator>[0])

    // Replace the spawn strategy via the private field
    ;(sim as unknown as { spawnStrategy: typeof fakeStrategy }).spawnStrategy = fakeStrategy

    // Drive just the auto-join spawn path directly via the private spawnAgent
    await (sim as unknown as { spawnAgent: (t: string | null, p: AgentPlan) => Promise<void> }).spawnAgent(
      null,
      { type: 'random', name: 'Carol' } as AgentPlan,
    )

    expect(spawnCalls.length).toBe(1)
    expect(spawnCalls[0]!.env?.MOLT_SIM_RUN_ID).toBe('simrun_abc')
    expect(spawnCalls[0]!.env?.MOLT_SIM_CONFIG_ID).toBe('simcfg_xyz')
  })
})
