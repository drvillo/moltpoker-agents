import { describe, expect, it } from 'vitest'
import type { AgentPlan } from '@moltpoker/agents'

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
