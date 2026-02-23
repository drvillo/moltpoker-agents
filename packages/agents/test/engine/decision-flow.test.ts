import { describe, it, expect, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'

import {
  buildZodSchema,
  createEngineContext,
  llmDecide,
  wsSend,
} from '../../src/engine/protocol-engine.js'

const decisionSchemaJson = {
  type: 'object',
  required: ['reasoning', 'kind', 'amount'],
  properties: {
    reasoning: { type: 'string' },
    kind: { type: 'string', enum: ['fold', 'check', 'call', 'raiseTo'] },
    amount: { type: ['integer', 'null'] },
  },
} as const

function makeDecisionModel(decision: { reasoning: string; kind: string; amount: number | null }) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(decision) }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
      },
      warnings: [],
    }),
  })
}

describe('protocol-engine decision flow', () => {
  it('llmDecide returns a typed decision without mutating ctx vars', async () => {
    const model = makeDecisionModel({ reasoning: 'free action', kind: 'check', amount: null })
    const ctx = createEngineContext({ model })
    ctx.prose = 'Play poker.'
    ctx.decisionSchema = buildZodSchema(decisionSchemaJson)

    const decision = await llmDecide(
      { type: 'game_state', seq: 12, turn: 1, actions: [{ kind: 'check' }] },
      ctx,
    )

    expect(decision).toEqual({ reasoning: 'free action', kind: 'check', amount: null })
    expect(ctx.vars.has('reasoning')).toBe(false)
    expect(ctx.vars.has('kind')).toBe(false)
    expect(ctx.vars.has('amount')).toBe(false)
  })

  it('wsSend interpolates template and omits null amount', () => {
    const send = vi.fn()
    const ctx = createEngineContext({ model: makeDecisionModel({ reasoning: 'n/a', kind: 'fold', amount: null }) })
    ctx.ws = { send } as unknown as WebSocket

    ctx.vars.set('turn_token', 'turn-123')
    ctx.vars.set('kind', 'call')
    ctx.vars.set('amount', null)
    ctx.vars.set('seq', 99)

    wsSend({
      type: 'action',
      action: {
        turn_token: '{turn_token}',
        kind: '{kind}',
        amount: '{amount}',
      },
      expected_seq: '{seq}',
    }, ctx)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(JSON.stringify({
      type: 'action',
      action: {
        turn_token: 'turn-123',
        kind: 'call',
      },
      expected_seq: 99,
    }))
  })
})
