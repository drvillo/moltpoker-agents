import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

// Pre-extraction tests referenced `apps/public/skill.md` from the private
// monorepo. Those tests can't run in this standalone repo. Instead, the agents
// package now ships a canonical bundled `skill.md` next to its sources, and
// these tests pin its shape — including the new wording for rate limits,
// waiting-lobby collection reasons, and amount:null handling.

const __dirname = dirname(fileURLToPath(import.meta.url))
const BUNDLED_SKILL_PATH = resolve(__dirname, '..', '..', 'skill.md')

function readBundledSkill(): string {
  return readFileSync(BUNDLED_SKILL_PATH, 'utf-8')
}

describe('Bundled skill.md — structure', () => {
  it('bundled skill.md exists next to package root', () => {
    expect(existsSync(BUNDLED_SKILL_PATH)).toBe(true)
  })

  it('has valid YAML frontmatter', () => {
    const content = readBundledSkill()
    expect(content).toMatch(/^---\n/)
    expect(content).toMatch(/name: moltpoker/)
    expect(content).toMatch(/description:/)
  })

  it('has exactly one Context Policy section', () => {
    const content = readBundledSkill()
    const matches = content.match(/^## Context Policy$/gm)
    expect(matches).toBeTruthy()
    expect(matches?.length).toBe(1)
  })

  it('is a single self-contained skill document', () => {
    const content = readBundledSkill()
    expect(content).not.toContain('references/API.md')
    expect(content).not.toContain('references/WS_MESSAGES.md')
    expect(content).not.toContain('references/pokerbasics.md')
    expect(content).toContain('## Poker Basics')
    expect(content).toContain('## REST API Details')
    expect(content).toContain('## WebSocket Protocol (Agent Format)')
  })

  it('has runner contract metadata in frontmatter', () => {
    const content = readBundledSkill()
    expect(content).toMatch(/runner_contract:/)
    expect(content).toMatch(/document_role:/)
  })

  it('stays under recommended line count (Skills spec)', () => {
    const content = readBundledSkill()
    const lineCount = content.split('\n').length
    expect(lineCount).toBeLessThan(500)
  })
})

describe('Bundled skill.md — Context Policy consolidation', () => {
  it('does not duplicate "read once" instructions outside Context Policy', () => {
    const content = readBundledSkill()
    const policyStart = content.indexOf('## Context Policy')
    const nextSection = content.indexOf('\n## ', policyStart + 1)
    const policySection = content.substring(policyStart, nextSection !== -1 ? nextSection : content.length)
    const restOfDoc = content.substring(0, policyStart) + (nextSection !== -1 ? content.substring(nextSection) : '')
    expect(policySection.toLowerCase()).toContain('read once')
    const outsideMentions = (restOfDoc.match(/do not re-fetch/gi) || []).length
    expect(outsideMentions).toBeLessThanOrEqual(1)
  })

  it('keeps documentRole instruction in Context Policy', () => {
    const content = readBundledSkill()
    const policyStart = content.indexOf('## Context Policy')
    const nextSection = content.indexOf('\n## ', policyStart + 1)
    const policySection = content.substring(policyStart, nextSection !== -1 ? nextSection : content.length)
    expect(policySection).toContain('documentRole')
    expect(policySection).toContain('skill')
  })
})

// R1 / R2 / R3 / R5 — skill.md content must reflect plan-v2 wording.
describe('Bundled skill.md — plan-v2 agent-facing contract', () => {
  it('says agents omit (or send null) amount on non-raise actions', () => {
    const content = readBundledSkill()
    expect(content).toMatch(/omit/i)
    expect(content).toMatch(/raiseTo/)
    // No more "amount:null" blanket instruction for every kind:
    expect(content).toMatch(/only for raiseTo|raiseTo only|only required for raiseTo|positive integer for raiseTo/i)
  })

  it('declares real rate limits (not the old "no enforced rate limits" line)', () => {
    const content = readBundledSkill()
    expect(content).not.toMatch(/no enforced rate limits/i)
    expect(content).toMatch(/1000 requests per minute|1000 per minute/i)
    expect(content).toMatch(/x-ratelimit-limit/i)
    expect(content).toMatch(/\/v1\/auth\/login/)
  })

  it('documents the waiting-table lifecycle and the two collection reasons', () => {
    const content = readBundledSkill()
    expect(content).toMatch(/table_status/)
    expect(content).toMatch(/status:?\s*waiting/i)
    expect(content).toMatch(/status:?\s*ended/i)
    expect(content).toMatch(/waiting_timeout/)
    expect(content).toMatch(/seats_stale/)
    // Hint to call auto-join again on collection:
    expect(content).toMatch(/auto-join/i)
  })

  it('tells agents welcome is sent immediately on waiting-table connect', () => {
    const content = readBundledSkill()
    expect(content).toMatch(/welcome/i)
    expect(content).toMatch(/waiting/i)
  })

  it('names the error payload fields array for self-correction', () => {
    const content = readBundledSkill()
    expect(content).toMatch(/fields\[\]|error\.fields|error fields|fields array/i)
  })
})

