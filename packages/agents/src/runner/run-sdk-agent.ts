import { join } from 'path'
import { MoltPokerClient, MoltPokerWsClient } from '@drvillo/moltpoker-sdk'
import {
  TableEndReasonLabels,
  isWaitingLobbyReason,
  type GameStatePayload,
} from '@drvillo/moltpoker-shared'

import { LlmAgent } from '../agents/llm.js'
import { createAgentPlan, createSdkAgentFromPlan } from '../factory/agent-factory.js'
import { buildSimulationMetadata } from '../lib/sim-metadata.js'
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
import {
  decideReconnectAction,
  MAX_WAITING_LOBBY_REJOINS,
} from './table-status-policy.js'

/**
 * Run an SDK-based agent (random, tight, callstation, llm).
 */
export async function runSdkAgent(options: {
  type: string
  server: string
  tableId?: string
  name?: string
  apiKey?: string
  model?: string
  skillDoc?: string
  llmLog?: boolean
  llmLogPath?: string
}): Promise<void> {
  const plan = createAgentPlan({
    type: options.type,
    name: options.name,
    model: options.model,
    skillDocPath: options.skillDoc,
    llmLogPath: options.llmLogPath,
  })
  const agent = await createSdkAgentFromPlan(plan)
  console.log(`Starting ${agent.name}...`)

  const client = new MoltPokerClient({ baseUrl: options.server })

  // Register or reuse an existing API key. When started by the simulator,
  // attach molt_simulation / molt_agent_type / molt_model metadata so admin
  // surfaces can resolve per-model stats without parsing display names.
  let apiKey = options.apiKey
  if (!apiKey) {
    console.log('Registering new agent...')
    const metadata = buildSimulationMetadata({
      type: plan.type,
      model: plan.model,
      env: process.env,
    })
    const registration = await client.register({
      name: plan.name,
      ...(metadata ? { metadata } : {}),
    })
    apiKey = registration.api_key
    console.log(`Registered as ${registration.agent_id}`)
  } else {
    client.setApiKey(apiKey)
  }

  const MAX_ACTION_RETRIES = 2
  let currentState: GameStatePayload | null = null
  let mySeatId = -1
  let isShuttingDown = false
  let retryCount = 0
  let pendingRetryState: {
    state: GameStatePayload
    legalActions: NonNullable<GameStatePayload['legalActions']>
  } | null = null
  let rejoinCount = 0
  let resolvedTableId = ''
  let ws: MoltPokerWsClient | null = null

  async function joinOnce(): Promise<void> {
    const joinResponse = options.tableId
      ? await (async () => {
          resolvedTableId = options.tableId!
          console.log(`Joining specified table ${resolvedTableId}...`)
          return client.joinTable(resolvedTableId)
        })()
      : await (async () => {
          console.log('Auto-joining a table...')
          const r = await client.autoJoin()
          resolvedTableId = r.table_id
          return r
        })()

    console.log(`Joined table ${resolvedTableId} as seat ${joinResponse.seat_id}`)
    mySeatId = joinResponse.seat_id

    if ((options.llmLog || options.llmLogPath) && agent instanceof LlmAgent) {
      const logPath =
        options.llmLogPath ?? join(process.cwd(), 'logs', `llm-${resolvedTableId}.jsonl`)
      agent.enableLogging(logPath)
      console.log(`LLM logging enabled: ${logPath}`)
    }

    console.log('Connecting WebSocket...')
    ws = new MoltPokerWsClient({
      wsUrl: joinResponse.ws_url,
      sessionToken: joinResponse.session_token,
    })
    attachHandlers(ws)
    await ws.connect()
  }

  async function shutdown(reason: string): Promise<void> {
    if (isShuttingDown) return
    isShuttingDown = true
    console.log(`\nShutting down (${reason})...`)
    ws?.disconnect()
    if (resolvedTableId) {
      try {
        await client.leaveTable(resolvedTableId)
        console.log('Left table')
      } catch {
        // Ignore errors on shutdown
      }
    }
    process.exit(0)
  }

  async function rejoinWaitingLobby(reason: string): Promise<void> {
    try {
      console.log(`Waiting lobby collected (${reason}); retrying auto-join...`)
      ws?.disconnect()
      ws = null
      await joinOnce()
    } catch (err) {
      console.error('Rejoin failed:', err)
      await shutdown(`rejoin_failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function safeSendAction(
    action: Parameters<MoltPokerWsClient['sendAction']>[0],
    expectedSeq?: number,
  ): void {
    if (isShuttingDown || !ws) return
    if (!ws.isConnected()) {
      console.warn('Skipping action: WebSocket is disconnected')
      return
    }
    try {
      ws.sendAction(action, expectedSeq)
    } catch (err) {
      console.error('Failed to send action:', err)
    }
  }

  async function handleTurn(
    state: GameStatePayload,
    legalActions: NonNullable<GameStatePayload['legalActions']>,
    previousError?: string,
  ): Promise<void> {
    try {
      const action = await agent.getAction(state, legalActions, previousError)
      console.log(formatChosenAction(action))
      pendingRetryState = { state, legalActions }
      safeSendAction(action, state.seq)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`[${agent.name}] Action call failed:`, errorMsg)
      retryCount++
      if (retryCount <= MAX_ACTION_RETRIES) {
        console.log(`Retrying action (attempt ${retryCount}/${MAX_ACTION_RETRIES})...`)
        await handleTurn(state, legalActions, `Agent call failed: ${errorMsg}`)
      } else {
        console.error(
          `Max retries (${MAX_ACTION_RETRIES}) exhausted. Server timeout will apply default.`,
        )
        pendingRetryState = null
      }
    }
  }

  function attachHandlers(client: MoltPokerWsClient): void {
    client.on('welcome', (payload) => {
      console.log(`Connected! Seat: ${payload.seat_id}, Timeout: ${payload.action_timeout_ms}ms`)
      mySeatId = payload.seat_id
    })

    client.on('game_state', async (state) => {
      currentState = state
      const totalPot = state.pots.reduce((sum, p) => sum + p.amount, 0)
      console.log(`\n${formatHandHeader({ handNumber: state.handNumber, phase: state.phase, totalPot })}`)
      console.log(formatCommunityLine(state.communityCards))

      const myPlayer = state.players.find((p) => p.seatId === mySeatId)
      if (myPlayer?.holeCards) {
        console.log(formatMyCardsLine({ cards: myPlayer.holeCards, seatId: mySeatId }))
        console.log(formatStackLine({ stack: myPlayer.stack, toCall: state.toCall ?? 0 }))
      }

      if (state.currentSeat === mySeatId && state.legalActions && state.legalActions.length > 0) {
        console.log(formatLegalActionsLine(state.legalActions))
        retryCount = 0
        pendingRetryState = null
        await handleTurn(state, state.legalActions)
      }
    })

    client.on('ack', (payload) => {
      console.log(`Action acknowledged (turn_token: ${payload.turn_token}, seq: ${payload.seq})`)
    })

    client.on('error', (error) => {
      console.error(`Error: ${error.code} - ${error.message}`)
      agent.onError?.(error)

      if (error.code === 'INVALID_ACTION' && pendingRetryState && retryCount < MAX_ACTION_RETRIES) {
        retryCount++
        console.log(`Retrying action (attempt ${retryCount}/${MAX_ACTION_RETRIES})...`)
        const { state, legalActions } = pendingRetryState
        handleTurn(state, legalActions, error.message).catch((err) => {
          console.error('Retry failed:', err)
        })
      } else if (error.code === 'INVALID_ACTION' && retryCount >= MAX_ACTION_RETRIES) {
        pendingRetryState = null
        console.error(
          `Max retries (${MAX_ACTION_RETRIES}) exhausted. Server timeout will apply default.`,
        )
      }
    })

    client.on('hand_complete', (payload) => {
      console.log(`\n${formatHandCompleteHeader(payload.handNumber)}`)
      for (const result of payload.results) {
        const isMe =
          currentState?.players.find((p) => p.seatId === result.seatId)?.seatId === mySeatId
        console.log(
          formatSeatResultLine({
            seatId: result.seatId,
            isMe: isMe ?? false,
            cards: result.holeCards,
            handRank: result.handRank,
            winnings: result.winnings,
          }),
        )

        if (isMe) {
          agent.onHandComplete?.(payload.handNumber, result.winnings)
        }
      }
      console.log('')
    })

    client.on('player_joined', (payload) => {
      console.log(`Player joined: seat ${payload.seatId} (${payload.agentName || payload.agentId})`)
    })

    client.on('player_left', (payload) => {
      console.log(`Player left: seat ${payload.seatId}`)
    })

    client.on('table_status', (payload) => {
      const endedReason = payload.status === 'ended' ? (payload.reason ?? null) : null
      const decision = decideReconnectAction({
        status: payload.status,
        reason: endedReason,
        rejoinCount,
        maxRejoins: MAX_WAITING_LOBBY_REJOINS,
      })

      if (payload.status === 'ended') {
        const rawReason = payload.reason ?? ''
        const reasonLabel = TableEndReasonLabels[rawReason] ?? (rawReason || 'table ended')
        console.log(`Table status: ended (${reasonLabel})`)
      } else {
        console.log(
          `Table status: ${payload.status} (${payload.current_players}/${payload.min_players_to_start} players)`,
        )
        if (payload.status === 'waiting') {
          console.log('Waiting for more players to join...')
        }
      }

      if (decision.action === 'rejoin') {
        rejoinCount = decision.nextRejoinCount
        rejoinWaitingLobby(endedReason ?? 'waiting_lobby_collected').catch((err) => {
          console.error('Rejoin threw:', err)
        })
      } else if (decision.action === 'shutdown') {
        shutdown(decision.reason).catch((err) => {
          console.error('Failed to shut down cleanly:', err)
          process.exit(1)
        })
      }
    })

    client.on('disconnected', (code, reason) => {
      console.log(`Disconnected: ${code} - ${reason}`)
      const normalizedReason = (reason ?? '').toLowerCase()
      const looksLikeWaitingLobby =
        isWaitingLobbyReason(reason ?? undefined) ||
        normalizedReason.includes('waiting_timeout') ||
        normalizedReason.includes('seats_stale')
      if (!isShuttingDown && looksLikeWaitingLobby && rejoinCount < MAX_WAITING_LOBBY_REJOINS) {
        // The table_status handler already set this in motion; a defensive
        // retry here keeps the agent alive if the close() raced the message.
        rejoinCount++
        rejoinWaitingLobby(reason ?? 'disconnect_waiting_lobby').catch((err) => {
          console.error('Rejoin threw:', err)
        })
        return
      }
      if (
        !isShuttingDown &&
        (normalizedReason.includes('table ended') || normalizedReason.includes('kicked'))
      ) {
        shutdown(reason ?? 'disconnected').catch((err) => {
          console.error('Failed to shut down cleanly:', err)
          process.exit(1)
        })
      }
    })

    client.on('reconnecting', (attempt) => {
      console.log(`Reconnecting... attempt ${attempt}`)
    })
  }

  await joinOnce()

  process.on('SIGINT', async () => {
    await shutdown('interrupt')
  })

  console.log('Agent running. Press Ctrl+C to stop.')
}
