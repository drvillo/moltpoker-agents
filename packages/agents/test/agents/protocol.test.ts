import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'

import { ProtocolAgent, buildDefaultFallbackDecision } from '../../src/agents/protocol.js'

const skillUrl = 'https://example.test/skill.md'

const { MockWebSocket } = vi.hoisted(() => {
  class MockWebSocket {
    static OPEN = 1
    static CLOSED = 3
    static instances: MockWebSocket[] = []

    readonly url: string
    readyState = MockWebSocket.OPEN
    sent: string[] = []
    private listeners = new Map<string, Array<(event: unknown) => void>>()

    constructor(url: string) {
      this.url = url
      MockWebSocket.instances.push(this)
      queueMicrotask(() => this.emit('open', {}))
    }

    addEventListener(type: string, listener: (event: unknown) => void) {
      const current = this.listeners.get(type) ?? []
      this.listeners.set(type, [...current, listener])
    }

    send(data: string) {
      this.sent.push(data)
    }

    close() {
      this.readyState = MockWebSocket.CLOSED
      this.emit('close', {})
    }

    emit(type: string, event: unknown) {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event)
      }
    }
  }
  return { MockWebSocket }
})

vi.mock('ws', () => ({ default: MockWebSocket }))

function makeModel(config: { shouldThrow?: boolean; decision?: { reasoning: string; kind: string; amount: number | null } }) {
  if (config.shouldThrow) {
    return new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error('llm failed')
      },
    })
  }

  const decision = config.decision ?? { reasoning: 'standard action', kind: 'call', amount: null }
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

function buildSkillDoc(options: { includeSafety: boolean }) {
  const safetyBlock = options.includeSafety
    ? `
    safety:
      prefer: check
      fallback: fold`
    : ''

  return `---
name: protocol-test
protocol:
  version: "1.0"
  websocket:
    url: "ws://test.local/ws"
    on_message:
      - match: { type: welcome }
        class: setup
        extract:
          my_seat: "seat"
      - match: { type: game_state }
        class: actionable
        when:
          - field: turn
            equals_var: my_seat
          - field: actions
            not_empty: true
        extract:
          seq: "seq"
          turn_token: "turn_token"
      - match: { type: table_status }
        class: terminal
        when:
          - field: status
            equals: ended
  decision:
    schema:
      type: object
      required: ["reasoning", "kind"]
      properties:
        reasoning:
          type: string
        kind:
          type: string
          enum: ["fold", "check", "call", "raiseTo"]
        amount:
          type: ["integer", "null"]
    action_template:
      type: action
      action:
        turn_token: "{turn_token}"
        kind: "{kind}"
        amount: "{amount}"
      expected_seq: "{seq}"${safetyBlock}
---
Protocol test prompt`
}

function getSocket() {
  const socket = MockWebSocket.instances.at(-1)
  if (!socket) throw new Error('expected websocket instance')
  return socket
}

describe('ProtocolAgent actionable flow', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    MockWebSocket.instances = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = originalFetch
  })

  it('sends exactly one action on actionable message when llmDecide succeeds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(buildSkillDoc({ includeSafety: true })))
    const agent = new ProtocolAgent({ model: makeModel({ decision: { reasoning: 'good spot', kind: 'call', amount: null } }) })
    const runPromise = agent.run(skillUrl, 'test-agent')

    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1))
    const socket = getSocket()

    socket.emit('message', { data: JSON.stringify({ type: 'welcome', seat: 2 }) })
    socket.emit('message', {
      data: JSON.stringify({
        type: 'game_state',
        turn: 2,
        actions: [{ kind: 'fold' }, { kind: 'call' }],
        seq: 7,
        turn_token: 'token-7',
      }),
    })

    await vi.waitFor(() => expect(socket.sent.length).toBe(1))
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: 'action',
      action: { turn_token: 'token-7', kind: 'call' },
      expected_seq: 7,
    })

    socket.emit('message', { data: JSON.stringify({ type: 'table_status', status: 'ended' }) })
    await runPromise
  })

  it('uses safety fallback when llmDecide fails and safety is configured', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(buildSkillDoc({ includeSafety: true })))
    const agent = new ProtocolAgent({ model: makeModel({ shouldThrow: true }) })
    const runPromise = agent.run(skillUrl, 'test-agent')

    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1))
    const socket = getSocket()

    socket.emit('message', { data: JSON.stringify({ type: 'welcome', seat: 1 }) })
    socket.emit('message', {
      data: JSON.stringify({
        type: 'game_state',
        turn: 1,
        actions: [{ kind: 'check' }, { kind: 'fold' }],
        seq: 8,
        turn_token: 'token-8',
      }),
    })

    await vi.waitFor(() => expect(socket.sent.length).toBe(1))
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: 'action',
      action: { turn_token: 'token-8', kind: 'check' },
      expected_seq: 8,
    })

    socket.emit('message', { data: JSON.stringify({ type: 'table_status', status: 'ended' }) })
    await runPromise
  })

  it('on llm failure without safety config, still records a fallback reasoning string', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(buildSkillDoc({ includeSafety: false })))
    const agent = new ProtocolAgent({ model: makeModel({ shouldThrow: true }) })
    const runPromise = agent.run(skillUrl, 'test-agent')

    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1))
    const socket = getSocket()

    socket.emit('message', { data: JSON.stringify({ type: 'welcome', seat: 4 }) })
    socket.emit('message', {
      data: JSON.stringify({
        type: 'game_state',
        turn: 4,
        actions: [{ kind: 'fold' }],
        seq: 9,
        turn_token: 'token-9',
      }),
    })

    await vi.waitFor(() => expect(socket.sent.length).toBe(1))
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: 'action',
      action: { turn_token: 'token-9', kind: 'fold' },
      expected_seq: 9,
    })

    socket.emit('message', { data: JSON.stringify({ type: 'table_status', status: 'ended' }) })
    await runPromise
  })

  it('buildDefaultFallbackDecision includes reasoning metadata', () => {
    const decision = buildDefaultFallbackDecision()
    expect(decision).toEqual({
      kind: 'fold',
      amount: null,
      reasoning: 'default fallback after llm failure',
    })
  })
})
