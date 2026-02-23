import { adjectives, names, uniqueNamesGenerator } from 'unique-names-generator'

export const MAX_AGENT_NAME_LENGTH = 50

export interface BuildAgentNameInput {
  providedName?: string
  fallbackName: string
  maxLength?: number
}

export function truncateAgentName(name: string, maxLength = MAX_AGENT_NAME_LENGTH): string {
  return name.slice(0, maxLength)
}

export function buildAgentName(input: BuildAgentNameInput): string {
  const rawName = input.providedName?.trim() || input.fallbackName
  return truncateAgentName(rawName, input.maxLength)
}

export function createSimulationBaseName(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, names],
    separator: ' ',
    length: 2,
    style: 'capital',
  })
}

export function createSimulationFallbackName(options: {
  baseName: string
  type: string
  model?: string
}): string {
  const suffix = options.type === 'protocol'
    ? options.model ?? options.type
    : options.type
  return `${options.baseName} (${suffix})`
}
