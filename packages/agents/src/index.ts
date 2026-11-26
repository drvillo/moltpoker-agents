// ─── Agent Interface & Helpers ───────────────────────────────────────────────

export { type PokerAgent, createAction } from './agents/types.js'
export {
  BaseAgent,
  DeterministicAgentBase,
  LlmAgentBase,
  type BaseAgentConfig,
  type LlmAgentBaseConfig,
} from './agents/base.js'

// ─── SDK-Based Agents ────────────────────────────────────────────────────────

export { RandomAgent } from './agents/random.js'
export { TightAgent } from './agents/tight.js'
export { CallStationAgent } from './agents/call-station.js'
export { LlmAgent, type LlmAgentConfig, formatGameState } from './agents/llm.js'

// ─── Standalone Agents ───────────────────────────────────────────────────────

export {
  AutonomousAgent,
  type AutonomousAgentConfig,
  type StepEvent,
  type ToolStep,
} from './agents/autonomous.js'

export { ProtocolAgent, type ProtocolAgentConfig } from './agents/protocol.js'

// ─── Display & Output Utilities ──────────────────────────────────────────────

export { PokerWsDisplay } from './display/poker-display.js'
export {
  normalizeCard,
  normalizeCards,
  normalizeLegalActions,
  safeParseJson,
} from './display/normalizers.js'

export {
  formatCards,
  formatHandHeader,
  formatCommunityLine,
  formatMyCardsLine,
  formatStackLine,
  formatLegalActionsLine,
  formatChosenAction,
  formatPlayerLine,
  formatHandCompleteHeader,
  formatSeatResultLine,
  logAgentHandComplete,
  logAgentError,
} from './lib/output.js'

// ─── Infrastructure (for programmatic use) ───────────────────────────────────

export { resolveModel } from './lib/model-resolver.js'
export { createJsonlLogger } from './lib/logger.js'
export { loadEnvFiles } from './lib/env.js'
export {
  createAgentPlan,
  createSimulationAgentPlan,
  createSdkAgentFromPlan,
  normalizeAgentType,
  type AgentPlan,
  type AgentPlanInput,
  type AgentType,
} from './factory/agent-factory.js'
export {
  buildAgentName,
  truncateAgentName,
  createSimulationBaseName,
  createSimulationFallbackName,
  getSimulationModelLabel,
  MAX_AGENT_NAME_LENGTH,
} from './lib/agent-name.js'

export {
  buildSimulationMetadata,
  readSimulationEnv,
  SIM_ENV_RUN_ID,
  SIM_ENV_CONFIG_ID,
  type SimulationMetadata,
  type SimulationEnv,
} from './lib/sim-metadata.js'

export {
  decideReconnectAction,
  MAX_WAITING_LOBBY_REJOINS,
  type RejoinAction,
  type RejoinDecision,
  type DecideReconnectInput,
} from './runner/table-status-policy.js'
