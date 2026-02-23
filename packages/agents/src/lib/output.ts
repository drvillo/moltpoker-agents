import { cardToString } from '@moltpoker/poker'
import type { Card, LegalAction } from '@moltpoker/shared'

// ─── Card Formatting ─────────────────────────────────────────────────────────

/** Format an array of cards into a space-separated string, or a fallback. */
export function formatCards(cards: Card[], fallback = 'none'): string {
  if (cards.length === 0) return fallback
  return cards.map(cardToString).join(' ')
}

// ─── Game-State Lines ────────────────────────────────────────────────────────

export function formatHandHeader({ handNumber, phase, totalPot }: {
  handNumber: number
  phase: string
  totalPot: number
}): string {
  return `Hand #${handNumber} | Phase: ${phase} | Pot: ${totalPot}`
}

export function formatCommunityLine(cards: Card[]): string {
  return `Community: ${formatCards(cards)}`
}

export function formatMyCardsLine({ cards, seatId }: {
  cards: Card[]
  seatId: number
}): string {
  return `Your cards: ${formatCards(cards, 'unknown')} (Seat ${seatId})`
}

export function formatStackLine({ stack, toCall }: {
  stack: number
  toCall: number
}): string {
  return `Your stack: ${stack} | To call: ${toCall}`
}

export function formatLegalActionsLine(actions: LegalAction[]): string {
  const parts = actions.map((a) => {
    if (a.minAmount !== undefined && a.maxAmount !== undefined)
      return `${a.kind} (min: ${a.minAmount}, max: ${a.maxAmount})`
    return a.kind
  })
  return `Legal actions: ${parts.join(', ')}`
}

export function formatChosenAction(action: { kind: string; amount?: number }): string {
  return `Action: ${action.kind}${action.amount ? ` ${action.amount}` : ''}`
}

// ─── Player Lines ────────────────────────────────────────────────────────────

export function formatPlayerLine({ seatId, stack, bet, folded, allIn, isMe }: {
  seatId: number
  stack: number
  bet: number
  folded: boolean
  allIn: boolean
  isMe: boolean
}): string {
  const marker = isMe ? ' (YOU)' : ''
  const status = folded ? 'folded' : allIn ? 'all-in' : 'active'
  return `  Seat ${seatId}${marker}: stack ${stack}, bet ${bet}, ${status}`
}

// ─── Hand-Complete Lines ─────────────────────────────────────────────────────

export function formatHandCompleteHeader(handNumber: number): string {
  return `=== Hand ${handNumber} Complete ===`
}

export function formatSeatResultLine({ seatId, isMe, cards, handRank, winnings }: {
  seatId: number
  isMe: boolean
  cards: Card[]
  handRank: string | null | undefined
  winnings: number
}): string {
  const marker = isMe ? ' (ME)' : ''
  return `Seat ${seatId}${marker}: ${formatCards(cards)} - ${handRank || 'n/a'} - Won: ${winnings}`
}

// ─── Agent Logging Helpers ───────────────────────────────────────────────────

export function logAgentHandComplete(agentName: string, handNumber: number, winnings: number): void {
  if (winnings > 0) {
    console.log(`[${agentName}] Hand ${handNumber}: Won ${winnings}!`)
  }
}

export function logAgentError(agentName: string, error: { code: string; message: string }): void {
  console.error(`[${agentName}] Error: ${error.code} - ${error.message}`)
}
