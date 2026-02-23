import { join } from 'path'

import { ProtocolAgent } from '../agents/protocol.js'
import { PokerWsDisplay } from '../display/poker-display.js'
import { createAgentPlan } from '../factory/agent-factory.js'
import { resolveModel } from '../lib/model-resolver.js'

/**
 * Run a protocol agent (YAML-contract-driven, domain-agnostic).
 */
export async function runProtocolAgent(options: {
  server: string
  tableId?: string
  name?: string
  model?: string
  skillUrl?: string
  llmLog?: boolean
  llmLogPath?: string
}): Promise<void> {
  const plan = createAgentPlan({
    type: 'protocol',
    name: options.name,
    model: options.model,
    skillUrl: options.skillUrl,
    llmLogPath: options.llmLogPath,
  })

  const model = await resolveModel(plan.model!)

  const logPath = plan.llmLogPath
    ?? (options.llmLog
      ? join(process.cwd(), 'logs', `protocol-${Date.now()}.jsonl`)
      : undefined)

  const displayName = plan.name
  const display = new PokerWsDisplay(displayName)

  // Adapter: extract messages from protocol step events and route to display
  const onStep = (step: unknown) => {
    const event = step as Record<string, unknown>
    if (event.type !== 'ws_message') {
      // Bootstrap events
      if (event.type === 'bootstrap') {
        const id = event.stepId as string
        const result = event.result as Record<string, unknown> | null
        if (id === 'register') {
          display.handleBootstrap({ type: 'register', data: result ?? {} })
        } else if (id === 'join') {
          display.handleBootstrap({ type: 'join', data: result ?? {} })
        }
      }
      return
    }

    const msg = event.message as Record<string, unknown>
    if (!msg) return
    display.handleMessage(msg)
  }

  const agent = new ProtocolAgent({
    model,
    temperature: 0.3,
    logPath,
    onStep,
  })

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nStopping protocol agent...')
    agent.stop()
  })

  console.log(`Starting ${displayName}...`)
  if (logPath) console.log(`LLM logging enabled: ${logPath}`)
  console.log('Agent running. Press Ctrl+C to stop.')
  await agent.run(plan.skillUrl!, displayName, { tableId: options.tableId })
}
