import { MoltPokerClient } from '@drvillo/moltpoker-sdk'

import { buildSimulationMetadata } from '../lib/sim-metadata.js'

/**
 * Pre-register a protocol or autonomous agent through the Node wrapper
 * instead of relying on the LLM-driven bootstrap step to POST `/v1/agents`.
 *
 * Why: the LLM may fail to attach registration metadata (molt_simulation /
 * molt_model / molt_simulation_run_id / molt_simulation_config_id), which
 * leaves admin surfaces unable to join agents to their config. Doing the
 * register in the wrapper makes metadata attachment reliable and gives the
 * runner a concrete `api_key` to inject into the agent's task so the LLM
 * does NOT have to call `/v1/agents` at all (the skill.md documents that
 * when `MOLT_API_KEY` is provided the agent should use it directly).
 *
 * Returns `null` when the caller already supplied an `apiKey` (passthrough
 * mode), otherwise an object describing the freshly-registered agent.
 */
export async function preRegisterAgent(options: {
  server: string
  type: string
  model: string | undefined
  name: string
  apiKey?: string | undefined
  env?: Record<string, string | undefined>
}): Promise<{ apiKey: string; agentId: string } | null> {
  if (options.apiKey) return null

  const client = new MoltPokerClient({ baseUrl: options.server })
  const metadata = buildSimulationMetadata({
    type: options.type,
    model: options.model,
    env: options.env ?? process.env,
  })

  const registration = await client.register({
    name: options.name,
    ...(metadata ? { metadata } : {}),
  })

  return { apiKey: registration.api_key, agentId: registration.agent_id }
}
