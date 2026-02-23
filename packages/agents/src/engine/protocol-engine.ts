/**
 * Protocol Engine — generic interpreter for skill.md YAML contracts.
 *
 * No domain-specific types. The YAML contract is walked as a generic tree
 * and dispatched to built-in handlers based on recognized keywords.
 *
 * @module protocol-engine
 */

import { search as jmesSearch } from '@jmespath-community/jmespath'
import { Output, generateText } from 'ai'
import type { LanguageModel } from 'ai'
import { z } from 'zod'
import type { ZodType } from 'zod'

// ─── Core Types ──────────────────────────────────────────────────────────────

export type HandlerFn = (
  config: Record<string, unknown>,
  ctx: EngineContext,
) => Promise<void>

export interface StateReducer {
  historyBuffers: Map<string, { from: string; keep: number; label: string; buffer: unknown[] }>
  accumulators: Map<string, {
    on: string
    field: string
    into: string
    resetOn: string
    max: number
    list: unknown[]
  }>
}

export interface EngineContext {
  vars: Map<string, unknown>
  ws: WebSocket | null
  model: LanguageModel
  prose: string
  decisionSchema: ZodType | null
  stateReducer: StateReducer | null
  log: (entry: Record<string, unknown>) => void
  onStep?: (event: unknown) => void
  stopped: boolean
}

export interface ProtocolDecision {
  reasoning: string
  kind: 'fold' | 'check' | 'call' | 'raiseTo'
  amount: number | null
}

// ─── Variable Interpolation ──────────────────────────────────────────────────

/**
 * Recursively walk an object/string template and replace `{var}` tokens
 * with values from the variable store. Keys whose resolved value is `null`
 * are dropped from objects (handles optional fields like `amount`).
 */
export function interpolate(template: unknown, vars: Map<string, unknown>): unknown {
  if (typeof template === 'string') {
    // If the entire string is a single `{var}`, return the raw value (preserves type)
    const exactMatch = /^\{(\w+)\}$/.exec(template)
    if (exactMatch) {
      const val = vars.get(exactMatch[1]!)
      return val === undefined ? template : val
    }
    // Otherwise do substring replacement (always returns string)
    return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
      const val = vars.get(key)
      if (val === null || val === undefined) return ''
      return String(val)
    })
  }

  if (Array.isArray(template))
    return template.map((item) => interpolate(item, vars))

  if (template !== null && typeof template === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(template as Record<string, unknown>)) {
      const resolved = interpolate(value, vars)
      // Drop keys whose resolved value is null (optional fields)
      if (resolved !== null && resolved !== '') result[key] = resolved
    }
    return result
  }

  return template
}

// ─── JMESPath Extraction ─────────────────────────────────────────────────────

export function extractField(data: unknown, expression: string): unknown {
  return jmesSearch(data as Parameters<typeof jmesSearch>[0], expression)
}

export function extractAll(
  data: unknown,
  mapping: Record<string, string>,
  vars: Map<string, unknown>,
): void {
  for (const [varName, jmesExpr] of Object.entries(mapping)) {
    vars.set(varName, extractField(data, jmesExpr))
  }
}

// ─── JSON Schema → Zod (v3 compatible) ──────────────────────────────────────

/**
 * Build a Zod schema from a JSON Schema object at runtime.
 * Supports the subset needed for LLM structured output: object, string
 * (with enum), integer, number, boolean, arrays, and nullable types.
 */
export function buildZodSchema(jsonSchema: Record<string, unknown>): ZodType {
  return buildNode(jsonSchema)
}

function buildNode(node: Record<string, unknown>): ZodType {
  const type = node.type

  // Handle nullable via type array: ["integer", "null"]
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== 'null')
    if (nonNull.length === 1) {
      const inner = buildNode({ ...node, type: nonNull[0] })
      return inner.nullable() as ZodType
    }
    // Union of multiple non-null types — rare, just use unknown
    return z.unknown()
  }

  switch (type) {
    case 'object': {
      const properties = (node.properties ?? {}) as Record<string, Record<string, unknown>>
      const required = (node.required ?? []) as string[]
      const shape: Record<string, ZodType> = {}

      for (const [key, propSchema] of Object.entries(properties)) {
        let fieldSchema = buildNode(propSchema)
        if (propSchema.description && typeof propSchema.description === 'string')
          fieldSchema = fieldSchema.describe(propSchema.description) as ZodType
        if (!required.includes(key))
          fieldSchema = fieldSchema.optional() as unknown as ZodType
        shape[key] = fieldSchema
      }

      return z.object(shape)
    }

    case 'string': {
      if (node.enum && Array.isArray(node.enum)) {
        const values = node.enum as [string, ...string[]]
        return z.enum(values)
      }
      return z.string()
    }

    case 'integer':
      return z.number().int()

    case 'number':
      return z.number()

    case 'boolean':
      return z.boolean()

    case 'array': {
      const items = (node.items ?? {}) as Record<string, unknown>
      return z.array(buildNode(items))
    }

    default:
      return z.unknown()
  }
}

// ─── Condition Evaluation ────────────────────────────────────────────────────

/**
 * Evaluate a `when` condition array against a message.
 * Each condition uses: `field` (JMESPath), and one of:
 * - `equals` (literal comparison)
 * - `equals_var` (compare to variable store value)
 * - `not_empty` (truthy + non-empty array)
 * All conditions must pass (AND logic).
 */
export function evaluateWhen(
  conditions: Array<Record<string, unknown>>,
  message: unknown,
  vars: Map<string, unknown>,
): boolean {
  for (const condition of conditions) {
    const field = condition.field as string
    const value = extractField(message, field)

    if ('equals' in condition) {
      if (value !== condition.equals) return false
    } else if ('equals_var' in condition) {
      const varValue = vars.get(condition.equals_var as string)
      if (value !== varValue) return false
    } else if ('not_empty' in condition) {
      if (condition.not_empty === true) {
        if (value === null || value === undefined) return false
        if (Array.isArray(value) && value.length === 0) return false
      }
    }
  }
  return true
}

// ─── Message Matching ────────────────────────────────────────────────────────

/**
 * Check if a message matches a rule's `match` object.
 * Every key/value in the match object must equal the corresponding message field.
 */
export function matchMessage(
  matchObj: Record<string, unknown>,
  message: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(matchObj)) {
    if (message[key] !== expected) return false
  }
  return true
}

// ─── State Reducer ───────────────────────────────────────────────────────────

/**
 * Initialize a StateReducer from the `state` YAML config block.
 */
export function initStateReducer(
  stateConfig: Record<string, unknown>,
): StateReducer {
  const reducer: StateReducer = {
    historyBuffers: new Map(),
    accumulators: new Map(),
  }

  const history = (stateConfig.history ?? []) as Array<Record<string, unknown>>
  for (const h of history) {
    const label = h.label as string
    reducer.historyBuffers.set(label, {
      from: h.from as string,
      keep: h.keep as number,
      label,
      buffer: [],
    })
  }

  const accumulate = (stateConfig.accumulate ?? []) as Array<Record<string, unknown>>
  for (const a of accumulate) {
    const into = a.into as string
    reducer.accumulators.set(into, {
      on: a.on as string,
      field: a.field as string,
      into,
      resetOn: a.reset_on as string,
      max: (a.max ?? 100) as number,
      list: [],
    })
  }

  return reducer
}

/**
 * Run the state reducer on an incoming message.
 * Called on EVERY message, BEFORE classification.
 * Updates ctx.vars with accumulated state.
 */
export function reduceState(
  message: Record<string, unknown>,
  reducer: StateReducer,
  vars: Map<string, unknown>,
): void {
  const msgType = message.type as string

  // History ring buffers
  for (const [label, buf] of reducer.historyBuffers) {
    if (msgType === buf.from) {
      buf.buffer.push(structuredClone(message))
      if (buf.buffer.length > buf.keep) buf.buffer.shift()
      vars.set(label, [...buf.buffer])
    }
  }

  // Field accumulators
  for (const [into, acc] of reducer.accumulators) {
    // Reset on matching message type
    if (msgType === acc.resetOn) {
      acc.list = []
      vars.set(into, [])
    }

    // Accumulate on matching message type
    if (msgType === acc.on) {
      const value = extractField(message, acc.field)
      if (value !== null && value !== undefined) {
        acc.list.push(value)
        if (acc.list.length > acc.max) acc.list.shift()
      }
      vars.set(into, [...acc.list])
    }
  }
}

// ─── HTTP Request Handler ────────────────────────────────────────────────────

export async function httpRequest(
  config: Record<string, unknown>,
  ctx: EngineContext,
): Promise<Record<string, unknown>> {
  const method = interpolate(config.method, ctx.vars) as string
  const url = interpolate(config.url, ctx.vars) as string
  const headers = (config.headers
    ? interpolate(config.headers, ctx.vars) as Record<string, string>
    : {}) as Record<string, string>

  // Always set content-type for POST/PUT
  if ((method === 'POST' || method === 'PUT') && !headers['Content-Type'])
    headers['Content-Type'] = 'application/json'

  const body = config.body
    ? JSON.stringify(interpolate(config.body, ctx.vars))
    : undefined

  ctx.log({ handler: 'http_request', method, url })

  const response = await fetch(url, { method, headers, body })
  const json = await response.json() as Record<string, unknown>

  if (!response.ok)
    throw new Error(`HTTP ${response.status} from ${method} ${url}: ${JSON.stringify(json)}`)

  // Extract fields from response
  if (config.extract && typeof config.extract === 'object')
    extractAll(json, config.extract as Record<string, string>, ctx.vars)

  return json
}

// ─── LLM Decision Handler ────────────────────────────────────────────────────

/**
 * Build the user prompt from accumulated state + current message.
 * Generically reads named variables from ctx.vars that the state reducer populated.
 */
function buildDecisionPrompt(
  currentMessage: Record<string, unknown>,
  ctx: EngineContext,
): string {
  const sections: string[] = []

  if (ctx.stateReducer) {
    // Append accumulated state sections
    for (const [into] of ctx.stateReducer.accumulators) {
      const list = ctx.vars.get(into) as unknown[]
      if (list && list.length > 0)
        sections.push(`${into}:\n${JSON.stringify(list, null, 2)}`)
    }

    for (const [label] of ctx.stateReducer.historyBuffers) {
      const list = ctx.vars.get(label) as unknown[]
      if (list && list.length > 0)
        sections.push(`${label}:\n${JSON.stringify(list, null, 2)}`)
    }
  }

  sections.push(`Current game state:\n${JSON.stringify(currentMessage, null, 2)}`)
  sections.push('Choose your action.')

  return sections.join('\n\n')
}

export async function llmDecide(
  currentMessage: Record<string, unknown>,
  ctx: EngineContext,
): Promise<ProtocolDecision> {
  if (!ctx.decisionSchema)
    throw new Error('No decision schema configured — cannot call LLM')

  const prompt = buildDecisionPrompt(currentMessage, ctx)

  ctx.log({ handler: 'llm_decide', promptLength: prompt.length })

  let object: unknown
  try {
    ({ output: object } = await generateText({
      model: ctx.model,
      output: Output.object({ schema: ctx.decisionSchema }),
      system: ctx.prose,
      prompt,
      temperature: 0.3,
    }))
  } catch (error) {
    throw error
  }

  const decision = object as ProtocolDecision

  ctx.log({ handler: 'llm_decide', decision })
  return decision
}

// ─── WebSocket Send ──────────────────────────────────────────────────────────

export function wsSend(
  template: unknown,
  ctx: EngineContext,
  vars: Map<string, unknown> = ctx.vars,
): void {
  if (!ctx.ws) throw new Error('No active WebSocket connection')

  const payload = interpolate(template, vars)
  const json = JSON.stringify(payload)

  ctx.log({ handler: 'ws_send', payload })
  ctx.ws.send(json)
}

// ─── Safety Default ──────────────────────────────────────────────────────────

/**
 * Compute the safety default action based on the `safety` config and
 * the available legal actions in the message.
 */
export function computeSafetyAction(
  safetyConfig: Record<string, unknown>,
  message: Record<string, unknown>,
): ProtocolDecision {
  const actions = extractField(message, 'actions') as Array<Record<string, unknown>> | null
  const prefer = safetyConfig.prefer as string
  const fallback = safetyConfig.fallback as string

  const hasPreferred = actions?.some((a) => a.kind === prefer)
  const kind = hasPreferred ? prefer : fallback

  return {
    kind: kind as ProtocolDecision['kind'],
    amount: null,
    reasoning: 'safety default',
  }
}

// ─── Engine Context Factory ──────────────────────────────────────────────────

export function createEngineContext(options: {
  model: LanguageModel
  log?: (entry: Record<string, unknown>) => void
  onStep?: (event: unknown) => void
}): EngineContext {
  return {
    vars: new Map<string, unknown>(),
    ws: null,
    model: options.model,
    prose: '',
    decisionSchema: null,
    stateReducer: null,
    log: options.log ?? (() => {}),
    onStep: options.onStep,
    stopped: false,
  }
}
