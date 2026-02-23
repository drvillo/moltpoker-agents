import { describe, it, expect } from 'vitest'

import {
  interpolate,
  extractField,
  extractAll,
  buildZodSchema,
  evaluateWhen,
  matchMessage,
  initStateReducer,
  reduceState,
  computeSafetyAction,
} from '../../src/engine/protocol-engine.js'

// ─── interpolate ─────────────────────────────────────────────────────────────

describe('interpolate', () => {
  it('replaces a single {var} token with raw value (preserves type)', () => {
    const vars = new Map<string, unknown>([['count', 42]])
    expect(interpolate('{count}', vars)).toBe(42)
  })

  it('replaces multiple tokens in a string (returns string)', () => {
    const vars = new Map<string, unknown>([
      ['host', 'localhost'],
      ['port', '3000'],
    ])
    expect(interpolate('{host}:{port}', vars)).toBe('localhost:3000')
  })

  it('returns the original string when token is not in vars', () => {
    const vars = new Map<string, unknown>()
    expect(interpolate('{missing}', vars)).toBe('{missing}')
  })

  it('drops null values from objects', () => {
    const vars = new Map<string, unknown>([
      ['kind', 'call'],
      ['amount', null],
    ])
    const template = { kind: '{kind}', amount: '{amount}' }
    const result = interpolate(template, vars) as Record<string, unknown>
    expect(result.kind).toBe('call')
    expect(result).not.toHaveProperty('amount')
  })

  it('recursively walks nested objects', () => {
    const vars = new Map<string, unknown>([
      ['token', 'abc'],
      ['seq', 5],
    ])
    const template = { outer: { inner: '{token}' }, seq: '{seq}' }
    const result = interpolate(template, vars) as Record<string, unknown>
    expect((result.outer as Record<string, unknown>).inner).toBe('abc')
    expect(result.seq).toBe(5)
  })

  it('handles arrays', () => {
    const vars = new Map<string, unknown>([['x', 'hello']])
    const result = interpolate(['{x}', 'static'], vars)
    expect(result).toEqual(['hello', 'static'])
  })

  it('returns non-string/object values as-is', () => {
    const vars = new Map<string, unknown>()
    expect(interpolate(42, vars)).toBe(42)
    expect(interpolate(true, vars)).toBe(true)
    expect(interpolate(null, vars)).toBe(null)
  })
})

// ─── extractField / extractAll ───────────────────────────────────────────────

describe('extractField', () => {
  it('extracts a top-level field', () => {
    expect(extractField({ api_key: 'k123' }, 'api_key')).toBe('k123')
  })

  it('extracts a nested field via JMESPath', () => {
    const data = { players: [{ seat: 0, cards: ['As', 'Kh'] }, { seat: 1 }] }
    // JMESPath: first player's cards
    const result = extractField(data, 'players[0].cards')
    expect(result).toEqual(['As', 'Kh'])
  })

  it('returns null for missing path', () => {
    expect(extractField({ a: 1 }, 'b')).toBe(null)
  })
})

describe('extractAll', () => {
  it('extracts multiple fields into the variable store', () => {
    const data = { session_token: 'tok', ws_url: 'wss://example.com', extra: true }
    const vars = new Map<string, unknown>()
    extractAll(data, { session_token: 'session_token', ws_url: 'ws_url' }, vars)
    expect(vars.get('session_token')).toBe('tok')
    expect(vars.get('ws_url')).toBe('wss://example.com')
    expect(vars.has('extra')).toBe(false)
  })
})

// ─── buildZodSchema ──────────────────────────────────────────────────────────

describe('buildZodSchema', () => {
  it('builds a schema for a simple object with required fields', () => {
    const jsonSchema = {
      type: 'object',
      required: ['reasoning', 'kind'],
      properties: {
        reasoning: { type: 'string', description: 'Why' },
        kind: { type: 'string', enum: ['fold', 'check', 'call', 'raiseTo'] },
      },
    }
    const schema = buildZodSchema(jsonSchema)
    const good = schema.safeParse({ reasoning: 'because', kind: 'call' })
    expect(good.success).toBe(true)

    const bad = schema.safeParse({ reasoning: 'because' })
    expect(bad.success).toBe(false)
  })

  it('handles nullable types: ["integer", "null"]', () => {
    const jsonSchema = {
      type: 'object',
      required: ['amount'],
      properties: {
        amount: { type: ['integer', 'null'], description: 'raise amount' },
      },
    }
    const schema = buildZodSchema(jsonSchema)
    expect(schema.safeParse({ amount: 100 }).success).toBe(true)
    expect(schema.safeParse({ amount: null }).success).toBe(true)
    expect(schema.safeParse({ amount: 'hello' }).success).toBe(false)
  })

  it('validates enum constraints', () => {
    const jsonSchema = {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['fold', 'check'] },
      },
    }
    const schema = buildZodSchema(jsonSchema)
    expect(schema.safeParse({ kind: 'fold' }).success).toBe(true)
    expect(schema.safeParse({ kind: 'raiseTo' }).success).toBe(false)
  })

  it('handles optional fields (not in required)', () => {
    const jsonSchema = {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
    }
    const schema = buildZodSchema(jsonSchema)
    expect(schema.safeParse({ name: 'alice' }).success).toBe(true)
    expect(schema.safeParse({ name: 'alice', age: 30 }).success).toBe(true)
  })

  it('builds the full poker decision schema from the plan', () => {
    const jsonSchema = {
      type: 'object',
      required: ['reasoning', 'kind'],
      properties: {
        reasoning: { type: 'string', description: 'Brief explanation of your decision' },
        kind: {
          type: 'string',
          enum: ['fold', 'check', 'call', 'raiseTo'],
          description: 'The action to take',
        },
        amount: {
          type: ['integer', 'null'],
          description: 'Total raise amount (only for raiseTo, else null)',
        },
      },
    }
    const schema = buildZodSchema(jsonSchema)

    expect(schema.safeParse({
      reasoning: 'Strong hand',
      kind: 'raiseTo',
      amount: 200,
    }).success).toBe(true)

    expect(schema.safeParse({
      reasoning: 'Weak hand',
      kind: 'fold',
    }).success).toBe(true)

    expect(schema.safeParse({
      reasoning: 'Weak hand',
      kind: 'fold',
      amount: null,
    }).success).toBe(true)
  })
})

// ─── evaluateWhen ────────────────────────────────────────────────────────────

describe('evaluateWhen', () => {
  it('passes when equals matches', () => {
    const conditions = [{ field: 'status', equals: 'ended' }]
    expect(evaluateWhen(conditions, { status: 'ended' }, new Map())).toBe(true)
  })

  it('fails when equals does not match', () => {
    const conditions = [{ field: 'status', equals: 'ended' }]
    expect(evaluateWhen(conditions, { status: 'active' }, new Map())).toBe(false)
  })

  it('passes when equals_var matches variable store value', () => {
    const conditions = [{ field: 'turn', equals_var: 'my_seat' }]
    const vars = new Map<string, unknown>([['my_seat', 2]])
    expect(evaluateWhen(conditions, { turn: 2 }, vars)).toBe(true)
  })

  it('fails when equals_var does not match', () => {
    const conditions = [{ field: 'turn', equals_var: 'my_seat' }]
    const vars = new Map<string, unknown>([['my_seat', 2]])
    expect(evaluateWhen(conditions, { turn: 0 }, vars)).toBe(false)
  })

  it('passes when not_empty is true and field is non-empty array', () => {
    const conditions = [{ field: 'actions', not_empty: true }]
    expect(evaluateWhen(conditions, { actions: [{ kind: 'fold' }] }, new Map())).toBe(true)
  })

  it('fails when not_empty is true and field is empty array', () => {
    const conditions = [{ field: 'actions', not_empty: true }]
    expect(evaluateWhen(conditions, { actions: [] }, new Map())).toBe(false)
  })

  it('fails when not_empty is true and field is null', () => {
    const conditions = [{ field: 'actions', not_empty: true }]
    expect(evaluateWhen(conditions, { actions: null }, new Map())).toBe(false)
  })

  it('requires ALL conditions to pass (AND logic)', () => {
    const conditions = [
      { field: 'turn', equals_var: 'my_seat' },
      { field: 'actions', not_empty: true },
    ]
    const vars = new Map<string, unknown>([['my_seat', 1]])

    // Both pass
    expect(evaluateWhen(conditions, { turn: 1, actions: [{ kind: 'check' }] }, vars)).toBe(true)
    // First fails
    expect(evaluateWhen(conditions, { turn: 0, actions: [{ kind: 'check' }] }, vars)).toBe(false)
    // Second fails
    expect(evaluateWhen(conditions, { turn: 1, actions: [] }, vars)).toBe(false)
  })
})

// ─── matchMessage ────────────────────────────────────────────────────────────

describe('matchMessage', () => {
  it('matches when all keys match', () => {
    expect(matchMessage({ type: 'game_state' }, { type: 'game_state', seq: 1 })).toBe(true)
  })

  it('fails when any key does not match', () => {
    expect(matchMessage({ type: 'welcome' }, { type: 'game_state' })).toBe(false)
  })

  it('matches empty match object (everything matches)', () => {
    expect(matchMessage({}, { type: 'anything' })).toBe(true)
  })
})

// ─── State Reducer ───────────────────────────────────────────────────────────

describe('initStateReducer', () => {
  it('creates history buffers and accumulators from config', () => {
    const config = {
      history: [{ from: 'hand_complete', keep: 3, label: 'recent_hands' }],
      accumulate: [
        { on: 'game_state', field: 'last', into: 'action_sequence', reset_on: 'hand_complete', max: 30 },
      ],
    }
    const reducer = initStateReducer(config)
    expect(reducer.historyBuffers.size).toBe(1)
    expect(reducer.historyBuffers.get('recent_hands')!.from).toBe('hand_complete')
    expect(reducer.accumulators.size).toBe(1)
    expect(reducer.accumulators.get('action_sequence')!.on).toBe('game_state')
  })
})

describe('reduceState', () => {
  function makeReducer() {
    return initStateReducer({
      history: [{ from: 'hand_complete', keep: 2, label: 'recent_hands' }],
      accumulate: [
        { on: 'game_state', field: 'last', into: 'action_sequence', reset_on: 'hand_complete', max: 5 },
      ],
    })
  }

  it('accumulates fields from matching messages', () => {
    const reducer = makeReducer()
    const vars = new Map<string, unknown>()

    reduceState({ type: 'game_state', last: { seat: 0, kind: 'call' } }, reducer, vars)
    reduceState({ type: 'game_state', last: { seat: 1, kind: 'raiseTo', amount: 10 } }, reducer, vars)

    const seq = vars.get('action_sequence') as unknown[]
    expect(seq).toHaveLength(2)
    expect(seq[0]).toEqual({ seat: 0, kind: 'call' })
    expect(seq[1]).toEqual({ seat: 1, kind: 'raiseTo', amount: 10 })
  })

  it('resets accumulators on reset_on message type', () => {
    const reducer = makeReducer()
    const vars = new Map<string, unknown>()

    reduceState({ type: 'game_state', last: { seat: 0, kind: 'call' } }, reducer, vars)
    expect((vars.get('action_sequence') as unknown[]).length).toBe(1)

    reduceState({ type: 'hand_complete', hand: 1, results: [] }, reducer, vars)
    expect((vars.get('action_sequence') as unknown[]).length).toBe(0)
  })

  it('respects max accumulator length', () => {
    const reducer = makeReducer()
    const vars = new Map<string, unknown>()

    // Add 7 items (max is 5)
    for (let i = 0; i < 7; i++) {
      reduceState({ type: 'game_state', last: { seat: 0, kind: 'call', i } }, reducer, vars)
    }

    const seq = vars.get('action_sequence') as Array<Record<string, unknown>>
    expect(seq).toHaveLength(5)
    // Oldest items should have been dropped
    expect((seq[0] as Record<string, unknown>).i).toBe(2)
  })

  it('stores history ring buffer and drops oldest', () => {
    const reducer = makeReducer()
    const vars = new Map<string, unknown>()

    reduceState({ type: 'hand_complete', hand: 1, results: [{ won: 10 }] }, reducer, vars)
    reduceState({ type: 'hand_complete', hand: 2, results: [{ won: 20 }] }, reducer, vars)
    reduceState({ type: 'hand_complete', hand: 3, results: [{ won: 30 }] }, reducer, vars)

    const history = vars.get('recent_hands') as Array<Record<string, unknown>>
    // keep: 2 — only last 2
    expect(history).toHaveLength(2)
    expect(history[0]!.hand).toBe(2)
    expect(history[1]!.hand).toBe(3)
  })

  it('skips accumulation when extracted field is null/undefined', () => {
    const reducer = makeReducer()
    const vars = new Map<string, unknown>()

    // game_state with no `last` field
    reduceState({ type: 'game_state', seq: 1 }, reducer, vars)
    const seq = vars.get('action_sequence') as unknown[]
    expect(seq).toHaveLength(0)
  })

  it('does not interfere with unrelated message types', () => {
    const reducer = makeReducer()
    const vars = new Map<string, unknown>()

    reduceState({ type: 'ack', seq: 5 }, reducer, vars)
    // No accumulator or history triggers on 'ack'
    expect(vars.has('action_sequence')).toBe(false)
    expect(vars.has('recent_hands')).toBe(false)
  })
})

// ─── computeSafetyAction ─────────────────────────────────────────────────────

describe('computeSafetyAction', () => {
  it('uses prefer action if available', () => {
    const msg = { actions: [{ kind: 'check' }, { kind: 'fold' }] }
    const decision = computeSafetyAction({ prefer: 'check', fallback: 'fold' }, msg)
    expect(decision.kind).toBe('check')
    expect(decision.amount).toBe(null)
    expect(decision.reasoning).toBe('safety default')
  })

  it('falls back when prefer is not available', () => {
    const msg = { actions: [{ kind: 'fold' }, { kind: 'call' }] }
    const decision = computeSafetyAction({ prefer: 'check', fallback: 'fold' }, msg)
    expect(decision.kind).toBe('fold')
    expect(decision.amount).toBe(null)
    expect(decision.reasoning).toBe('safety default')
  })
})

// ─── Message routing (on_message walker) ─────────────────────────────────────

describe('message routing (first-match-wins)', () => {
  const rules = [
    { match: { type: 'welcome' }, class: 'setup', extract: { my_seat: 'seat' } },
    {
      match: { type: 'game_state' },
      class: 'actionable',
      when: [
        { field: 'turn', equals_var: 'my_seat' },
        { field: 'actions', not_empty: true },
      ],
      extract: { seq: 'seq', turn_token: 'turn_token' },
    },
    { match: { type: 'game_state' }, class: 'informational' },
    { match: { type: 'ack' }, class: 'informational' },
    { match: { type: 'error' }, class: 'error', retry_codes: ['INVALID_ACTION', 'STALE_SEQ'] },
    { match: { type: 'hand_complete' }, class: 'informational' },
    { match: { type: 'table_status' }, class: 'terminal', when: [{ field: 'status', equals: 'ended' }] },
    { match: { type: 'table_status' }, class: 'informational' },
  ]

  function routeMessage(
    msg: Record<string, unknown>,
    vars: Map<string, unknown>,
  ): { class: string; extracted?: Record<string, string> } | null {
    for (const rule of rules) {
      if (!matchMessage(rule.match, msg)) continue
      const when = (rule as Record<string, unknown>).when as Array<Record<string, unknown>> | undefined
      if (when && !evaluateWhen(when, msg, vars)) continue

      if (rule.extract)
        extractAll(msg, rule.extract as Record<string, string>, vars)

      return { class: rule.class, extracted: rule.extract as Record<string, string> | undefined }
    }
    return null
  }

  it('routes welcome as setup', () => {
    const vars = new Map<string, unknown>()
    const result = routeMessage({ type: 'welcome', seat: 2, timeout: 30000 }, vars)
    expect(result?.class).toBe('setup')
    expect(vars.get('my_seat')).toBe(2)
  })

  it('routes game_state as actionable when it is my turn', () => {
    const vars = new Map<string, unknown>([['my_seat', 1]])
    const result = routeMessage({
      type: 'game_state',
      turn: 1,
      actions: [{ kind: 'fold' }, { kind: 'check' }],
      seq: 10,
      turn_token: 'tok-xyz',
    }, vars)
    expect(result?.class).toBe('actionable')
    expect(vars.get('seq')).toBe(10)
    expect(vars.get('turn_token')).toBe('tok-xyz')
  })

  it('routes game_state as informational when not my turn', () => {
    const vars = new Map<string, unknown>([['my_seat', 1]])
    const result = routeMessage({
      type: 'game_state',
      turn: 0,
      actions: [{ kind: 'fold' }],
      seq: 11,
    }, vars)
    expect(result?.class).toBe('informational')
  })

  it('routes game_state as informational when no actions', () => {
    const vars = new Map<string, unknown>([['my_seat', 1]])
    const result = routeMessage({
      type: 'game_state',
      turn: 1,
      actions: [],
      seq: 12,
    }, vars)
    expect(result?.class).toBe('informational')
  })

  it('routes ack as informational', () => {
    const vars = new Map<string, unknown>()
    const result = routeMessage({ type: 'ack', seq: 5 }, vars)
    expect(result?.class).toBe('informational')
  })

  it('routes error as error', () => {
    const vars = new Map<string, unknown>()
    const result = routeMessage({ type: 'error', code: 'INVALID_ACTION' }, vars)
    expect(result?.class).toBe('error')
  })

  it('routes table_status ended as terminal', () => {
    const vars = new Map<string, unknown>()
    const result = routeMessage({ type: 'table_status', status: 'ended' }, vars)
    expect(result?.class).toBe('terminal')
  })

  it('routes table_status waiting as informational', () => {
    const vars = new Map<string, unknown>()
    const result = routeMessage({ type: 'table_status', status: 'waiting' }, vars)
    expect(result?.class).toBe('informational')
  })

  it('routes hand_complete as informational', () => {
    const vars = new Map<string, unknown>()
    const result = routeMessage({ type: 'hand_complete', hand: 1 }, vars)
    expect(result?.class).toBe('informational')
  })
})
