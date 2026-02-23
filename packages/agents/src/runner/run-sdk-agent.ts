import { join } from 'path'
import { MoltPokerClient, MoltPokerWsClient } from '@moltpoker/sdk'
import { TableEndReasonLabels, type GameStatePayload } from '@moltpoker/shared'

import { LlmAgent } from '../agents/llm.js'
import { createAgentPlan, createSdkAgentFromPlan } from '../factory/agent-factory.js'
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

  // Create HTTP client
  const client = new MoltPokerClient({ baseUrl: options.server })

  // Register or use existing API key
  let apiKey = options.apiKey
  if (!apiKey) {
    console.log('Registering new agent...')
    const registration = await client.register({
      name: plan.name,
    })
    apiKey = registration.api_key
    console.log(`Registered as ${registration.agent_id}`)
  } else {
    client.setApiKey(apiKey)
  }

  // Join table: use auto-join by default, or explicit table ID if specified
  let joinResponse
  let resolvedTableId: string

  if (options.tableId) {
    resolvedTableId = options.tableId
    console.log(`Joining specified table ${resolvedTableId}...`)
    joinResponse = await client.joinTable(resolvedTableId)
  } else {
    console.log('Auto-joining a table...')
    joinResponse = await client.autoJoin()
    resolvedTableId = joinResponse.table_id
  }
  console.log(`Joined table ${resolvedTableId} as seat ${joinResponse.seat_id}`)

  // Enable LLM logging if requested
  if ((options.llmLog || options.llmLogPath) && agent instanceof LlmAgent) {
    const logPath = options.llmLogPath ?? join(process.cwd(), 'logs', `llm-${resolvedTableId}.jsonl`)
    agent.enableLogging(logPath)
    console.log(`LLM logging enabled: ${logPath}`)
  }

  // Connect WebSocket
  console.log('Connecting WebSocket...')
  const ws = new MoltPokerWsClient({
    wsUrl: joinResponse.ws_url,
    sessionToken: joinResponse.session_token,
  })

  const MAX_ACTION_RETRIES = 2

  let currentState: GameStatePayload | null = null
  let mySeatId = joinResponse.seat_id
  let isShuttingDown = false
  let retryCount = 0
  let pendingRetryState: {
    state: GameStatePayload
    legalActions: NonNullable<GameStatePayload['legalActions']>
  } | null = null

  async function shutdown(reason: string): Promise<void> {
    if (isShuttingDown) return
    isShuttingDown = true
    console.log(`\nShutting down (${reason})...`)
    ws.disconnect()
    try {
      await client.leaveTable(resolvedTableId)
      console.log('Left table')
    } catch {
      // Ignore errors on shutdown
    }
    process.exit(0)
  }

  function safeSendAction(
    action: Parameters<MoltPokerWsClient['sendAction']>[0],
    expectedSeq?: number,
  ): void {
    if (isShuttingDown) return
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

  // Handle welcome
  ws.on('welcome', (payload) => {
    console.log(`Connected! Seat: ${payload.seat_id}, Timeout: ${payload.action_timeout_ms}ms`)
    mySeatId = payload.seat_id
  })

  // Retry-aware turn handler: gets an action from the agent and sends it
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
      // LLM call itself failed -- count as a retry attempt
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`[${agent.name}] Action call failed:`, errorMsg)

      retryCount++
      if (retryCount <= MAX_ACTION_RETRIES) {
        console.log(`Retrying action (attempt ${retryCount}/${MAX_ACTION_RETRIES})...`)
        await handleTurn(state, legalActions, `Agent call failed: ${errorMsg}`)
      } else {
        // Max retries exhausted -- let server timeout handle it (check/fold)
        console.error(
          `Max retries (${MAX_ACTION_RETRIES}) exhausted. Server timeout will apply default.`,
        )
        pendingRetryState = null
      }
    }
  }

  // Handle game state
  ws.on('game_state', async (state) => {
    currentState = state
    const totalPot = state.pots.reduce((sum, p) => sum + p.amount, 0)
    console.log(`\n${formatHandHeader({ handNumber: state.handNumber, phase: state.phase, totalPot })}`)
    console.log(formatCommunityLine(state.communityCards))

    // Log our cards
    const myPlayer = state.players.find((p) => p.seatId === mySeatId)
    if (myPlayer?.holeCards) {
      console.log(formatMyCardsLine({ cards: myPlayer.holeCards, seatId: mySeatId }))
      console.log(formatStackLine({ stack: myPlayer.stack, toCall: state.toCall ?? 0 }))
    }

    // Check if it's our turn
    if (state.currentSeat === mySeatId && state.legalActions && state.legalActions.length > 0) {
      console.log(formatLegalActionsLine(state.legalActions))
      retryCount = 0
      pendingRetryState = null
      await handleTurn(state, state.legalActions)
    }
  })

  // Handle ack
  ws.on('ack', (payload) => {
    console.log(`Action acknowledged (turn_token: ${payload.turn_token}, seq: ${payload.seq})`)
  })

  // Handle errors -- retry on INVALID_ACTION if retries remain
  ws.on('error', (error) => {
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

  // Handle hand complete
  ws.on('hand_complete', (payload) => {
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

  // Handle player events
  ws.on('player_joined', (payload) => {
    console.log(`Player joined: seat ${payload.seatId} (${payload.agentName || payload.agentId})`)
  })

  ws.on('player_left', (payload) => {
    console.log(`Player left: seat ${payload.seatId}`)
  })

  // Handle table status (waiting for game to start)
  ws.on('table_status', (payload) => {
    if (payload.status === 'ended') {
      const rawReason = payload.reason ?? ''
      const reason = TableEndReasonLabels[rawReason] ?? (rawReason || 'table ended')
      console.log(`Table status: ended (${reason})`)
      shutdown(reason).catch((err) => {
        console.error('Failed to shut down cleanly:', err)
        process.exit(1)
      })
      return
    }

    console.log(
      `Table status: ${payload.status} (${payload.current_players}/${payload.min_players_to_start} players)`,
    )
    if (payload.status === 'waiting') {
      console.log('Waiting for more players to join...')
    }
  })

  // Handle connection events
  ws.on('disconnected', (code, reason) => {
    console.log(`Disconnected: ${code} - ${reason}`)
    const normalizedReason = (reason ?? '').toLowerCase()
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

  ws.on('reconnecting', (attempt) => {
    console.log(`Reconnecting... attempt ${attempt}`)
  })

  // Connect
  await ws.connect()

  // Handle shutdown
  process.on('SIGINT', async () => {
    await shutdown('interrupt')
  })

  // Keep running
  console.log('Agent running. Press Ctrl+C to stop.')
}
