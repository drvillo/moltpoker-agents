import type { PokerAgent } from '../agents/types.js'
import { RandomAgent } from '../agents/random.js'
import { TightAgent } from '../agents/tight.js'
import { CallStationAgent } from '../agents/call-station.js'
import { LlmAgent } from '../agents/llm.js'
import { buildAgentName, createSimulationBaseName, createSimulationFallbackName } from '../lib/agent-name.js'
import { resolveModel } from '../lib/model-resolver.js'

export type AgentType = 'random' | 'tight' | 'callstation' | 'llm' | 'autonomous' | 'protocol'

export interface AgentPlanInput {
  type: string
  model?: string
  name?: string
  skillDocPath?: string
  skillUrl?: string
  llmLogPath?: string
  simulationBaseName?: string
}

export interface AgentPlan {
  type: AgentType
  name: string
  model?: string
  skillDocPath?: string
  skillUrl?: string
  llmLogPath?: string
}

export function normalizeAgentType(type: string): AgentType {
  const normalized = type.toLowerCase()
  if (normalized === 'call-station') return 'callstation'
  if (
    normalized !== 'random'
    && normalized !== 'tight'
    && normalized !== 'callstation'
    && normalized !== 'llm'
    && normalized !== 'autonomous'
    && normalized !== 'protocol'
  ) {
    throw new Error(`Unknown agent type: ${type}`)
  }
  return normalized
}

function defaultAgentFallbackName(type: AgentType, model?: string): string {
  if (type === 'llm') {
    const modelId = model?.split(':').slice(1).join(':') ?? 'unknown'
    return `LlmAgent (${modelId})`
  }
  if (type === 'autonomous') {
    const modelId = model?.split(':').slice(1).join(':') ?? 'unknown'
    return `AutonomousAgent (${modelId})`
  }
  if (type === 'protocol') {
    const modelId = model?.split(':').slice(1).join(':') ?? 'unknown'
    return `ProtocolAgent (${modelId})`
  }
  if (type === 'random') return 'RandomAgent'
  if (type === 'tight') return 'TightAgent'
  return 'CallStationAgent'
}

export function createAgentPlan(input: AgentPlanInput): AgentPlan {
  const type = normalizeAgentType(input.type)
  const model = input.model

  if ((type === 'llm' || type === 'autonomous' || type === 'protocol') && !model)
    throw new Error(`--model is required for ${type} agent`)
  if (type === 'llm' && !input.skillDocPath)
    throw new Error('skillDocPath is required for llm agents')
  if ((type === 'autonomous' || type === 'protocol') && !input.skillUrl)
    throw new Error(`skillUrl is required for ${type} agents`)

  const fallbackName = input.simulationBaseName
    ? createSimulationFallbackName({
      baseName: input.simulationBaseName,
      type,
      model,
    })
    : defaultAgentFallbackName(type, model)

  const name = buildAgentName({
    providedName: input.name,
    fallbackName,
  })

  return {
    type,
    name,
    model,
    skillDocPath: input.skillDocPath,
    skillUrl: input.skillUrl,
    llmLogPath: input.llmLogPath,
  }
}

export function createSimulationAgentPlan(input: Omit<AgentPlanInput, 'simulationBaseName'>): AgentPlan {
  return createAgentPlan({
    ...input,
    simulationBaseName: createSimulationBaseName(),
  })
}

export async function createSdkAgentFromPlan(plan: AgentPlan): Promise<PokerAgent> {
  switch (plan.type) {
    case 'random':
      return new RandomAgent()
    case 'tight':
      return new TightAgent()
    case 'callstation':
      return new CallStationAgent()
    case 'llm': {
      const modelSpec = plan.model
      if (!modelSpec) throw new Error('--model is required for llm agent')
      const model = await resolveModel(modelSpec)
      return new LlmAgent({
        model,
        skillDocPath: plan.skillDocPath,
        name: plan.name,
        logPath: plan.llmLogPath,
      })
    }
    default:
      throw new Error(`Unsupported SDK agent type: ${plan.type}`)
  }
}
