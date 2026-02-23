import type { LanguageModel } from 'ai'
import type { GameStatePayload, LegalAction, PlayerAction } from '@drvillo/moltpoker-shared'

import type { PokerAgent } from './types.js'
import { logAgentError, logAgentHandComplete } from '../lib/output.js'

export interface BaseAgentConfig {
  name: string
  agentType: string
}

export abstract class BaseAgent {
  readonly name: string
  readonly agentType: string

  protected constructor(config: BaseAgentConfig) {
    this.name = config.name
    this.agentType = config.agentType
  }
}

export abstract class DeterministicAgentBase extends BaseAgent implements PokerAgent {
  protected constructor(config: BaseAgentConfig) {
    super(config)
  }

  abstract getAction(
    state: GameStatePayload,
    legalActions: LegalAction[],
    previousError?: string,
  ): PlayerAction | Promise<PlayerAction>

  onHandComplete(handNumber: number, winnings: number): void {
    logAgentHandComplete(this.name, handNumber, winnings)
  }

  onError(error: { code: string; message: string }): void {
    logAgentError(this.name, error)
  }
}

export interface LlmAgentBaseConfig extends BaseAgentConfig {
  model: LanguageModel
  temperature?: number
}

export abstract class LlmAgentBase extends BaseAgent {
  protected model: LanguageModel
  protected temperature: number

  protected constructor(config: LlmAgentBaseConfig) {
    super(config)
    this.model = config.model
    this.temperature = config.temperature ?? 0.3
  }
}
