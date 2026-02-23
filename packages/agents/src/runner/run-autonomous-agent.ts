import { join } from 'path'

import { AutonomousAgent, type StepEvent } from '../agents/autonomous.js'
import { PokerWsDisplay } from '../display/poker-display.js'
import { safeParseJson } from '../display/normalizers.js'
import { createAgentPlan } from '../factory/agent-factory.js'
import { resolveModel } from '../lib/model-resolver.js'

/**
 * Run an autonomous agent (domain-agnostic, discovers APIs at runtime).
 */
export async function runAutonomousAgent(options: {
  server: string
  tableId?: string
  name?: string
  model?: string
  skillUrl?: string
  skillDoc?: string
  llmLog?: boolean
  llmLogPath?: string
}): Promise<void> {
  const plan = createAgentPlan({
    type: 'autonomous',
    name: options.name,
    model: options.model,
    skillUrl: options.skillUrl,
    llmLogPath: options.llmLogPath,
  })

  const model = await resolveModel(plan.model!)

  const logPath = plan.llmLogPath
    ?? (options.llmLog
      ? join(process.cwd(), 'logs', `autonomous-${Date.now()}.jsonl`)
      : undefined)

  const displayName = plan.name
  const display = new PokerWsDisplay(displayName)

  // Adapter: extract messages from StepEvent and route to display
  const onStep = (step: StepEvent) => {
    for (const t of step.tools) {
      switch (t.toolName) {
        case 'fetch_document':
          // Silent – the skill doc fetch is an internal bootstrap step
          break

        case 'http_request': {
          const input = t.input as Record<string, unknown> | null
          const output = t.output as Record<string, unknown> | null
          const body = safeParseJson(output?.body)

          if (
            input?.method === 'POST' &&
            typeof input.url === 'string' &&
            input.url.endsWith('/v1/agents')
          ) {
            display.handleBootstrap({ type: 'register', data: body ?? {} })
          } else if (
            input?.method === 'GET' &&
            typeof input.url === 'string' &&
            input.url.endsWith('/v1/tables')
          ) {
            console.log('Looking for available table...')
            const tables = (body?.tables ?? []) as Array<Record<string, unknown>>
            const table = tables.find(
              (tb) => tb.status === 'waiting' && (tb.availableSeats as number) > 0
            )
            if (table) console.log(`Found table ${table.id}`)
          } else if (
            input?.method === 'POST' &&
            typeof input.url === 'string' &&
            input.url.includes('/auto-join')
          ) {
            display.handleBootstrap({ type: 'join', data: body ?? {} })
          } else if (
            input?.method === 'POST' &&
            typeof input.url === 'string' &&
            input.url.includes('/join')
          ) {
            // Extract table ID from URL
            const tableMatch = (input.url as string).match(/tables\/([^/]+)\/join/)
            const tableId = tableMatch?.[1] ?? 'unknown'
            console.log(`Joining table ${tableId}...`)
            display.handleBootstrap({ type: 'join', data: body ?? {} })
          }
          break
        }

        case 'websocket_connect': {
          const output = t.output as Record<string, unknown> | null
          if (output?.connectionId) console.log('Connecting WebSocket...')
          break
        }

        case 'websocket_read': {
          const output = t.output as Record<string, unknown> | null
          const msgs = (output?.messages ?? []) as Array<Record<string, unknown>>
          for (const msg of msgs) display.handleMessage(msg)
          if (output?.connectionClosed) console.log('WebSocket connection closed.')
          break
        }

        case 'websocket_send': {
          const input = t.input as Record<string, unknown> | null
          const parsed = safeParseJson(input?.message)
          if (parsed?.type === 'action' && parsed.action)
            display.handleAction(parsed.action as { kind: string; amount?: number })
          break
        }

        // generate_uuid: silent
      }
    }

    // Show agent text output (conclusions, end-of-game messages)
    if (step.text) {
      display.displayText(step.text)
    }
  }

  // Create the actual agent with the onStep callback
  const agent = new AutonomousAgent({ model, temperature: 0.3, logPath, onStep })

  const joinInstruction = options.tableId
    ? `join the specific table ${options.tableId} using POST ${options.server}/v1/tables/${options.tableId}/join (do not use auto-join), and play.`
    : 'use the auto-join endpoint to join a game, and play.'
  const task =
    `First, fetch the skill document from ${plan.skillUrl} using fetch_document with documentRole: "skill" to learn how to interact with this platform. ` +
    `The server base URL is ${options.server}. ` +
    `After reading the skill document, register as an agent named "${displayName}", ` +
    `${joinInstruction} Continue playing until the table ends or you are told to stop.`

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nStopping autonomous agent...')
    agent.stop()
  })

  console.log(`Starting ${displayName}...`)
  if (logPath) console.log(`LLM logging enabled: ${logPath}`)
  console.log('Agent running. Press Ctrl+C to stop.')
  await agent.run(task)
}
