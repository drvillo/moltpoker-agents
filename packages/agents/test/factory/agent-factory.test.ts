import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  createAgentPlan,
  createSdkAgentFromPlan,
  normalizeAgentType,
} from '../../src/factory/agent-factory.js'

describe('agent factory', () => {
  it('normalizes aliases to canonical type', () => {
    expect(normalizeAgentType('call-station')).toBe('callstation')
  })

  it('builds a protocol plan and truncates display name to max length', () => {
    const plan = createAgentPlan({
      type: 'protocol',
      model: 'openrouter:mistralai/mistral-small-3.1-24b-instruct',
      skillUrl: 'http://localhost:9000/skill.md',
      name: 'X'.repeat(80),
    })

    expect(plan.type).toBe('protocol')
    expect(plan.name.length).toBe(50)
  })

  it('validates llm plan requires model + skillDocPath', () => {
    expect(() => createAgentPlan({ type: 'llm', skillDocPath: 'public/skill.md' })).toThrow(
      '--model is required',
    )
    expect(() => createAgentPlan({ type: 'llm', model: 'openai:gpt-4.1' })).toThrow(
      'skillDocPath is required',
    )
  })

  it('creates deterministic sdk agent from plan', async () => {
    const plan = createAgentPlan({ type: 'random' })
    const agent = await createSdkAgentFromPlan(plan)
    expect(agent.name).toBe('RandomAgent')
  })

  it('creates llm sdk agent from plan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-factory-'))
    const skillDocPath = join(dir, 'skill.md')
    writeFileSync(skillDocPath, '# skill')

    const plan = createAgentPlan({
      type: 'llm',
      model: 'openai:gpt-4.1',
      skillDocPath,
      name: 'FactoryLlm',
    })
    const agent = await createSdkAgentFromPlan(plan)
    expect(agent.name).toContain('FactoryLlm')

    rmSync(dir, { recursive: true, force: true })
  })
})
