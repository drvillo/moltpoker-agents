/**
 * Unified WebSocket message display formatter for poker agents.
 * 
 * Handles both "human" (verbose) and "compact" (agent) WebSocket message formats,
 * providing consistent console output across all agent types.
 */

import { TableEndReasonLabels } from '@drvillo/moltpoker-shared'

import {
  normalizeCards,
  normalizeLegalActions,
} from './normalizers.js'
import {
  formatChosenAction,
  formatCommunityLine,
  formatHandCompleteHeader,
  formatHandHeader,
  formatLegalActionsLine,
  formatMyCardsLine,
  formatSeatResultLine,
  formatStackLine,
} from '../lib/output.js'

/**
 * Unified poker WebSocket message display handler.
 * Interprets MoltPoker protocol messages and outputs human-readable logs.
 */
export class PokerWsDisplay {
  private mySeatId = -1

  constructor(private agentName: string) {}

  /**
   * Handle a WebSocket message and display relevant information.
   * Supports both human (verbose) and compact (agent) message formats.
   */
  handleMessage(msg: Record<string, unknown>): void {
    if (!msg || typeof msg !== 'object') return
    const msgRecord = msg as Record<string, unknown>
    // Human format wraps data in `payload`; compact format is flat.
    const payload = (msgRecord.payload as Record<string, unknown> | undefined) ?? msgRecord

    switch (msgRecord.type) {
      case 'welcome': {
        // Human: payload.seat_id, payload.action_timeout_ms | Compact: seat, timeout
        this.mySeatId = (payload.seat_id ?? payload.seat ?? -1) as number
        const timeout = payload.action_timeout_ms ?? payload.timeout
        console.log(`Connected! Seat: ${this.mySeatId}, Timeout: ${timeout}ms`)
        break
      }

      case 'game_state': {
        // Pot: human has pots array, compact has pot number
        const totalPot =
          typeof payload.pot === 'number'
            ? (payload.pot as number)
            : ((payload.pots as Array<{ amount: number }>) ?? []).reduce(
                (sum, p) => sum + p.amount,
                0
              )

        // Hand number: human=handNumber, compact=hand
        const handNumber = (payload.handNumber ?? payload.hand_number ?? payload.hand) as number
        const phase = (payload.phase ?? payload.street) as string

        // Community cards: human=communityCards (Card[]), compact=board (string[])
        const communityCards = normalizeCards(
          payload.communityCards ?? payload.community_cards ?? payload.board
        )

        console.log(`\n${formatHandHeader({ handNumber, phase, totalPot })}`)
        console.log(formatCommunityLine(communityCards as never[]))

        // Find my player: human uses seatId, compact uses seat
        const players = (payload.players ?? []) as Array<Record<string, unknown>>
        const myPlayer = players.find((p) => (p.seatId ?? p.seat) === this.mySeatId)

        // Hole cards: human=holeCards (Card[]), compact=cards (string[])
        const myCards = normalizeCards(myPlayer?.holeCards ?? myPlayer?.cards)
        if (myCards.length > 0) {
          console.log(formatMyCardsLine({ cards: myCards as never[], seatId: this.mySeatId }))
          console.log(
            formatStackLine({
              stack: myPlayer?.stack as number,
              toCall: (payload.toCall ?? payload.to_call ?? 0) as number,
            })
          )
        }

        // Legal actions: human=legalActions/currentSeat, compact=actions/turn
        const currentSeat = (payload.currentSeat ?? payload.turn) as number | null | undefined
        const legalActions = normalizeLegalActions(
          payload.legalActions ?? payload.legal_actions ?? payload.actions
        )
        if (currentSeat === this.mySeatId && legalActions.length > 0)
          console.log(formatLegalActionsLine(legalActions as never[]))

        break
      }

      case 'ack': {
        const turnToken = payload.turn_token
        const seq = payload.seq ?? msgRecord.seq
        console.log(`Action acknowledged (turn_token: ${turnToken}, seq: ${seq})`)
        break
      }

      case 'error': {
        const code = payload.code ?? msgRecord.code
        const message = payload.message ?? msgRecord.message
        console.error(`Error: ${code} - ${message}`)
        break
      }

      case 'hand_complete': {
        // Hand number: human=handNumber, compact=hand
        const handNumber = (payload.handNumber ?? payload.hand_number ?? payload.hand) as number
        console.log(`\n${formatHandCompleteHeader(handNumber)}`)
        const results = (payload.results ?? []) as Array<Record<string, unknown>>
        for (const r of results) {
          // Seat: human=seatId, compact=seat
          const seatId = (r.seatId ?? r.seat) as number
          const isMe = seatId === this.mySeatId
          // Cards: human=holeCards (Card[]), compact=cards (string[])
          const cards = normalizeCards(r.holeCards ?? r.cards)
          // Hand rank: human=handRank, compact=rank
          const handRank = (r.handRank ?? r.rank) as string | null | undefined
          // Winnings: human=winnings, compact=won
          const winnings = (r.winnings ?? r.won ?? 0) as number
          console.log(
            formatSeatResultLine({
              seatId,
              isMe,
              cards: cards as never[],
              handRank,
              winnings,
            })
          )
          if (isMe && winnings > 0)
            console.log(`[${this.agentName}] Hand ${handNumber}: Won ${winnings}!`)
        }
        console.log('')
        break
      }

      case 'table_status': {
        // Some formats wrap status in payload, some are flat
        const tableStatus =
          (payload.payload && typeof payload.payload === 'object'
            ? (payload.payload as Record<string, unknown>)
            : payload) as Record<string, unknown>
        if (tableStatus.status === 'ended') {
          const rawReason = tableStatus.reason as string | undefined
          const reason = rawReason
            ? (TableEndReasonLabels[rawReason] ?? rawReason)
            : 'table ended'
          console.log(`\nTable status: ended (${reason})`)
        } else {
          console.log(
            `Table status: ${tableStatus.status} (${tableStatus.current_players}/${tableStatus.min_players_to_start} players)`
          )
          if (tableStatus.status === 'waiting') console.log('Waiting for more players to join...')
        }
        break
      }

      case 'player_joined': {
        const seatId = msgRecord.seatId ?? msgRecord.seat ?? payload.seatId ?? payload.seat
        const name = msgRecord.agentName || msgRecord.agentId || payload.agentName || payload.agentId || 'unknown'
        console.log(`Player joined: seat ${seatId} (${name})`)
        break
      }

      case 'player_left': {
        const seatId = msgRecord.seatId ?? msgRecord.seat ?? payload.seatId ?? payload.seat
        console.log(`Player left: seat ${seatId}`)
        break
      }
    }
  }

  /**
   * Handle an action being sent by the agent.
   */
  handleAction(action: { kind: string; amount?: number }): void {
    console.log(formatChosenAction(action))
  }

  /**
   * Handle a bootstrap event (registration, table join, etc.)
   */
  handleBootstrap(event: { type: string; data: Record<string, unknown> }): void {
    switch (event.type) {
      case 'register':
        console.log('Registering new agent...')
        if (event.data.agent_id) console.log(`Registered as ${event.data.agent_id}`)
        break
      case 'join':
        console.log('Auto-joining a table...')
        if (event.data.table_id) console.log(`Joined table ${event.data.table_id}`)
        if (event.data.seat_id !== undefined) {
          this.mySeatId = event.data.seat_id as number
          console.log(`Joined as seat ${event.data.seat_id}`)
        }
        break
    }
  }

  /**
   * Display agent reasoning or text output.
   */
  displayText(text: string): void {
    const preview = text.length > 300 ? text.slice(0, 300) + '...' : text
    console.log(`[${this.agentName}] ${preview}`)
  }
}
