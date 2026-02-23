import { TableRuntime, type Phase, type TableRuntimeConfig } from '@moltpoker/poker'
import type { PokerAgent } from '@moltpoker/agents'
import type { Card } from '@moltpoker/shared'

export interface HarnessAgentConfig {
  seatId: number
  agent: PokerAgent
  name: string
  /** Override stack for this specific agent (defaults to tableConfig.initialStack) */
  stack?: number
}

export interface HarnessConfig {
  tableConfig: TableRuntimeConfig
  agents: HarnessAgentConfig[]
  handsToPlay: number
}

export interface HandSummary {
  handNumber: number
  totalChipsBefore: number
  totalChipsAfter: number
  playerStacks: { seatId: number; stack: number }[]
  actionsPlayed: number
  phase: Phase
}

export interface SimulationResult {
  hands: HandSummary[]
  totalHands: number
  errors: string[]
}

/** Maximum retries before force-folding and kicking an agent */
const MAX_ACTION_RETRIES = 2

/**
 * In-process simulation harness that wires PokerAgents directly to a TableRuntime.
 * Bypasses the network stack for fast, deterministic, unit-level gameplay testing.
 */
export class SimulationHarness {
  private config: HarnessConfig
  private runtime: TableRuntime
  private agentMap: Map<number, PokerAgent>

  constructor(config: HarnessConfig) {
    this.config = config
    this.runtime = new TableRuntime(config.tableConfig)
    this.agentMap = new Map()

    // Register agents as players
    for (const agentConfig of config.agents) {
      const added = this.runtime.addPlayer(
        agentConfig.seatId,
        `agent-${agentConfig.seatId}`,
        agentConfig.name,
        agentConfig.stack,
      )
      if (!added) {
        throw new Error(`Failed to add agent "${agentConfig.name}" at seat ${agentConfig.seatId}`)
      }
      this.agentMap.set(agentConfig.seatId, agentConfig.agent)
    }
  }

  /**
   * Run the simulation for the configured number of hands.
   * Returns a result with per-hand summaries and any errors encountered.
   * Async to support agents that return Promise<PlayerAction> (e.g. LLM agents).
   */
  async run(): Promise<SimulationResult> {
    const hands: HandSummary[] = []
    const errors: string[] = []
    /** Seats to remove after the current hand (kicked agents) */
    const seatsToRemove: Set<number> = new Set()

    for (let i = 0; i < this.config.handsToPlay; i++) {
      // Remove kicked agents between hands
      for (const seatId of seatsToRemove) {
        this.runtime.removePlayer(seatId)
        this.agentMap.delete(seatId)
      }
      seatsToRemove.clear()

      // Check if enough players remain to play
      const playersWithChips = this.runtime.getAllPlayers().filter((p) => p.stack > 0)
      if (playersWithChips.length < 2) break

      const totalChipsBefore = this.runtime
        .getAllPlayers()
        .reduce((sum, p) => sum + p.stack + p.bet, 0)

      const started = this.runtime.startHand()
      if (!started) break

      // Play the hand action by action
      let actionsPlayed = 0

      while (this.runtime.isHandInProgress()) {
        const currentSeat = this.runtime.getCurrentSeat()
        if (currentSeat < 0) break

        const agent = this.agentMap.get(currentSeat)
        if (!agent) {
          errors.push(`Hand ${this.runtime.getHandNumber()}: No agent for seat ${currentSeat}`)
          break
        }

        const state = this.runtime.getStateForSeat(currentSeat)
        const legalActions = state.legalActions
        if (!legalActions || legalActions.length === 0) {
          errors.push(
            `Hand ${this.runtime.getHandNumber()}: No legal actions for seat ${currentSeat}`,
          )
          break
        }

        // Try to get a valid action with retries
        let applied = false
        let previousError: string | undefined

        for (let attempt = 0; attempt <= MAX_ACTION_RETRIES; attempt++) {
          try {
            const action = await agent.getAction(state, legalActions, previousError)
            const result = this.runtime.applyAction(currentSeat, action)

            if (result.success) {
              applied = true
              break
            }

            // Action was rejected by the runtime -- feed error back for retry
            previousError = result.error
            errors.push(
              `Hand ${this.runtime.getHandNumber()}: Action rejected for seat ${currentSeat} (attempt ${attempt + 1}): ${result.error}`,
            )
          } catch (err) {
            // Agent call itself failed (e.g. LLM API error)
            const errorMsg = err instanceof Error ? err.message : String(err)
            previousError = `Agent call failed: ${errorMsg}`
            errors.push(
              `Hand ${this.runtime.getHandNumber()}: Agent error for seat ${currentSeat} (attempt ${attempt + 1}): ${errorMsg}`,
            )
          }
        }

        if (!applied) {
          // Retries exhausted -- force-fold and mark for removal after this hand
          errors.push(
            `Hand ${this.runtime.getHandNumber()}: Kicking seat ${currentSeat} after ${MAX_ACTION_RETRIES + 1} failed attempts`,
          )
          this.runtime.forceFold(currentSeat)
          seatsToRemove.add(currentSeat)
        }

        actionsPlayed++
      }

      const totalChipsAfter = this.runtime
        .getAllPlayers()
        .reduce((sum, p) => sum + p.stack + p.bet, 0)

      hands.push({
        handNumber: this.runtime.getHandNumber(),
        totalChipsBefore,
        totalChipsAfter,
        playerStacks: this.runtime.getAllPlayers().map((p) => ({
          seatId: p.seatId,
          stack: p.stack,
        })),
        actionsPlayed,
        phase: this.runtime.getPhase(),
      })
    }

    return {
      hands,
      totalHands: hands.length,
      errors,
    }
  }

  /**
   * Get the underlying runtime (useful for additional assertions in tests)
   */
  getRuntime(): TableRuntime {
    return this.runtime
  }

  /**
   * Collect all cards dealt in the current hand (hole cards + community) for uniqueness checks.
   * Should be called while the hand data is still available (before startHand resets).
   */
  static collectAllCards(runtime: TableRuntime): Card[] {
    const state = runtime.getPublicState()
    const cards: Card[] = [...state.communityCards]

    for (const player of runtime.getAllPlayers()) {
      if (player.holeCards && player.holeCards.length > 0) {
        cards.push(...player.holeCards)
      }
    }

    return cards
  }

  /**
   * Check if all cards in the array are unique (no duplicates).
   */
  static hasUniqueCards(cards: Card[]): boolean {
    const seen = new Set<string>()
    for (const card of cards) {
      const key = `${card.rank}${card.suit}`
      if (seen.has(key)) return false
      seen.add(key)
    }
    return true
  }
}
