import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

describe('Autonomous Agent - Skill Document Handling', () => {
  describe('Skill document structure', () => {
    it('should have valid YAML frontmatter', () => {
      const skillPath = join(process.cwd(), 'public', 'skill.md')
      expect(existsSync(skillPath)).toBe(true)
      
      const content = readFileSync(skillPath, 'utf-8')
      expect(content).toMatch(/^---\n/)
      expect(content).toMatch(/name: moltpoker/)
      expect(content).toMatch(/description:/)
    })

    it('should have exactly one Context Policy section', () => {
      const skillPath = join(process.cwd(), 'public', 'skill.md')
      const content = readFileSync(skillPath, 'utf-8')
      
      const contextPolicyMatches = content.match(/^## Context Policy$/gm)
      expect(contextPolicyMatches).toBeTruthy()
      expect(contextPolicyMatches?.length).toBe(1)
    })

    it('should be a single self-contained skill document', () => {
      const skillPath = join(process.cwd(), 'public', 'skill.md')
      const content = readFileSync(skillPath, 'utf-8')
      
      expect(content).not.toContain('references/API.md')
      expect(content).not.toContain('references/WS_MESSAGES.md')
      expect(content).not.toContain('references/pokerbasics.md')
      expect(content).toContain('## Poker Basics')
      expect(content).toContain('## REST API Details')
      expect(content).toContain('## WebSocket Protocol (Agent Format)')
    })

    it('should have runner contract metadata in frontmatter', () => {
      const skillPath = join(process.cwd(), 'public', 'skill.md')
      const content = readFileSync(skillPath, 'utf-8')
      
      expect(content).toMatch(/runner_contract:/)
      expect(content).toMatch(/document_role:/)
    })

    it('should stay under recommended line count', () => {
      const skillPath = join(process.cwd(), 'public', 'skill.md')
      const content = readFileSync(skillPath, 'utf-8')
      const lineCount = content.split('\n').length
      
      // Agent Skills spec recommends < 500 lines
      expect(lineCount).toBeLessThan(500)
    })
  })

  describe('Context policy consolidation', () => {
    it('should not have duplicate "read once" instructions outside Context Policy', () => {
      const skillPath = join(process.cwd(), 'public', 'skill.md')
      const content = readFileSync(skillPath, 'utf-8')
      
      // Find the Context Policy section
      const policyStart = content.indexOf('## Context Policy')
      const nextSection = content.indexOf('\n## ', policyStart + 1)
      const policySection = content.substring(policyStart, nextSection !== -1 ? nextSection : content.length)
      const restOfDoc = content.substring(0, policyStart) + (nextSection !== -1 ? content.substring(nextSection) : '')
      
      // Check that "read once" type instructions are primarily in Context Policy
      expect(policySection.toLowerCase()).toContain('read once')
      
      // Allow brief mentions but major policy text should be in the section
      const outsideMentions = (restOfDoc.match(/do not re-fetch/gi) || []).length
      expect(outsideMentions).toBeLessThanOrEqual(1) // At most one brief mention elsewhere
    })

    it('should consolidate documentRole instruction in Context Policy', () => {
      const skillPath = join(process.cwd(), 'public', 'skill.md')
      const content = readFileSync(skillPath, 'utf-8')
      
      const policyStart = content.indexOf('## Context Policy')
      const nextSection = content.indexOf('\n## ', policyStart + 1)
      const policySection = content.substring(policyStart, nextSection !== -1 ? nextSection : content.length)
      
      expect(policySection).toContain('documentRole')
      expect(policySection).toContain('skill')
    })
  })
})
