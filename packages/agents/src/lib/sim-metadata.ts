import { getSimulationModelLabel } from './agent-name.js'

/**
 * Env var name the simulator exports on each spawned agent process to tag the
 * run that owns it. Agent CLI runners read it to build the registration
 * metadata and, together with `SIM_ENV_CONFIG_ID`, to tell admin surfaces
 * which `simulation_runs` row this agent belongs to.
 */
export const SIM_ENV_RUN_ID = 'MOLT_SIM_RUN_ID'

/**
 * Env var name the simulator exports alongside `SIM_ENV_RUN_ID` so admin
 * surfaces can group a run's agents by `simulation_configs` row.
 */
export const SIM_ENV_CONFIG_ID = 'MOLT_SIM_CONFIG_ID'

/** Just the simulator-owned subset of the child process's env. */
export interface SimulationEnv {
  MOLT_SIM_RUN_ID?: string
  MOLT_SIM_CONFIG_ID?: string
}

/**
 * Metadata payload stored on the `agents.metadata` JSONB column when a
 * simulation-spawned agent registers via `POST /v1/agents`. Keyed off
 * `agent_id` by the server, so per-model stats in admin / future
 * leaderboards can join without parsing display names.
 *
 * The index signature makes this directly assignable to
 * `RegistrationOptions.metadata` (`Record<string, unknown>`) without a cast.
 */
export interface SimulationMetadata extends Record<string, unknown> {
  molt_simulation: true
  molt_agent_type: string
  molt_model?: string
  molt_simulation_run_id: string
  molt_simulation_config_id?: string
}

/**
 * Read only the simulator-owned env keys, ignoring everything else. Keeps the
 * surface small enough to unit-test without having to carry `process.env`.
 */
export function readSimulationEnv(env: Record<string, string | undefined>): SimulationEnv {
  const out: SimulationEnv = {}
  if (typeof env[SIM_ENV_RUN_ID] === 'string' && env[SIM_ENV_RUN_ID]!.length > 0) {
    out.MOLT_SIM_RUN_ID = env[SIM_ENV_RUN_ID]
  }
  if (typeof env[SIM_ENV_CONFIG_ID] === 'string' && env[SIM_ENV_CONFIG_ID]!.length > 0) {
    out.MOLT_SIM_CONFIG_ID = env[SIM_ENV_CONFIG_ID]
  }
  return out
}

/**
 * Build the registration metadata for a simulation-spawned agent, or `null`
 * when the current process was not started by the simulator (no run id in
 * env). Callers pass the result to `MoltPokerClient.register({ metadata })`.
 */
export function buildSimulationMetadata(input: {
  type: string
  model?: string | undefined
  env: Record<string, string | undefined>
}): SimulationMetadata | null {
  const envVars = readSimulationEnv(input.env)
  if (!envVars.MOLT_SIM_RUN_ID) return null

  const meta: SimulationMetadata = {
    molt_simulation: true,
    molt_agent_type: input.type,
    molt_simulation_run_id: envVars.MOLT_SIM_RUN_ID,
  }
  if (envVars.MOLT_SIM_CONFIG_ID) {
    meta.molt_simulation_config_id = envVars.MOLT_SIM_CONFIG_ID
  }
  const modelLabel = getSimulationModelLabel(input.type, input.model)
  if (modelLabel) {
    meta.molt_model = modelLabel
  }
  return meta
}
