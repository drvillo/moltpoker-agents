import { describe, expect, it } from 'vitest'

import { isWaitingLobbyReason } from '@drvillo/moltpoker-shared'
import {
  decideReconnectAction,
  type RejoinDecision,
} from '../../src/runner/table-status-policy.js'

// Red test for the agent-side auto-rejoin policy that SDK/protocol/autonomous
// runners share. The policy answers a single question: given a `table_status`
// payload (and the current rejoin count), what should the agent do next?

describe('isWaitingLobbyReason (re-exported sanity)', () => {
  it('returns true for waiting_timeout and seats_stale', () => {
    expect(isWaitingLobbyReason('waiting_timeout')).toBe(true)
    expect(isWaitingLobbyReason('seats_stale')).toBe(true)
  })

  it('returns false for every other end reason', () => {
    expect(isWaitingLobbyReason('game_complete')).toBe(false)
    expect(isWaitingLobbyReason('abandoned')).toBe(false)
    expect(isWaitingLobbyReason('admin_stopped')).toBe(false)
    expect(isWaitingLobbyReason('insufficient_players')).toBe(false)
    expect(isWaitingLobbyReason(undefined)).toBe(false)
    expect(isWaitingLobbyReason(null)).toBe(false)
    expect(isWaitingLobbyReason('')).toBe(false)
  })
})

describe('decideReconnectAction', () => {
  it('returns "rejoin" with incremented attempt count on waiting_timeout', () => {
    const decision: RejoinDecision = decideReconnectAction({
      status: 'ended',
      reason: 'waiting_timeout',
      rejoinCount: 0,
      maxRejoins: 3,
    })
    expect(decision.action).toBe('rejoin')
    expect(decision.nextRejoinCount).toBe(1)
  })

  it('returns "rejoin" on seats_stale', () => {
    const decision = decideReconnectAction({
      status: 'ended',
      reason: 'seats_stale',
      rejoinCount: 1,
      maxRejoins: 3,
    })
    expect(decision.action).toBe('rejoin')
    expect(decision.nextRejoinCount).toBe(2)
  })

  it('returns "shutdown" when a non-waiting end reason arrives', () => {
    const decision = decideReconnectAction({
      status: 'ended',
      reason: 'game_complete',
      rejoinCount: 0,
      maxRejoins: 3,
    })
    expect(decision.action).toBe('shutdown')
  })

  it('returns "shutdown" after max rejoins reached', () => {
    const decision = decideReconnectAction({
      status: 'ended',
      reason: 'waiting_timeout',
      rejoinCount: 3,
      maxRejoins: 3,
    })
    expect(decision.action).toBe('shutdown')
    expect(decision.reason).toContain('max')
  })

  it('returns "stay" for non-ended statuses', () => {
    const decision = decideReconnectAction({
      status: 'waiting',
      reason: undefined,
      rejoinCount: 0,
      maxRejoins: 3,
    })
    expect(decision.action).toBe('stay')
  })

  it('returns "stay" when status is "running"', () => {
    const decision = decideReconnectAction({
      status: 'running',
      reason: undefined,
      rejoinCount: 0,
      maxRejoins: 3,
    })
    expect(decision.action).toBe('stay')
  })
})
