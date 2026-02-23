import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { GameStatePayload, LegalAction } from '@moltpoker/shared'

import { LlmAgent, formatGameState } from '../../src/agents/llm.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeGameState(overrides?: Partial<GameStatePayload>): GameStatePayload {
  return {
    tableId: 'tbl-test',
    handNumber: 5,
    phase: 'flop',
    communityCards: [
      { rank: 'A', suit: 's' },
      { rank: 'K', suit: 'h' },
      { rank: '7', suit: 'd' },
    ],
    pots: [{ amount: 100, eligibleSeats: [0, 3] }],
    players: [
      {
        seatId: 0,
        agentId: 'agent-0',
        agentName: 'Opponent',
        stack: 950,
        bet: 25,
        folded: false,
        allIn: false,
        isActive: true,
        holeCards: null,
      },
      {
        seatId: 3,
        agentId: 'agent-3',
        agentName: 'MyAgent',
        stack: 925,
        bet: 25,
        folded: false,
        allIn: false,
        isActive: true,
        holeCards: [
          { rank: 'A', suit: 'c' },
          { rank: 'Q', suit: 'h' },
        ],
      },
    ],
    dealerSeat: 0,
    currentSeat: 3,
    lastAction: { seatId: 0, kind: 'raiseTo', amount: 25 },
    legalActions: [
      { kind: 'fold' },
      { kind: 'call' },
      { kind: 'raiseTo', minAmount: 50, maxAmount: 925 },
    ],
    toCall: 0,
    seq: 42,
    turn_token: 'test-turn-token-123',
    ...overrides,
  }
}

const defaultLegalActions: LegalAction[] = [
  { kind: 'fold' },
  { kind: 'call' },
  { kind: 'raiseTo', minAmount: 50, maxAmount: 925 },
]

// ─── Helper: create mock model that returns a specific decision ──────────────

function mockModel(decision: { reasoning: string; kind: string; amount?: number }) {
  const normalizedDecision = {
    ...decision,
    amount: decision.amount ?? null,
  }
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(normalizedDecision) }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      },
      warnings: [],
    }),
  })
}

// ─── Tests: formatGameState ──────────────────────────────────────────────────

describe('formatGameState', () => {
  it('should include hand number, phase, and pot', () => {
    const state = makeGameState()
    const prompt = formatGameState(state, defaultLegalActions)

    expect(prompt).toContain('Hand #5')
    expect(prompt).toContain('Phase: flop')
    expect(prompt).toContain('Pot: 100')
  })

  it('should include community cards', () => {
    const state = makeGameState()
    const prompt = formatGameState(state, defaultLegalActions)

    expect(prompt).toContain('Community: As Kh 7d')
  })

  it('should include hole cards for our seat', () => {
    const state = makeGameState()
    const prompt = formatGameState(state, defaultLegalActions)

    expect(prompt).toContain('Your cards: Ac Qh')
  })

  it('should include player info with YOU marker', () => {
    const state = makeGameState()
    const prompt = formatGameState(state, defaultLegalActions)

    expect(prompt).toContain('Seat 3 (YOU)')
    expect(prompt).toContain('Seat 0:')
    expect(prompt).not.toContain('Seat 0 (YOU)')
  })

  it('should list all legal actions', () => {
    const state = makeGameState()
    const prompt = formatGameState(state, defaultLegalActions)

    expect(prompt).toContain('- fold')
    expect(prompt).toContain('- call')
    expect(prompt).toContain('- raiseTo (min: 50, max: 925)')
  })

  it('should handle empty community cards', () => {
    const state = makeGameState({ communityCards: [], phase: 'preflop' })
    const prompt = formatGameState(state, defaultLegalActions)

    expect(prompt).toContain('Community: none')
    expect(prompt).toContain('Phase: preflop')
  })
})

// ─── Tests: raw action passthrough (no client-side validation) ──────────────

describe('LlmAgent action passthrough', () => {
  let tmpDir: string
  let skillDocPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'moltpoker-passthrough-'))
    skillDocPath = join(tmpDir, 'skill.md')
    writeFileSync(skillDocPath, '# Test Skill Doc\nYou are a poker agent.')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should pass through raiseTo amount without clamping (above max)', async () => {
    const agent = new LlmAgent({
      model: mockModel({ reasoning: 'all in', kind: 'raiseTo', amount: 9999 }),
      skillDocPath,
    })
    const action = await agent.getAction(makeGameState(), defaultLegalActions)

    expect(action.kind).toBe('raiseTo')
    expect(action.amount).toBe(9999) // NOT clamped -- server validates
  })

  it('should pass through raiseTo amount without clamping (below min)', async () => {
    const agent = new LlmAgent({
      model: mockModel({ reasoning: 'tiny raise', kind: 'raiseTo', amount: 5 }),
      skillDocPath,
    })
    const action = await agent.getAction(makeGameState(), defaultLegalActions)

    expect(action.kind).toBe('raiseTo')
    expect(action.amount).toBe(5) // NOT clamped -- server validates
  })

  it('should pass through illegal action kind without fallback', async () => {
    const agent = new LlmAgent({
      model: mockModel({ reasoning: 'check please', kind: 'check' }),
      skillDocPath,
    })

    // Legal actions don't include check -- agent sends it anyway, server rejects
    const legalActions: LegalAction[] = [{ kind: 'fold' }, { kind: 'call' }]
    const action = await agent.getAction(makeGameState({ legalActions }), legalActions)

    expect(action.kind).toBe('check') // Raw passthrough, no fallback
  })

  it('should throw on LLM API failure instead of returning fallback', async () => {
    const errorModel = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error('API rate limit exceeded')
      },
    })

    const agent = new LlmAgent({ model: errorModel, skillDocPath })
    await expect(
      agent.getAction(makeGameState(), defaultLegalActions),
    ).rejects.toThrow('API rate limit exceeded')
  })

  it('should include previousError in the prompt on retry', async () => {
    let capturedPrompt = ''
    const capturingModel = new MockLanguageModelV3({
      doGenerate: async (opts) => {
        // Capture the user prompt
        for (const msg of opts.prompt) {
          if (msg.role === 'user') {
            for (const part of msg.content) {
              if (part.type === 'text') capturedPrompt = part.text
            }
          }
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ reasoning: 'ok', kind: 'fold', amount: null }) }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 20, text: 20, reasoning: undefined },
          },
          warnings: [],
        }
      },
    })

    const agent = new LlmAgent({ model: capturingModel, skillDocPath })
    await agent.getAction(makeGameState(), defaultLegalActions, 'Raise amount cannot exceed 925')

    expect(capturedPrompt).toContain('[RETRY]')
    expect(capturedPrompt).toContain('Raise amount cannot exceed 925')
  })
})

// ─── Tests: LlmAgent ────────────────────────────────────────────────────────

describe('LlmAgent', () => {
  let tmpDir: string
  let skillDocPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'moltpoker-llm-test-'))
    skillDocPath = join(tmpDir, 'skill.md')
    writeFileSync(skillDocPath, '# Test Skill Doc\nYou are a poker agent.')
  })

  it('should throw when skillDocPath is missing', () => {
    expect(() => {
      new LlmAgent({
        model: mockModel({ reasoning: 'test', kind: 'fold' }),
      })
    }).toThrow('skillDocPath')
  })

  it('should throw when skill doc file does not exist', () => {
    const missingPath = join(tmpDir, 'missing-skill.md')
    expect(() => {
      new LlmAgent({
        model: mockModel({ reasoning: 'test', kind: 'fold' }),
        skillDocPath: missingPath,
      })
    }).toThrow('Skill doc not found')
  })

  it('should load skill.md as system prompt and include model ID in name', () => {
    const agent = new LlmAgent({
      model: mockModel({ reasoning: 'test', kind: 'fold' }),
      skillDocPath,
    })
    expect(agent.name).toContain('LlmAgent')
    expect(agent.name).toContain('(')
    expect(agent.name).toContain(')')
  })

  it('should accept a custom name and include model ID', () => {
    const agent = new LlmAgent({
      model: mockModel({ reasoning: 'test', kind: 'fold' }),
      skillDocPath,
      name: 'CustomBot',
    })
    expect(agent.name).toContain('CustomBot')
    expect(agent.name).toContain('(')
    expect(agent.name).toContain(')')
  })

  it('should return a valid fold action from LLM', async () => {
    const agent = new LlmAgent({
      model: mockModel({ reasoning: 'weak hand, folding', kind: 'fold' }),
      skillDocPath,
    })

    const state = makeGameState()
    const action = await agent.getAction(state, defaultLegalActions)

    expect(action.kind).toBe('fold')
    expect(action.turn_token).toBeDefined()
  })

  it('should return a valid call action from LLM', async () => {
    const agent = new LlmAgent({
      model: mockModel({ reasoning: 'good pot odds', kind: 'call' }),
      skillDocPath,
    })

    const state = makeGameState()
    const action = await agent.getAction(state, defaultLegalActions)

    expect(action.kind).toBe('call')
  })

  it('should return a valid raiseTo action from LLM', async () => {
    const agent = new LlmAgent({
      model: mockModel({ reasoning: 'strong hand', kind: 'raiseTo', amount: 200 }),
      skillDocPath,
    })

    const state = makeGameState()
    const action = await agent.getAction(state, defaultLegalActions)

    expect(action.kind).toBe('raiseTo')
    expect(action.amount).toBe(200)
  })

  it('should pass through illegal action kind (server validates)', async () => {
    const agent = new LlmAgent({
      model: mockModel({ reasoning: 'check please', kind: 'check' }),
      skillDocPath,
    })

    // Legal actions don't include check -- raw passthrough, server rejects
    const legalActions: LegalAction[] = [{ kind: 'fold' }, { kind: 'call' }]
    const state = makeGameState({ legalActions })
    const action = await agent.getAction(state, legalActions)

    expect(action.kind).toBe('check')
  })

  it('should throw on LLM API failure (caller handles retry)', async () => {
    const errorModel = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error('API rate limit exceeded')
      },
    })

    const agent = new LlmAgent({ model: errorModel, skillDocPath })
    const legalActions: LegalAction[] = [{ kind: 'check' }, { kind: 'raiseTo', minAmount: 4, maxAmount: 1000 }]
    const state = makeGameState({ legalActions })

    await expect(agent.getAction(state, legalActions)).rejects.toThrow('API rate limit exceeded')
  })

  // Cleanup
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })
})
