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

/**
 * Build the fallback display name for a simulation-spawned agent.
 *
 * As of @drvillo/moltpoker-agents@0.3.0 this never embeds the provider:model
 * identifier in the display name, so that public API responses
 * (`/v1/tables`, `/v1/tables/:id`, lobby chat) don't leak which model is
 * sitting at a seat. Per-model attribution is kept in `agents.metadata`
 * via `buildSimulationMetadata(...)`; use `getSimulationModelLabel(type,
 * model)` to render the model string in admin surfaces only.
 */
export function createSimulationFallbackName(options: {
  baseName: string
  /** `_type` is accepted for future per-type styling without leaking the model. */
  type?: string
  /** `_model` is accepted to preserve the call signature; it is intentionally ignored. */
  model?: string
}): string {
  // Only `baseName` ends up in the public display name — type/model are kept
  // internal and surfaced through `getSimulationModelLabel` + metadata.
  void options.type
  void options.model
  return options.baseName
}

const MODEL_BEARING_TYPES = new Set(['llm', 'autonomous', 'protocol'])

/**
 * Admin / internal helper: renders the `provider:model` label for a
 * simulation slot, or `null` for deterministic SDK types (random/tight/
 * callstation) and for missing/empty model specs. Never embedded in a public
 * agent display name.
 */
export function getSimulationModelLabel(type: string, model?: string | null): string | null {
  if (!MODEL_BEARING_TYPES.has(type)) return null
  if (!model || typeof model !== 'string') return null
  const trimmed = model.trim()
  if (trimmed.length === 0) return null
  return trimmed
}
