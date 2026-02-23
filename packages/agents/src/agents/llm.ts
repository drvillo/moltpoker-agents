import { Output, generateText } from 'ai'
import type { LanguageModel } from 'ai'
import { z } from 'zod'
import { existsSync, readFileSync } from 'fs'
import type { GameStatePayload, LegalAction, PlayerAction } from '@drvillo/moltpoker-shared'

import { createAction, type PokerAgent } from './types.js'
import { LlmAgentBase } from './base.js'
import { createJsonlLogger } from '../lib/logger.js'
import {
  formatCards,
  formatHandHeader,
  formatMyCardsLine,
  formatPlayerLine,
  formatStackLine,
  logAgentHandComplete,
  logAgentError,
} from '../lib/output.js'

// ─── Config ──────────────────────────────────────────────────────────────────

export interface LlmAgentConfig {
  /** AI SDK language model instance (e.g. openai('gpt-4.1'), anthropic('claude-sonnet-4-5')) */
  model: LanguageModel
  /** Path to skill.md on disk -- used verbatim as the system prompt */
  skillDocPath?: string
  /** Optional display name */
  name?: string
  /** Temperature for LLM sampling (default 0.3) */
  temperature?: number
  /** Optional JSONL log file path for prompt/response logging */
  logPath?: string
}

// ─── Response Schema ─────────────────────────────────────────────────────────

/** Schema for the structured decision the LLM must return */
const PokerDecisionSchema = z.object({
  reasoning: z.string().describe('Brief reasoning for your decision'),
  kind: z.enum(['fold', 'check', 'call', 'raiseTo']).describe('The action to take'),
  amount: z
    .number()
    .int()
    .nullable()
    .describe('Total amount to raise to. Use null unless kind is raiseTo.'),
})

type PokerDecision = z.infer<typeof PokerDecisionSchema>

// ─── Prompt Formatting ───────────────────────────────────────────────────────

/** Render game state into a concise text prompt for the LLM */
export function formatGameState(state: GameStatePayload, legalActions: LegalAction[]): string {
  const totalPot = state.pots.reduce((sum, p) => sum + p.amount, 0)

  // Find our seat (the one with visible hole cards)
  const mySeat = state.players.find((p) => p.holeCards && p.holeCards.length > 0)
  const mySeatId = mySeat?.seatId ?? state.currentSeat ?? 0

  const lines: string[] = [
    formatHandHeader({ handNumber: state.handNumber, phase: state.phase, totalPot }),
    `Community: ${formatCards(state.communityCards)}`,
    formatMyCardsLine({ cards: mySeat?.holeCards ?? [], seatId: mySeatId }),
    formatStackLine({ stack: mySeat?.stack ?? 0, toCall: state.toCall ?? 0 }),
    '',
    'Players:',
  ]

  for (const p of state.players) {
    lines.push(formatPlayerLine({
      seatId: p.seatId,
      stack: p.stack,
      bet: p.bet,
      folded: p.folded,
      allIn: p.allIn,
      isMe: p.seatId === mySeatId,
    }))
  }

  lines.push('')
  lines.push('Legal actions:')
  for (const a of legalActions) {
    if (a.minAmount !== undefined && a.maxAmount !== undefined)
      lines.push(`  - ${a.kind} (min: ${a.minAmount}, max: ${a.maxAmount})`)
    else lines.push(`  - ${a.kind}`)
  }

  return lines.join('\n')
}

// ─── Decision → PlayerAction ─────────────────────────────────────────────────

/** Convert a raw LLM decision into a PlayerAction (no validation/clamping).
 *  The turn_token is applied by the caller which has access to the game state. */
function buildAction(decision: PokerDecision, state: GameStatePayload): PlayerAction {
  const amount = decision.kind === 'raiseTo' && decision.amount !== null ? decision.amount : undefined
  return createAction(decision.kind, state, amount)
}

// ─── Agent ───────────────────────────────────────────────────────────────────

/**
 * LLM-powered poker agent.
 *
 * Uses the content of skill.md as its system prompt verbatim -- no extra preamble
 * or built-in strategy. This mirrors what a real autonomous LLM agent connecting
 * to the platform would experience: read skill.md, understand the protocol, play poker.
 */
export class LlmAgent extends LlmAgentBase implements PokerAgent {
  private systemPrompt: string
  private log: ReturnType<typeof createJsonlLogger>

  constructor(config: LlmAgentConfig) {
    const baseName = config.name ?? 'LlmAgent'
    const modelId = (config.model as { modelId?: string }).modelId ?? 'unknown'
    super({
      name: `${baseName} (${modelId})`,
      agentType: 'llm',
      model: config.model,
      temperature: config.temperature,
    })
    this.log = createJsonlLogger(config.logPath)
    if (!config.skillDocPath)
      throw new Error('LlmAgent requires a skillDocPath')
    if (!existsSync(config.skillDocPath))
      throw new Error(`Skill doc not found: ${config.skillDocPath}`)
    // skill.md IS the system prompt -- used verbatim
    this.systemPrompt = readFileSync(config.skillDocPath, 'utf-8')
  }

  /** Enable JSONL logging to the given file path (creates parent dirs) */
  enableLogging(logPath: string): void {
    this.log = createJsonlLogger(logPath)
  }

  async getAction(
    state: GameStatePayload,
    legalActions: LegalAction[],
    previousError?: string,
  ): Promise<PlayerAction> {
    let prompt = formatGameState(state, legalActions)

    if (previousError) {
      prompt += `\n\n[RETRY] Your previous action was rejected: ${previousError}\nPlease choose a valid action from the legal actions listed above.`
    }

    const logCtx = {
      handNumber: state.handNumber,
      phase: state.phase,
      seatId: state.currentSeat,
      seq: state.seq,
    }

    this.log({
      event: 'llm_prompt',
      timestamp: new Date().toISOString(),
      ...logCtx,
      prompt,
      isRetry: !!previousError,
    })

    const { output } = await generateText({
      model: this.model,
      output: Output.object({ schema: PokerDecisionSchema }),
      system: this.systemPrompt,
      prompt,
      temperature: this.temperature,
    })

    const decision = output as PokerDecision
    const action = buildAction(decision, state)

    this.log({
      event: 'llm_response',
      timestamp: new Date().toISOString(),
      ...logCtx,
      response: decision,
      action,
    })

    return action
  }

  onHandComplete(handNumber: number, winnings: number): void {
    logAgentHandComplete(this.name, handNumber, winnings)
  }

  onError(error: { code: string; message: string }): void {
    logAgentError(this.name, error)
  }
}
