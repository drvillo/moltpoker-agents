import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createAgentPlan } from '@drvillo/moltpoker-agents'

import {
  LiveSimulator,
  ReplaySimulator,
  exportEvents,
  SimulationHarness,
  parseAgentSlots,
} from '../src/index.js'
import type {
  LiveSimulatorOptions,
  LiveSimulatorResult,
  ReplayOptions,
  ReplayResult,
  HarnessConfig,
  HarnessAgentConfig,
  HandSummary,
  SimulationResult,
} from '../src/index.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Minimal TABLE_STARTED event payload */
function tableStartedEvent(seq: number, seed?: string) {
  return {
    seq,
    type: 'TABLE_STARTED',
    payload: {
      config: {
        blinds: { small: 1, big: 2 },
        maxSeats: 9,
        initialStack: 1000,
        actionTimeoutMs: 30000,
        ...(seed ? { seed } : {}),
      },
    },
  }
}

function playerJoinedEvent(seq: number, seatId: number, agentId: string) {
  return {
    seq,
    type: 'PLAYER_JOINED',
    payload: { seatId, agentId, agentName: agentId, stack: 1000 },
  }
}

function handStartEvent(seq: number, handNumber: number) {
  return { seq, type: 'HAND_START', payload: { handNumber }, handNumber }
}

function playerActionEvent(
  seq: number,
  seatId: number,
  kind: string,
  actionId: string,
  amount?: number,
) {
  return {
    seq,
    type: 'PLAYER_ACTION',
    payload: { seatId, actionId, kind, ...(amount !== undefined ? { amount } : {}) },
  }
}

function handCompleteEvent(seq: number, handNumber: number) {
  return {
    seq,
    type: 'HAND_COMPLETE',
    payload: { handNumber, results: [], finalPots: [], communityCards: [], showdown: false },
    handNumber,
  }
}

/**
 * Build a minimal valid event sequence: 2 players, 1 hand where seat 1 folds preflop.
 * With seed "test-seed", dealer=0, SB=1, BB=0, first to act=1.
 */
function buildMinimalEventSequence() {
  return [
    tableStartedEvent(1, 'test-seed'),
    playerJoinedEvent(2, 0, 'agent-0'),
    playerJoinedEvent(3, 1, 'agent-1'),
    handStartEvent(4, 1),
    playerActionEvent(5, 1, 'fold', 'action-001'),
    handCompleteEvent(6, 1),
  ]
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('parseAgentSlots', () => {
  it('should parse plain types', () => {
    expect(parseAgentSlots('random,tight,callstation')).toEqual([
      { type: 'random' },
      { type: 'tight' },
      { type: 'callstation' },
    ])
  })

  it('should parse compact syntax with inline model', () => {
    expect(parseAgentSlots('llm:openai:gpt-4.1,llm:anthropic:claude-sonnet-4-5')).toEqual([
      { type: 'llm', model: 'openai:gpt-4.1' },
      { type: 'llm', model: 'anthropic:claude-sonnet-4-5' },
    ])
  })

  it('should parse mixed slots', () => {
    expect(parseAgentSlots('llm,protocol:anthropic:claude,random')).toEqual([
      { type: 'llm' },
      { type: 'protocol', model: 'anthropic:claude' },
      { type: 'random' },
    ])
  })
})

describe('cli-to-factory adaptation', () => {
  it('adapts compact slot syntax into factory plans', () => {
    const slots = parseAgentSlots('protocol:openai:gpt-5-mini,random')
    const skillUrl = 'http://localhost:9000/skill.md'

    const plans = slots.map((slot, idx) => createAgentPlan({
      type: slot.type,
      model: slot.model,
      skillUrl,
      skillDocPath: 'public/skill.md',
      simulationBaseName: `Validator${idx}`,
    }))

    expect(plans[0]?.type).toBe('protocol')
    expect(plans[0]?.model).toBe('openai:gpt-5-mini')
    expect(plans[1]?.type).toBe('random')
  })
})

describe('Module exports regression', () => {
  it('should export LiveSimulator class', () => {
    expect(LiveSimulator).toBeDefined()
    expect(typeof LiveSimulator).toBe('function')
  })

  it('should export ReplaySimulator class', () => {
    expect(ReplaySimulator).toBeDefined()
    expect(typeof ReplaySimulator).toBe('function')
  })

  it('should export exportEvents function', () => {
    expect(exportEvents).toBeDefined()
    expect(typeof exportEvents).toBe('function')
  })

  it('should export SimulationHarness class', () => {
    expect(SimulationHarness).toBeDefined()
    expect(typeof SimulationHarness).toBe('function')
  })

  it('should allow type usage of LiveSimulatorOptions and LiveSimulatorResult', () => {
    // Type-level regression: these types must be importable and usable
    const opts: LiveSimulatorOptions = {
      serverUrl: 'http://localhost:3000',
      agentCount: 2,
      agentSlots: [{ type: 'random' }],
      handsToPlay: 1,
    }
    expect(opts.serverUrl).toBe('http://localhost:3000')

    // LiveSimulatorResult shape
    const result: LiveSimulatorResult = {
      handsPlayed: 0,
      duration: 0,
      agentResults: [],
      errors: [],
    }
    expect(result.handsPlayed).toBe(0)
  })

  it('should allow type usage of ReplayOptions and ReplayResult', () => {
    const opts: ReplayOptions = { eventsPath: '/tmp/test.json' }
    expect(opts.eventsPath).toBe('/tmp/test.json')

    const result: ReplayResult = {
      success: true,
      handsReplayed: 0,
      errors: [],
      chipConservationViolations: [],
      illegalStateTransitions: [],
    }
    expect(result.success).toBe(true)
  })

  it('should allow type usage of HarnessConfig, HandSummary, SimulationResult', () => {
    // Verify these types exist and are structurally sound
    const summary: HandSummary = {
      handNumber: 1,
      totalChipsBefore: 2000,
      totalChipsAfter: 2000,
      playerStacks: [{ seatId: 0, stack: 1000 }],
      actionsPlayed: 5,
      phase: 'ended',
    }
    expect(summary.handNumber).toBe(1)

    const simResult: SimulationResult = {
      hands: [summary],
      totalHands: 1,
      errors: [],
    }
    expect(simResult.totalHands).toBe(1)
  })
})

describe('LiveSimulator construction', () => {
  it('should construct with valid options', () => {
    const simulator = new LiveSimulator({
      serverUrl: 'http://localhost:3000',
      agentCount: 4,
      agentSlots: [{ type: 'random' }, { type: 'tight' }],
      handsToPlay: 10,
    })
    expect(simulator).toBeInstanceOf(LiveSimulator)
  })

  it('should construct with optional tableConfig', () => {
    const simulator = new LiveSimulator({
      serverUrl: 'http://localhost:3000',
      agentCount: 2,
      agentSlots: [{ type: 'random' }],
      handsToPlay: 5,
      tableConfig: {
        blinds: { small: 5, big: 10 },
        initialStack: 2000,
        actionTimeoutMs: 10000,
      },
    })
    expect(simulator).toBeInstanceOf(LiveSimulator)
  })

  it('should not throw when calling stop() on a fresh instance', () => {
    const simulator = new LiveSimulator({
      serverUrl: 'http://localhost:3000',
      agentCount: 2,
      agentSlots: [{ type: 'random' }],
      handsToPlay: 1,
    })
    expect(() => simulator.stop()).not.toThrow()
  })
})

describe('LiveSimulator admin-create payload', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('sets minPlayersToStart equal to agentCount', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ tables: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'tbl_test' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      })

    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(LiveSimulator.prototype as any, 'spawnAgent').mockResolvedValue(undefined)
    vi.spyOn(LiveSimulator.prototype as any, 'waitForTableAutoStart').mockResolvedValue(undefined)
    vi.spyOn(LiveSimulator.prototype as any, 'waitForHandCompletion').mockResolvedValue(1)

    const simulator = new LiveSimulator({
      serverUrl: 'http://localhost:9000',
      agentCount: 4,
      agentSlots: [{ type: 'random' }],
      handsToPlay: 1,
      useAutoJoin: false,
    })

    await simulator.run()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9000/v1/admin/tables',
      expect.objectContaining({
        method: 'POST',
      }),
    )

    const createCall = fetchMock.mock.calls.find((call) => call[0] === 'http://localhost:9000/v1/admin/tables')
    const requestBody = JSON.parse(String(createCall?.[1]?.body))
    expect(requestBody.config.maxSeats).toBe(4)
    expect(requestBody.config.minPlayersToStart).toBe(4)
  })
})

describe('ReplaySimulator', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'moltpoker-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should return error for empty events file', () => {
    const filePath = join(tmpDir, 'empty.json')
    writeFileSync(filePath, '[]')

    const simulator = new ReplaySimulator({ eventsPath: filePath })
    const result = simulator.run()

    expect(result.success).toBe(false)
    expect(result.errors).toContain('No events found in file')
  })

  it('should return error when TABLE_STARTED is missing', () => {
    const events = [
      playerJoinedEvent(1, 0, 'agent-0'),
      playerJoinedEvent(2, 1, 'agent-1'),
    ]
    const filePath = join(tmpDir, 'no-start.json')
    writeFileSync(filePath, JSON.stringify(events))

    const simulator = new ReplaySimulator({ eventsPath: filePath })
    const result = simulator.run()

    expect(result.success).toBe(false)
    expect(result.errors).toContain('No TABLE_STARTED event found')
  })

  it('should replay a valid JSON event sequence', () => {
    const events = buildMinimalEventSequence()
    const filePath = join(tmpDir, 'valid.json')
    writeFileSync(filePath, JSON.stringify(events))

    const simulator = new ReplaySimulator({ eventsPath: filePath })
    const result = simulator.run()

    expect(result.success).toBe(true)
    expect(result.handsReplayed).toBe(1)
    expect(result.errors).toHaveLength(0)
    expect(result.chipConservationViolations).toHaveLength(0)
    expect(result.illegalStateTransitions).toHaveLength(0)
  })

  it('should replay a valid JSONL event sequence', () => {
    const events = buildMinimalEventSequence()
    const filePath = join(tmpDir, 'valid.jsonl')
    const jsonlContent = events.map((e) => JSON.stringify(e)).join('\n')
    writeFileSync(filePath, jsonlContent)

    const simulator = new ReplaySimulator({ eventsPath: filePath })
    const result = simulator.run()

    expect(result.success).toBe(true)
    expect(result.handsReplayed).toBe(1)
  })

  it('should verify chip conservation on a valid sequence', () => {
    const events = buildMinimalEventSequence()
    const filePath = join(tmpDir, 'verify.json')
    writeFileSync(filePath, JSON.stringify(events))

    const simulator = new ReplaySimulator({ eventsPath: filePath, verify: true })
    const result = simulator.run()

    expect(result.success).toBe(true)
    expect(result.chipConservationViolations).toHaveLength(0)
  })
})

describe('exportEvents', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'moltpoker-export-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should write events as JSONL', () => {
    const events = [
      {
        id: 1,
        table_id: 'test-table',
        seq: 1,
        hand_number: null,
        type: 'TABLE_STARTED' as const,
        payload: {
          config: {
            blinds: { small: 1, big: 2 },
            maxSeats: 9,
            initialStack: 1000,
            actionTimeoutMs: 30000,
          },
        },
        created_at: new Date('2025-01-01'),
      },
      {
        id: 2,
        table_id: 'test-table',
        seq: 2,
        hand_number: null,
        type: 'PLAYER_JOINED' as const,
        payload: { seatId: 0, agentId: 'a1', agentName: 'Agent 1', stack: 1000 },
        created_at: new Date('2025-01-01'),
      },
    ]

    const filePath = join(tmpDir, 'events.jsonl')
    exportEvents(events as any, filePath)

    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n').filter((l) => l.trim())
    expect(lines).toHaveLength(2)

    const parsed0 = JSON.parse(lines[0]!)
    expect(parsed0.type).toBe('TABLE_STARTED')

    const parsed1 = JSON.parse(lines[1]!)
    expect(parsed1.type).toBe('PLAYER_JOINED')
  })

  it('should produce output readable by ReplaySimulator', () => {
    // Build EventRecord-shaped events that are also valid ParsedEvents when re-read
    const events = [
      {
        id: 1,
        table_id: 't1',
        seq: 1,
        hand_number: null,
        type: 'TABLE_STARTED' as const,
        payload: {
          config: {
            blinds: { small: 1, big: 2 },
            maxSeats: 9,
            initialStack: 1000,
            actionTimeoutMs: 30000,
            seed: 'round-trip-seed',
          },
        },
        created_at: new Date('2025-01-01'),
      },
      {
        id: 2,
        table_id: 't1',
        seq: 2,
        hand_number: null,
        type: 'PLAYER_JOINED' as const,
        payload: { seatId: 0, agentId: 'a0', agentName: 'A0', stack: 1000 },
        created_at: new Date('2025-01-01'),
      },
      {
        id: 3,
        table_id: 't1',
        seq: 3,
        hand_number: null,
        type: 'PLAYER_JOINED' as const,
        payload: { seatId: 1, agentId: 'a1', agentName: 'A1', stack: 1000 },
        created_at: new Date('2025-01-01'),
      },
      {
        id: 4,
        table_id: 't1',
        seq: 4,
        hand_number: 1,
        type: 'HAND_START' as const,
        payload: { handNumber: 1 },
        created_at: new Date('2025-01-01'),
      },
      {
        id: 5,
        table_id: 't1',
        seq: 5,
        hand_number: 1,
        type: 'PLAYER_ACTION' as const,
        payload: { seatId: 1, actionId: 'act-001', kind: 'fold' },
        created_at: new Date('2025-01-01'),
      },
      {
        id: 6,
        table_id: 't1',
        seq: 6,
        hand_number: 1,
        type: 'HAND_COMPLETE' as const,
        payload: { handNumber: 1, results: [], finalPots: [], communityCards: [], showdown: false },
        created_at: new Date('2025-01-01'),
      },
    ]

    const filePath = join(tmpDir, 'round-trip.jsonl')
    exportEvents(events as any, filePath)

    const simulator = new ReplaySimulator({ eventsPath: filePath, verify: true })
    const result = simulator.run()

    expect(result.success).toBe(true)
    expect(result.handsReplayed).toBe(1)
    expect(result.chipConservationViolations).toHaveLength(0)
  })
})
