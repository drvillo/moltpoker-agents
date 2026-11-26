import { isWaitingLobbyReason } from '@drvillo/moltpoker-shared'

/**
 * What the runner should do in response to a `table_status` payload.
 *
 * - `stay`  — the status is not terminal (waiting, running). Keep the
 *   current connection open and keep playing.
 * - `rejoin` — the server collected a waiting lobby (waiting_timeout or
 *   seats_stale). Tear down the current session, call auto-join again, and
 *   keep going. `nextRejoinCount` is the caller's updated counter to carry
 *   into the next invocation of this function.
 * - `shutdown` — the table ended in a terminal, non-recoverable way (game
 *   complete, abandoned, admin stopped, insufficient players), or the
 *   rejoin budget is exhausted. Caller cleans up and exits.
 */
export type RejoinAction = 'stay' | 'rejoin' | 'shutdown'

export interface RejoinDecision {
  action: RejoinAction
  /** Carried forward by the caller when action === 'rejoin'. */
  nextRejoinCount: number
  /** Short human-readable rationale, useful for logging. */
  reason: string
}

export interface DecideReconnectInput {
  status: string
  reason?: string | null | undefined
  /** How many waiting-lobby rejoins the caller has already attempted. */
  rejoinCount: number
  /** Hard cap. Default `MAX_WAITING_LOBBY_REJOINS`. */
  maxRejoins?: number
}

/** Default budget for automatic re-joins after waiting-lobby collection. */
export const MAX_WAITING_LOBBY_REJOINS = 3

/**
 * Pure, synchronous policy for `table_status` handlers in SDK / protocol /
 * autonomous runners. Does not touch the network; the caller carries out the
 * action it returns.
 */
export function decideReconnectAction(input: DecideReconnectInput): RejoinDecision {
  const max = input.maxRejoins ?? MAX_WAITING_LOBBY_REJOINS

  if (input.status !== 'ended') {
    return {
      action: 'stay',
      nextRejoinCount: input.rejoinCount,
      reason: `status=${input.status} — not terminal`,
    }
  }

  if (isWaitingLobbyReason(input.reason ?? undefined)) {
    if (input.rejoinCount >= max) {
      return {
        action: 'shutdown',
        nextRejoinCount: input.rejoinCount,
        reason: `reached max ${max} waiting-lobby rejoins`,
      }
    }
    return {
      action: 'rejoin',
      nextRejoinCount: input.rejoinCount + 1,
      reason: `waiting-lobby collected (${input.reason}); rejoin attempt ${input.rejoinCount + 1}/${max}`,
    }
  }

  return {
    action: 'shutdown',
    nextRejoinCount: input.rejoinCount,
    reason: `terminal end reason=${input.reason ?? 'unspecified'}`,
  }
}
