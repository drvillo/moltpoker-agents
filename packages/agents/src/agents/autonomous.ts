import { generateText, tool, stepCountIs } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'
import { z } from 'zod'

import { createJsonlLogger } from '../lib/logger.js'
import { LlmAgentBase } from './base.js'

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single tool invocation with matched input and output. */
export interface ToolStep {
  toolName: string
  input: unknown
  output: unknown
}

/** Payload delivered to the onStep callback after each LLM step completes. */
export interface StepEvent {
  tools: ToolStep[]
  text: string | null
  usage: unknown
  iteration: number
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface AutonomousAgentConfig {
  /** AI SDK language model instance (e.g. openai('gpt-4.1'), anthropic('claude-sonnet-4-5')) */
  model: LanguageModel
  /** Temperature for LLM sampling (default 0.3) */
  temperature?: number
  /** Optional JSONL log file path for prompt/response logging */
  logPath?: string
  /** Maximum outer-loop iterations before the agent stops (default 2000) */
  maxIterations?: number
  /**
   * Optional step callback. Fires after each LLM step with paired tool
   * call/result data. When provided, the agent suppresses its default
   * console logging of tool calls and reasoning text, delegating all
   * display to the caller.
   */
  onStep?: (step: StepEvent) => void
}

// ─── System Prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an autonomous AI agent. You have generic tools to fetch web documents, make HTTP requests, manage WebSocket connections, and generate UUIDs.

Your task is given to you as a user message. Follow it precisely.

## Workflow

1. Start by fetching any referenced URLs to understand the system you are interacting with. Read the documentation carefully and completely.
2. Use that documentation to determine the correct API calls, message formats, and interaction patterns.
3. Execute the required API calls step by step, using the exact formats described in the documentation.

## WebSocket Interactions

- After connecting to a WebSocket, use websocket_read to wait for incoming messages.
- Process each message according to the documentation.
- When a message indicates it is your turn to act, decide on an action and send it via websocket_send using the exact JSON format from the documentation.
- Always include required fields as described in the documentation (e.g. turn_token, expected_seq). Use generate_uuid only if the documentation explicitly requires a client-generated UUID.
- Continue the read-process-send loop until the connection closes or you are instructed to stop.

## Decision Making

- When making decisions, reason carefully about the situation before acting.
- When uncertain, prefer safe/conservative actions as described in the documentation.
- Always handle errors gracefully — if an action is rejected, read the error, adjust, and retry.

## Important Rules

- Do NOT assume knowledge about the systems you interact with — rely solely on fetched documentation.
- Always use the exact message formats and field names specified in the documentation.
- Keep your reasoning concise to save context space.`

// ─── WebSocket Manager ───────────────────────────────────────────────────────

interface BufferedMessage {
  connectionId: string
  data: unknown
  receivedAt: number
}

class WebSocketManager {
  private connections = new Map<string, WebSocket>()
  private buffers = new Map<string, BufferedMessage[]>()
  private closedConnections = new Set<string>()

  /** Open a new WebSocket connection and start buffering messages. */
  async connect(url: string): Promise<{ connectionId: string }> {
    const connectionId = crypto.randomUUID()

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)

      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('WebSocket connection timed out after 30s'))
      }, 30_000)

      ws.addEventListener('open', () => {
        clearTimeout(timeout)
        this.connections.set(connectionId, ws)
        this.buffers.set(connectionId, [])
        resolve({ connectionId })
      })

      ws.addEventListener('message', (event) => {
        const buffer = this.buffers.get(connectionId)
        if (!buffer) return
        let data: unknown
        try {
          data = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
        } catch {
          data = typeof event.data === 'string' ? event.data : String(event.data)
        }
        buffer.push({ connectionId, data, receivedAt: Date.now() })
      })

      ws.addEventListener('close', () => {
        this.closedConnections.add(connectionId)
        this.connections.delete(connectionId)
      })

      ws.addEventListener('error', (event) => {
        clearTimeout(timeout)
        if (!this.connections.has(connectionId)) {
          reject(new Error(`WebSocket connection failed: ${String(event)}`))
        }
      })
    })
  }

  /** Send a message on an existing connection. */
  send(connectionId: string, message: string): { success: boolean; error?: string } {
    const ws = this.connections.get(connectionId)
    if (!ws) {
      if (this.closedConnections.has(connectionId))
        return { success: false, error: 'Connection is closed' }
      return { success: false, error: 'Connection not found' }
    }
    if (ws.readyState !== WebSocket.OPEN)
      return { success: false, error: `WebSocket is not open (state: ${ws.readyState})` }
    ws.send(message)
    return { success: true }
  }

  /** Drain buffered messages, optionally waiting up to waitMs for at least one. */
  async read(connectionId: string, waitMs = 30_000): Promise<{ messages: unknown[]; connectionClosed: boolean }> {
    const buffer = this.buffers.get(connectionId)
    const isClosed = this.closedConnections.has(connectionId)

    if (!buffer) {
      if (isClosed) return { messages: [], connectionClosed: true }
      return { messages: [], connectionClosed: false }
    }

    // If buffer already has messages, drain immediately
    if (buffer.length > 0) {
      const messages = buffer.map((m) => m.data)
      buffer.length = 0
      return { messages, connectionClosed: false }
    }

    // Wait for messages up to waitMs
    const result = await new Promise<unknown[]>((resolve) => {
      const deadline = setTimeout(() => {
        resolve([])
      }, waitMs)

      const poll = setInterval(() => {
        const buf = this.buffers.get(connectionId)
        if (!buf) {
          clearInterval(poll)
          clearTimeout(deadline)
          resolve([])
          return
        }
        if (buf.length > 0) {
          clearInterval(poll)
          clearTimeout(deadline)
          const msgs = buf.map((m) => m.data)
          buf.length = 0
          resolve(msgs)
        } else if (this.closedConnections.has(connectionId)) {
          clearInterval(poll)
          clearTimeout(deadline)
          resolve([])
        }
      }, 50)
    })

    return {
      messages: result,
      connectionClosed: this.closedConnections.has(connectionId),
    }
  }

  /** Close a connection. */
  disconnect(connectionId: string): { success: boolean; error?: string } {
    const ws = this.connections.get(connectionId)
    if (!ws) {
      if (this.closedConnections.has(connectionId)) return { success: true }
      return { success: false, error: 'Connection not found' }
    }
    ws.close()
    this.connections.delete(connectionId)
    this.closedConnections.add(connectionId)
    this.buffers.delete(connectionId)
    return { success: true }
  }

  /** Check if any connections are still active. */
  hasActiveConnections(): boolean {
    return this.connections.size > 0
  }

  /** Drain all buffers across all connections. */
  drainAll(): { connectionId: string; messages: unknown[] }[] {
    const results: { connectionId: string; messages: unknown[] }[] = []
    for (const [connectionId, buffer] of this.buffers) {
      if (buffer.length > 0) {
        results.push({ connectionId, messages: buffer.map((m) => m.data) })
        buffer.length = 0
      }
    }
    return results
  }

  /** Wait for any message on any connection, up to timeoutMs. */
  async waitForAny(timeoutMs: number): Promise<{ connectionId: string; messages: unknown[] }[]> {
    return new Promise((resolve) => {
      const deadline = setTimeout(() => resolve([]), timeoutMs)

      const poll = setInterval(() => {
        const results = this.drainAll()
        if (results.length > 0) {
          clearInterval(poll)
          clearTimeout(deadline)
          resolve(results)
          return
        }
        // If no active connections remain, stop waiting
        if (!this.hasActiveConnections()) {
          clearInterval(poll)
          clearTimeout(deadline)
          resolve([])
        }
      }, 50)
    })
  }

  /** Close all connections. */
  disconnectAll(): void {
    for (const [id, ws] of this.connections) {
      ws.close()
      this.closedConnections.add(id)
    }
    this.connections.clear()
    this.buffers.clear()
  }
}

// ─── Generic Tools ───────────────────────────────────────────────────────────

function createGenericTools(wsManager: WebSocketManager) {
  return {
    fetch_document: tool({
      description:
        'Fetch a document from a URL and return its text content. Use this to read documentation, skill files, or any web resource.',
      inputSchema: z.object({
        url: z.string().describe('The URL to fetch'),
        documentRole: z
          .enum(['skill', 'reference'])
          .optional()
          .describe('Optional role hint: "skill" for bootstrap skill docs (promoted to system context), "reference" for on-demand docs'),
      }),
      execute: async ({ url }) => {
        const res = await fetch(url)
        if (!res.ok)
          return { error: `HTTP ${res.status}: ${res.statusText}`, body: await res.text() }
        return { content: await res.text() }
      },
    }),

    http_request: tool({
      description:
        'Make an HTTP request to any URL. Use for REST API calls (registering, joining tables, etc.).',
      inputSchema: z.object({
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).describe('HTTP method'),
        url: z.string().describe('The full URL to request'),
        headers: z
          .record(z.string())
          .optional()
          .describe('Optional HTTP headers (e.g. Authorization, Content-Type)'),
        body: z
          .string()
          .optional()
          .describe('Optional request body (JSON string for POST/PUT)'),
      }),
      execute: async ({ method, url, headers, body }) => {
        const fetchHeaders: Record<string, string> = { ...headers }
        if (body && !fetchHeaders['Content-Type'])
          fetchHeaders['Content-Type'] = 'application/json'

        const res = await fetch(url, {
          method,
          headers: fetchHeaders,
          body: body ?? undefined,
        })

        const responseBody = await res.text()
        return {
          status: res.status,
          statusText: res.statusText,
          body: responseBody,
        }
      },
    }),

    websocket_connect: tool({
      description:
        'Open a WebSocket connection to a URL. Returns a connectionId to use with websocket_send, websocket_read, and websocket_disconnect.',
      inputSchema: z.object({
        url: z.string().describe('The WebSocket URL to connect to (ws:// or wss://)'),
      }),
      execute: async ({ url }) => {
        try {
          return await wsManager.connect(url)
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),

    websocket_send: tool({
      description:
        'Send a message on an existing WebSocket connection. The message should be a JSON string.',
      inputSchema: z.object({
        connectionId: z.string().describe('The connection ID from websocket_connect'),
        message: z.string().describe('The message to send (typically a JSON string)'),
      }),
      execute: async ({ connectionId, message }) => {
        return wsManager.send(connectionId, message)
      },
    }),

    websocket_read: tool({
      description:
        'Read buffered messages from a WebSocket connection. Waits up to waitMs milliseconds for at least one message to arrive. Returns all buffered messages and whether the connection has closed.',
      inputSchema: z.object({
        connectionId: z.string().describe('The connection ID from websocket_connect'),
        waitMs: z
          .number()
          .optional()
          .describe('Maximum time to wait for messages in milliseconds (default: 30000)'),
      }),
      execute: async ({ connectionId, waitMs }) => {
        const result = await wsManager.read(connectionId, waitMs)
        return result
      },
    }),

    websocket_disconnect: tool({
      description: 'Close a WebSocket connection.',
      inputSchema: z.object({
        connectionId: z.string().describe('The connection ID to disconnect'),
      }),
      execute: async ({ connectionId }) => {
        return wsManager.disconnect(connectionId)
      },
    }),

    generate_uuid: tool({
      description:
        'Generate a unique UUID v4 string. Use this when the documentation requires unique identifiers.',
      inputSchema: z.object({}),
      execute: async () => {
        return { uuid: crypto.randomUUID() }
      },
    }),
  }
}

// ─── Context Management ──────────────────────────────────────────────────────

/** Number of initial messages to always preserve (task prompt + early tool results with skill doc) */
const PRESERVE_HEAD = 5
/** Number of recent messages to keep */
const PRESERVE_TAIL = 30
/** Threshold above which we start trimming */
const TRIM_THRESHOLD = 50
/** Maximum consecutive errors before resetting context */
const MAX_CONSECUTIVE_ERRORS = 3

/**
 * Find a safe cut point in messages where we won't orphan tool results.
 * A safe cut point is right before a user or assistant message (not a tool message).
 */
function findSafeCutStart(messages: ModelMessage[], targetIndex: number): number {
  // Walk forward from targetIndex to find a non-tool message
  for (let i = targetIndex; i < messages.length; i++) {
    if (messages[i]?.role !== 'tool') return i
  }
  return targetIndex
}

function findSafeCutEnd(messages: ModelMessage[], targetIndex: number): number {
  // Walk backward from targetIndex to find a point where the next message isn't 'tool'
  for (let i = targetIndex; i >= 0; i--) {
    const next = messages[i + 1]
    if (!next || next.role !== 'tool') return i + 1
  }
  return targetIndex
}

function trimContext(messages: ModelMessage[]): void {
  if (messages.length <= TRIM_THRESHOLD) return

  // Find safe head boundary (don't cut in the middle of a tool call/result pair)
  const headEnd = findSafeCutStart(messages, PRESERVE_HEAD)

  // Find safe tail boundary
  const tailStartTarget = messages.length - PRESERVE_TAIL
  const tailStart = findSafeCutEnd(messages, tailStartTarget)

  // If safe boundaries overlap or leave nothing to trim, skip
  if (tailStart <= headEnd) return

  const head = messages.slice(0, headEnd)
  const tail = messages.slice(tailStart)
  const trimmedCount = messages.length - head.length - tail.length

  const marker: ModelMessage = {
    role: 'user' as const,
    content: `[System note: ${trimmedCount} older messages were trimmed to save context. Skill documentation is in system context. Recent messages follow.]`,
  }

  messages.length = 0
  messages.push(...head, marker, ...tail)
}

// ─── Autonomous Agent ────────────────────────────────────────────────────────

/**
 * Domain-agnostic autonomous LLM agent.
 *
 * Has zero hard-coded knowledge of poker, APIs, or protocols.
 * All domain knowledge is discovered at runtime by fetching a skill document.
 *
 * Equipped with generic tools: HTTP requests, WebSocket management, UUID generation.
 * Uses a ReAct-style manual loop powered by AI SDK v6's generateText.
 */
export class AutonomousAgent extends LlmAgentBase {
  private wsManager: WebSocketManager
  private tools: ReturnType<typeof createGenericTools>
  private log: ReturnType<typeof createJsonlLogger>
  private maxIterations: number
  private stopped = false
  private onStep: ((step: StepEvent) => void) | null
  private runtimeSystemPrompt: string
  private skillPromoted = false

  constructor(config: AutonomousAgentConfig) {
    const modelId = (config.model as { modelId?: string }).modelId ?? 'unknown'
    super({
      name: `AutonomousAgent (${modelId})`,
      agentType: 'autonomous',
      model: config.model,
      temperature: config.temperature,
    })
    this.maxIterations = config.maxIterations ?? 2000
    this.wsManager = new WebSocketManager()
    this.tools = createGenericTools(this.wsManager)
    this.log = createJsonlLogger(config.logPath)
    this.onStep = config.onStep ?? null
    this.runtimeSystemPrompt = SYSTEM_PROMPT
  }

  /** Signal the agent to stop after the current iteration. */
  stop(): void {
    this.stopped = true
  }

  /**
   * Run the autonomous agent with the given task description.
   * The agent will use its tools to accomplish the task, running in a loop
   * until the task is complete, no active connections remain, or it is stopped.
   */
  async run(task: string): Promise<void> {
    const messages: ModelMessage[] = [
      { role: 'user', content: task },
    ]

    if (!this.onStep) console.log(`[${this.name}] Starting task...`)
    this.log({ event: 'agent_start', timestamp: new Date().toISOString(), task })

    let iteration = 0
    let consecutiveErrors = 0
    let lastErrorMessage = ''

    while (!this.stopped && iteration < this.maxIterations) {
      iteration++

      this.log({
        event: 'iteration_start',
        timestamp: new Date().toISOString(),
        iteration,
        messageCount: messages.length,
      })

      // Log the prompt (messages sent to the LLM)
      this.log({
        event: 'llm_prompt',
        timestamp: new Date().toISOString(),
        iteration,
        system: iteration === 1 ? this.runtimeSystemPrompt : undefined,
        messages: messages.map((m) => ({
          role: m.role,
          content: typeof m.content === 'string'
            ? (m.content.length > 2000 ? m.content.slice(0, 2000) + '...' : m.content)
            : '[complex]',
        })),
      })

      try {
        const result = await generateText({
          model: this.model,
          system: this.runtimeSystemPrompt,
          messages,
          tools: this.tools,
          stopWhen: this.skillPromoted ? stepCountIs(5) : stepCountIs(1),
          temperature: this.temperature,
          onStepFinish: ({ toolCalls, toolResults, text, usage }) => {
            // Build paired tool steps (call input + result output)
            const tools: ToolStep[] = (toolCalls ?? []).map((tc) => {
              const tr = (toolResults ?? []).find(
                (r: { toolCallId: string }) => r.toolCallId === tc.toolCallId,
              )
              return {
                toolName: tc.toolName,
                input: tc.input,
                output: tr ? (tr as { output: unknown }).output : null,
              }
            })

            // Fire external callback or fall back to default console logging
            if (this.onStep) {
              this.onStep({ tools, text: text ?? null, usage, iteration })
            } else {
              for (const t of tools) {
                console.log(`[${this.name}] Tool: ${t.toolName}(${summarizeArgs(t.input)})`)
              }
              if (text) {
                const preview = text.length > 200 ? text.slice(0, 200) + '...' : text
                console.log(`[${this.name}] Thinking: ${preview}`)
              }
            }

            // Always log to JSONL (includes both calls and results)
            // Compact skill document outputs to save log space
            const compactedResults = tools.map((t) => {
              if (t.toolName === 'fetch_document' && t.output) {
                const output = t.output as { content?: string; error?: string }
                const input = t.input as { documentRole?: string; url?: string }
                if (input.documentRole === 'skill' && output.content && output.content.length > 1000) {
                  return {
                    name: t.toolName,
                    output: {
                      ...output,
                      content: `[${output.content.length} chars, first 200]: ${output.content.substring(0, 200)}...`,
                    },
                  }
                }
              }
              return { name: t.toolName, output: t.output }
            })
            
            this.log({
              event: 'step',
              timestamp: new Date().toISOString(),
              iteration,
              toolCalls: tools.map((t) => ({ name: t.toolName, input: t.input })),
              toolResults: compactedResults,
              text: text ?? null,
              usage,
            })
          },
        })

        // Successful generation — reset error tracking
        consecutiveErrors = 0
        lastErrorMessage = ''

        // Log the LLM response summary
        this.log({
          event: 'llm_response',
          timestamp: new Date().toISOString(),
          iteration,
          text: result.text ?? null,
          stepCount: result.steps?.length ?? 0,
          finishReason: result.finishReason,
        })

        // Detect and promote skill document to system prompt (one-time only)
        if (!this.skillPromoted && result.steps) {
          for (const step of result.steps) {
            if (step.toolCalls && step.toolResults) {
              for (const toolCall of step.toolCalls) {
                if (toolCall.toolName === 'fetch_document') {
                  // Access input property (matches onStepFinish format)
                  const input = (toolCall as unknown as { input?: { url?: string; documentRole?: string } }).input
                  if (input?.documentRole === 'skill') {
                    // Find matching tool result
                    const toolResult = step.toolResults.find(
                      (r: { toolCallId: string }) => r.toolCallId === toolCall.toolCallId
                    ) as { output?: { content?: string; error?: string } } | undefined
                    
                    const content = toolResult?.output?.content
                    
                    if (content && typeof content === 'string' && content.length > 1000) {
                      this.runtimeSystemPrompt = content
                      this.skillPromoted = true
                      
                      if (!this.onStep) {
                        console.log(`[${this.name}] Skill document promoted to system context (${content.length} chars)`)
                      }
                      
                      this.log({
                        event: 'skill_promoted',
                        timestamp: new Date().toISOString(),
                        iteration,
                        url: input.url,
                        contentLength: content.length,
                      })
                      break
                    }
                  }
                }
              }
            }
            if (this.skillPromoted) break
          }
        }

        // Append the response messages to our conversation history
        messages.push(...result.response.messages)

        // Compact skill tool results in message history to save context
        if (this.skillPromoted) {
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i]
            if (msg && msg.role === 'tool' && Array.isArray(msg.content)) {
              // Look for large text content in tool results
              let hasLargeContent = false
              for (const part of msg.content) {
                if (part && typeof part === 'object' && 'type' in part && part.type === 'tool-result') {
                  // Access result content using type assertion via unknown
                  const resultPart = part as unknown as { type: 'tool-result'; toolCallId: string; result: unknown }
                  const result = resultPart.result
                  if (typeof result === 'string' && result.length > 5000 && result.includes('# ')) {
                    hasLargeContent = true
                    break
                  }
                }
              }
              
              // Replace entire message with compacted version if it has large content
              if (hasLargeContent) {
                const newContent = msg.content.map(part => {
                  if (part && typeof part === 'object' && 'type' in part && part.type === 'tool-result') {
                    const resultPart = part as unknown as { type: 'tool-result'; toolCallId: string; result: unknown }
                    const result = resultPart.result
                    if (typeof result === 'string' && result.length > 5000) {
                      const preview = result.substring(0, 200)
                      const hash = result.length.toString(36)
                      return {
                        type: 'tool-result' as const,
                        toolCallId: resultPart.toolCallId,
                        result: `[Skill document promoted to system context - ${result.length} chars, hash: ${hash}]\nPreview: ${preview}...`,
                      }
                    }
                  }
                  return part
                })
                messages[i] = { ...msg, content: newContent as typeof msg.content }
              }
            }
          }
        }

        // If model generated final text (no pending tool calls), log it
        if (result.text && !this.onStep) {
          const preview = result.text.length > 300 ? result.text.slice(0, 300) + '...' : result.text
          console.log(`[${this.name}] ${preview}`)
        }

        // Check if the agent has any active WebSocket connections
        if (!this.wsManager.hasActiveConnections()) {
          if (!this.onStep) console.log(`[${this.name}] No active connections. Checking for completion...`)

          // Give the agent one more chance — maybe it needs to make another HTTP call
          // If it also generated text without tool calls, we're done
          if (result.text && (!result.steps || result.steps.every((s) => !s.toolCalls?.length))) {
            if (!this.onStep) console.log(`[${this.name}] Agent completed (no connections, no tool calls).`)
            break
          }
        }

        // Inject any pending WebSocket events that arrived during the LLM call
        const pending = this.wsManager.drainAll()
        if (pending.length > 0) {
          const eventSummary = pending
            .flatMap((p) => p.messages.map((m) => JSON.stringify(m)))
            .join('\n')
          messages.push({
            role: 'user',
            content: `[WebSocket events received]:\n${eventSummary}`,
          })
        } else if (this.wsManager.hasActiveConnections()) {
          // No pending events but connections are active — wait for events
          const events = await this.wsManager.waitForAny(30_000)
          if (events.length > 0) {
            const eventSummary = events
              .flatMap((e) => e.messages.map((m) => JSON.stringify(m)))
              .join('\n')
            messages.push({
              role: 'user',
              content: `[WebSocket events received]:\n${eventSummary}`,
            })
          } else {
            // Timeout — nudge the agent
            messages.push({
              role: 'user',
              content:
                '[System note: No WebSocket events received for 30 seconds. Check your connection or continue waiting.]',
            })
          }
        }

        // Context management — trim if conversation is getting too long
        trimContext(messages)
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        console.error(`[${this.name}] Error in iteration ${iteration}: ${errorMsg}`)
        this.log({
          event: 'error',
          timestamp: new Date().toISOString(),
          iteration,
          error: errorMsg,
        })

        // Detect repeating errors (e.g. orphaned tool call IDs after context trim)
        if (errorMsg === lastErrorMessage) {
          consecutiveErrors++
        } else {
          consecutiveErrors = 1
          lastErrorMessage = errorMsg
        }

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.log(`[${this.name}] Same error repeated ${consecutiveErrors} times. Resetting context...`)
          this.log({ event: 'context_reset', timestamp: new Date().toISOString(), iteration, reason: errorMsg })

          // Reset to a clean state: keep only the task and a recovery instruction
          messages.length = 0
          messages.push(
            { role: 'user', content: task },
            {
              role: 'user',
              content: `[System note: Context was reset due to repeated errors. You were previously connected and playing. Use your tools to check your WebSocket connections and continue from where you left off. If the connection is closed, reconnect following the documentation at the skill URL.]`,
            },
          )

          // Also drain any pending WS messages to avoid stale state
          this.wsManager.drainAll()
          consecutiveErrors = 0
          lastErrorMessage = ''
          continue
        }

        // Feed the error back so the agent can recover
        messages.push({
          role: 'user',
          content: `[System error]: ${errorMsg}\nPlease handle this error and continue.`,
        })
      }
    }

    if (iteration >= this.maxIterations)
      console.log(`[${this.name}] Reached max iterations (${this.maxIterations}). Stopping.`)

    // Clean up
    this.wsManager.disconnectAll()
    this.log({ event: 'agent_stop', timestamp: new Date().toISOString(), iterations: iteration })
    console.log(`[${this.name}] Stopped after ${iteration} iterations.`)
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Summarize tool call args for console logging (keep it short). */
function summarizeArgs(args: unknown): string {
  const str = JSON.stringify(args)
  if (str.length <= 120) return str
  return str.slice(0, 117) + '...'
}
