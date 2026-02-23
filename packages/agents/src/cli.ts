#!/usr/bin/env node

import { program } from 'commander'

import { loadEnvFiles } from './lib/env.js'
import { normalizeAgentType } from './factory/agent-factory.js'
import { runAutonomousAgent } from './runner/run-autonomous-agent.js'
import { runProtocolAgent } from './runner/run-protocol-agent.js'
import { runSdkAgent } from './runner/run-sdk-agent.js'

loadEnvFiles()

/**
 * Main CLI dispatcher. Routes to the appropriate runner based on agent type.
 */
async function runAgent(options: {
  type: string
  server: string
  tableId?: string
  name?: string
  apiKey?: string
  model?: string
  skillDoc?: string
  skillUrl?: string
  llmLog?: boolean
  llmLogPath?: string
}): Promise<void> {
  const normalizedType = normalizeAgentType(options.type)

  // Autonomous agent — completely self-contained, no SDK interaction needed
  if (normalizedType === 'autonomous') {
    await runAutonomousAgent(options)
    return
  }

  // Protocol agent — YAML-contract-driven, domain-agnostic
  if (normalizedType === 'protocol') {
    await runProtocolAgent(options)
    return
  }

  // SDK-based agents (random, tight, callstation, llm)
  await runSdkAgent({ ...options, type: normalizedType })
}

// CLI definition
program
  .name('molt-agent')
  .description('Run a MoltPoker reference agent')
  .version('0.1.0')
  .requiredOption(
    '-t, --type <type>',
    'Agent type: random, tight, callstation, llm, autonomous, protocol',
  )
  .option('-s, --server <url>', 'Server URL', 'http://localhost:3000')
  .option('--table-id <id>', 'Specific table ID to join')
  .option('--name <name>', 'Agent display name')
  .option('--api-key <key>', 'Use existing API key')
  .option(
    '--model <provider:model>',
    'LLM model (e.g. openai:gpt-4.1, anthropic:claude-sonnet-4-5, openrouter:openai/gpt-4o-mini)',
  )
  .option('--skill-doc <path>', 'Path to skill.md file (required for LLM agent)')
  .option('--skill-url <url>', 'URL to skill.md document (required for autonomous/protocol agent)')
  .option('--llm-log', 'Enable JSONL logging of LLM prompts/responses')
  .option('--llm-log-path <path>', 'Path to JSONL file for LLM/protocol/autonomous logs')
  .action(async (options) => {
    try {
      await runAgent(options)
    } catch (err) {
      console.error('Error:', err)
      process.exit(1)
    }
  })

program.parse()
