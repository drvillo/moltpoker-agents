import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  createAgentPlan,
  createSimulationAgentPlan,
  createSdkAgentFromPlan,
  normalizeAgentType,
} from '../../src/factory/agent-factory.js'
import {
  createSimulationFallbackName,
  getSimulationModelLabel,
} from '../../src/lib/agent-name.js'

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

// R6.a — createSimulationFallbackName never carries provider:model in the string.
// The model is kept only in metadata (R6.b/c/e).
describe('createSimulationFallbackName — model privacy', () => {
  it('returns only the base name for protocol agents (no model suffix)', () => {
    const name = createSimulationFallbackName({
      baseName: 'Lisan-Al-Gaib',
      type: 'protocol',
      model: 'openai:gpt-4o-mini',
    })
    expect(name).toBe('Lisan-Al-Gaib')
    expect(name).not.toMatch(/openai:/i)
    expect(name).not.toMatch(/gpt-4o-mini/i)
  })

  it('returns only the base name for llm agents', () => {
    const name = createSimulationFallbackName({
      baseName: 'Grumpy Alice',
      type: 'llm',
      model: 'anthropic:claude-sonnet-4-5',
    })
    expect(name).toBe('Grumpy Alice')
    expect(name).not.toMatch(/anthropic:/i)
    expect(name).not.toMatch(/claude/i)
  })

  it('returns only the base name for autonomous agents', () => {
    const name = createSimulationFallbackName({
      baseName: 'Clever Bob',
      type: 'autonomous',
      model: 'openai:gpt-4.1',
    })
    expect(name).toBe('Clever Bob')
    expect(name).not.toMatch(/openai|gpt-4\.1/i)
  })

  it('returns only the base name for deterministic SDK agents (model undefined)', () => {
    const name = createSimulationFallbackName({
      baseName: 'Risky Carol',
      type: 'random',
    })
    expect(name).toBe('Risky Carol')
  })
})

describe('getSimulationModelLabel — internal/admin helper', () => {
  it('returns the provider:model string for model-bearing types', () => {
    expect(getSimulationModelLabel('protocol', 'openai:gpt-4o-mini')).toBe('openai:gpt-4o-mini')
    expect(getSimulationModelLabel('llm', 'anthropic:claude-sonnet-4-5')).toBe('anthropic:claude-sonnet-4-5')
    expect(getSimulationModelLabel('autonomous', 'openrouter:openai/gpt-4o-mini')).toBe('openrouter:openai/gpt-4o-mini')
  })

  it('returns null for deterministic SDK agent types regardless of model argument', () => {
    expect(getSimulationModelLabel('random', 'openai:gpt-4.1')).toBeNull()
    expect(getSimulationModelLabel('tight')).toBeNull()
    expect(getSimulationModelLabel('callstation', undefined)).toBeNull()
  })

  it('returns null when model is missing for a model-bearing type', () => {
    expect(getSimulationModelLabel('llm')).toBeNull()
    expect(getSimulationModelLabel('protocol', '')).toBeNull()
  })
})

describe('createSimulationAgentPlan — generated sim name never leaks model', () => {
  it('for each supported type, plan.name does not contain provider:model', () => {
    const types = ['random', 'tight', 'callstation', 'llm', 'autonomous', 'protocol'] as const
    for (const type of types) {
      const plan = createSimulationAgentPlan({
        type,
        model:
          type === 'random' || type === 'tight' || type === 'callstation'
            ? undefined
            : 'openai:gpt-4o-mini',
        skillDocPath: type === 'llm' ? '/tmp/skill.md' : undefined,
        skillUrl: type === 'autonomous' || type === 'protocol' ? 'http://localhost/skill.md' : undefined,
      })
      expect(plan.name).not.toMatch(/\(openai|anthropic|openrouter|google|mistral):/i)
      expect(plan.name).not.toMatch(/gpt-4|claude|gemini|mistral|llama/i)
    }
  })
})
