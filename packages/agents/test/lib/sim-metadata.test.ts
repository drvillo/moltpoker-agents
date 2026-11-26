import { describe, expect, it } from 'vitest'

import {
  buildSimulationMetadata,
  readSimulationEnv,
  type SimulationMetadata,
} from '../../src/lib/sim-metadata.js'

describe('buildSimulationMetadata', () => {
  it('returns null when no simulation env is set (not a sim run)', () => {
    const meta = buildSimulationMetadata({
      type: 'llm',
      model: 'openai:gpt-4.1',
      env: {},
    })
    expect(meta).toBeNull()
  })

  it('returns metadata with molt_model when MOLT_SIM_RUN_ID is set and type is model-bearing', () => {
    const meta = buildSimulationMetadata({
      type: 'protocol',
      model: 'openai:gpt-4o-mini',
      env: {
        MOLT_SIM_RUN_ID: 'simrun_1',
        MOLT_SIM_CONFIG_ID: 'simcfg_1',
      },
    })
    expect(meta).toEqual<SimulationMetadata>({
      molt_simulation: true,
      molt_agent_type: 'protocol',
      molt_model: 'openai:gpt-4o-mini',
      molt_simulation_run_id: 'simrun_1',
      molt_simulation_config_id: 'simcfg_1',
    })
  })

  it('omits molt_model for deterministic SDK agent types', () => {
    const meta = buildSimulationMetadata({
      type: 'random',
      model: undefined,
      env: { MOLT_SIM_RUN_ID: 'r', MOLT_SIM_CONFIG_ID: 'c' },
    })
    expect(meta).toMatchObject({
      molt_simulation: true,
      molt_agent_type: 'random',
      molt_simulation_run_id: 'r',
      molt_simulation_config_id: 'c',
    })
    expect(meta && 'molt_model' in meta).toBe(false)
  })

  it('does not include molt_model when the model-bearing type has no model (defensive)', () => {
    const meta = buildSimulationMetadata({
      type: 'llm',
      model: undefined,
      env: { MOLT_SIM_RUN_ID: 'r', MOLT_SIM_CONFIG_ID: 'c' },
    })
    expect(meta).toMatchObject({
      molt_simulation: true,
      molt_agent_type: 'llm',
      molt_simulation_run_id: 'r',
      molt_simulation_config_id: 'c',
    })
    expect(meta && 'molt_model' in meta).toBe(false)
  })
})

describe('readSimulationEnv', () => {
  it('returns {} when env is missing both keys', () => {
    expect(readSimulationEnv({})).toEqual({})
  })

  it('returns both keys when env has them', () => {
    expect(readSimulationEnv({ MOLT_SIM_RUN_ID: 'r', MOLT_SIM_CONFIG_ID: 'c' })).toEqual({
      MOLT_SIM_RUN_ID: 'r',
      MOLT_SIM_CONFIG_ID: 'c',
    })
  })

  it('ignores unrelated env keys', () => {
    expect(readSimulationEnv({ PATH: '/usr/bin', FOO: 'bar' })).toEqual({})
  })
})
