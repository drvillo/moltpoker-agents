/**
 * ProtocolAgent — domain-agnostic agent that interprets a skill.md YAML contract.
 *
 * Fetches a skill document at runtime, parses its YAML frontmatter as a
 * protocol program, and walks the tree using the protocol engine. The only
 * domain knowledge lives in the skill document itself.
 *
 * @module agents/protocol
 */

import matter from 'gray-matter'
import type { LanguageModel } from 'ai'

import { createJsonlLogger } from '../lib/logger.js'
import { LlmAgentBase } from './base.js'
import {
  type EngineContext,
  type ProtocolDecision,
  buildZodSchema,
  computeSafetyAction,
  createEngineContext,
  evaluateWhen,
  extractAll,
  httpRequest,
  initStateReducer,
  interpolate,
  llmDecide,
  matchMessage,
  reduceState,
  wsSend,
} from '../engine/protocol-engine.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProtocolAgentConfig {
  model: LanguageModel
  temperature?: number
  logPath?: string
  onStep?: (event: unknown) => void
}

export interface ProtocolRunOptions {
  tableId?: string
}

export function buildDefaultFallbackDecision(): ProtocolDecision {
  return {
    kind: 'fold',
    amount: null,
    reasoning: 'default fallback after llm failure',
  }
}

// ─── ProtocolAgent ───────────────────────────────────────────────────────────

export class ProtocolAgent extends LlmAgentBase {
  private engine: EngineContext

  constructor(config: ProtocolAgentConfig) {
    const modelId = (config.model as { modelId?: string }).modelId ?? 'unknown'
    super({
      name: `ProtocolAgent (${modelId})`,
      agentType: 'protocol',
      model: config.model,
      temperature: config.temperature,
    })
    const logFn = createJsonlLogger(config.logPath)

    this.engine = createEngineContext({
      model: this.model,
      log: logFn,
      onStep: config.onStep,
    })
  }

  /** Signal the agent to stop after the current iteration. */
  stop(): void {
    this.engine.stopped = true
    if (this.engine.ws && this.engine.ws.readyState === WebSocket.OPEN) {
      this.engine.ws.close()
    }
  }

  /**
   * Main entry point. Fetches the skill document, parses it, and executes
   * the protocol described in the YAML frontmatter.
   */
  async run(skillUrl: string, agentName: string, options: ProtocolRunOptions = {}): Promise<void> {
    const ctx = this.engine

    // Store agent name as a variable for interpolation
    ctx.vars.set('AGENT_NAME', agentName)

    // ── 1. Fetch and parse skill document ──────────────────────────────
    ctx.log({ phase: 'fetch_skill', url: skillUrl })
    const response = await fetch(skillUrl)
    if (!response.ok)
      throw new Error(`Failed to fetch skill document: HTTP ${response.status} from ${skillUrl}`)

    const raw = await response.text()
    const { data, content } = matter(raw) as { data: Record<string, unknown>; content: string }

    // Prose becomes the LLM system prompt
    ctx.prose = content.trim()

    const protocol = data.protocol as Record<string, unknown> | undefined
    if (!protocol)
      throw new Error('Skill document has no `protocol` block in frontmatter')

    ctx.log({ phase: 'parsed_skill', protocolVersion: protocol.version })

    // ── 2. Bootstrap: execute HTTP steps ───────────────────────────────
    const bootstrap = protocol.bootstrap as Array<Record<string, unknown>> | undefined
    if (bootstrap) {
      const normalizedBootstrap = bootstrap.map((step) => {
        if (!options.tableId) return step
        if (step.id !== 'join') return step
        const rawUrl = String(step.url ?? '')
        if (!rawUrl.includes('/v1/tables/auto-join')) return step
        return {
          ...step,
          url: rawUrl.replace('/v1/tables/auto-join', `/v1/tables/${options.tableId}/join`),
        }
      })
      for (const step of normalizedBootstrap) {
        if (ctx.stopped) return
        ctx.log({ phase: 'bootstrap', stepId: step.id })

        const result = await httpRequest(step, ctx)

        // Emit step event for display formatter
        ctx.onStep?.({
          type: 'bootstrap',
          stepId: step.id,
          method: step.method,
          url: interpolate(step.url, ctx.vars),
          result,
        })
      }
    }

    // ── 3. Build decision schema from JSON Schema ──────────────────────
    const decision = protocol.decision as Record<string, unknown> | undefined
    if (decision?.schema) {
      const decisionSchema = structuredClone(decision.schema as Record<string, unknown>)
      const decisionProperties = Object.keys((decisionSchema.properties ?? {}) as Record<string, unknown>)

      // Providers used by generateObject response_format require every property key
      // to be included in `required`; nullable fields should use type: ["X","null"].
      const requiredSet = new Set((decisionSchema.required ?? []) as string[])
      for (const key of decisionProperties) requiredSet.add(key)
      decisionSchema.required = [...requiredSet]

      ctx.decisionSchema = buildZodSchema(decisionSchema)
      ctx.log({ phase: 'schema_built' })
    }

    // ── 4. Initialize state reducer ────────────────────────────────────
    const stateConfig = protocol.state as Record<string, unknown> | undefined
    if (stateConfig) {
      ctx.stateReducer = initStateReducer(stateConfig)
      ctx.log({ phase: 'state_reducer_initialized' })
    }

    // ── 5. WebSocket: connect and enter message loop ───────────────────
    const wsConfig = protocol.websocket as Record<string, unknown> | undefined
    if (!wsConfig) {
      ctx.log({ phase: 'no_websocket', note: 'protocol has no websocket block, done.' })
      return
    }

    const wsUrl = interpolate(wsConfig.url, ctx.vars) as string
    ctx.log({ phase: 'ws_connect', url: wsUrl })

    const onMessageRules = (wsConfig.on_message ?? []) as Array<Record<string, unknown>>
    const actionTemplate = decision?.action_template
    const safetyConfig = decision?.safety as Record<string, unknown> | undefined

    // Connect WebSocket
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl)

      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('WebSocket connection timed out after 30s'))
      }, 30_000)

      ws.addEventListener('open', () => {
        clearTimeout(timeout)
        ctx.ws = ws
        ctx.log({ phase: 'ws_connected' })
        resolve()
      })

      ws.addEventListener('error', (event) => {
        clearTimeout(timeout)
        if (!ctx.ws) reject(new Error(`WebSocket connection failed: ${String(event)}`))
      })
    })

    // ── 6. Message loop ────────────────────────────────────────────────
    const messageLoop = new Promise<void>((resolve) => {
      const ws = ctx.ws!

      ws.addEventListener('message', async (event) => {
        if (ctx.stopped) return

        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(
            typeof event.data === 'string' ? event.data : String(event.data),
          ) as Record<string, unknown>
        } catch {
          ctx.log({ handler: 'ws_message', error: 'failed to parse message' })
          return
        }
        // ── State reducer: runs on EVERY message ───────────────────
        if (ctx.stateReducer) reduceState(msg, ctx.stateReducer, ctx.vars)

        // ── Route: first-match-wins ────────────────────────────────
        for (const rule of onMessageRules) {
          const matchObj = rule.match as Record<string, unknown>
          if (!matchMessage(matchObj, msg)) continue

          // Check `when` conditions if present
          const when = rule.when as Array<Record<string, unknown>> | undefined
          if (when && !evaluateWhen(when, msg, ctx.vars)) continue

          // Extract fields if configured
          if (rule.extract && typeof rule.extract === 'object')
            extractAll(msg, rule.extract as Record<string, string>, ctx.vars)

          const msgClass = rule.class as string

          // Dispatch by class
          switch (msgClass) {
            case 'setup':
              ctx.log({ handler: 'dispatch', class: 'setup', type: msg.type })
              ctx.onStep?.({ type: 'ws_message', class: 'setup', message: msg })
              break

            case 'actionable':
              ctx.log({ handler: 'dispatch', class: 'actionable', type: msg.type })
              ctx.onStep?.({ type: 'ws_message', class: 'actionable', message: msg })
              let decisionResult: ProtocolDecision
              try {
                decisionResult = await llmDecide(msg, ctx)
              } catch (err) {
                ctx.log({
                  handler: 'llm_decide_error',
                  error: err instanceof Error ? err.message : String(err),
                })
                // Apply safety default if LLM fails
                if (safetyConfig) {
                  decisionResult = computeSafetyAction(safetyConfig, msg)
                  ctx.log({ handler: 'safety_default', kind: decisionResult.kind })
                }
                else decisionResult = buildDefaultFallbackDecision()
              }
              // Send the action
              if (actionTemplate) {
                const actionVars = new Map(ctx.vars)
                actionVars.set('kind', decisionResult.kind)
                actionVars.set('amount', decisionResult.amount)
                actionVars.set('reasoning', decisionResult.reasoning)
                wsSend(actionTemplate, ctx, actionVars)
              }
              break

            case 'informational':
              ctx.log({ handler: 'dispatch', class: 'informational', type: msg.type })
              ctx.onStep?.({ type: 'ws_message', class: 'informational', message: msg })
              break

            case 'terminal':
              ctx.log({ handler: 'dispatch', class: 'terminal', type: msg.type })
              ctx.onStep?.({ type: 'ws_message', class: 'terminal', message: msg })
              ctx.stopped = true
              ws.close()
              resolve()
              return

            case 'error': {
              ctx.log({ handler: 'dispatch', class: 'error', type: msg.type, code: msg.code })
              ctx.onStep?.({ type: 'ws_message', class: 'error', message: msg })
              const retryCodes = (rule.retry_codes ?? []) as string[]
              if (retryCodes.includes(msg.code as string)) {
                ctx.log({ handler: 'error_retry', code: msg.code })
                // Don't act — wait for the next game_state to trigger a new decision
              }
              break
            }
          }

          // First match wins — break rule loop
          break
        }
      })

      ws.addEventListener('close', () => {
        ctx.log({ phase: 'ws_closed' })
        resolve()
      })
    })

    await messageLoop
    ctx.log({ phase: 'run_complete' })
  }
}
