#!/usr/bin/env node

import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { program } from 'commander';
import dotenv from 'dotenv';
import { createAgentPlan, createJsonlLogger } from '@drvillo/moltpoker-agents';

import { LiveSimulator, parseAgentSlots } from './live.js';
import { ReplaySimulator } from './replay.js';

function findRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(__dirname);
dotenv.config({ path: path.join(repoRoot, '.env') });
dotenv.config({ path: path.join(repoRoot, '.env.local'), override: true });

const defaultPort = process.env.API_PORT || '3000';
const defaultServerUrl = `http://localhost:${defaultPort}`;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

program
  .name('molt-sim')
  .description('MoltPoker simulation and replay tools')
  .version('0.1.0');

// Live simulation command
program
  .command('live')
  .description('Run a live simulation with multiple agents')
  .option('-a, --agents <count>', 'Number of agents', '4')
  .option(
    '-t, --types <types>',
    'Agent slots: "type" or "type:provider:model" (e.g. llm, llm:anthropic:claude-sonnet-4-5, protocol, random). Types: random, tight, callstation, llm, autonomous, protocol.',
    'random,tight,callstation',
  )
  .option('-n, --hands <count>', 'Number of hands to play', '10')
  .option('-s, --server <url>', 'Server URL', defaultServerUrl)
  .option('--blinds <blinds>', 'Blinds (small/big)', '1/2')
  .option('--stack <stack>', 'Initial stack', '1000')
  .option('--timeout <ms>', 'Action timeout in ms', '5000')
  .option('--max-run-minutes <minutes>', 'Maximum total run duration in minutes', '2')
  .option(
    '--model <provider:model>',
    'LLM model for llm/autonomous agents (e.g. openai:gpt-4.1, openrouter:openai/gpt-4o-mini)',
  )
  .option('--skill-doc <path>', 'Path to skill.md for LLM agents', 'public/skill.md')
  .option(
    '--skill-url <url>',
    'URL to skill.md for autonomous/protocol agents (default: {server}/skill.md)',
  )
  .option('--log <path>', 'Base path for logs (run directory will be sim-<timestamp>)')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options) => {
    const runTimestamp = Date.now();
    const runLogDir = options.log
      ? path.join(options.log, `sim-${runTimestamp}`)
      : undefined;
    try {
      const blinds = options.blinds.split('/').map(Number);
      const agentSlots = parseAgentSlots(options.types);
      const skillUrl =
        options.skillUrl ?? `${options.server.replace(/\/$/, '')}/skill.md`;
      const agentCount = parseInt(options.agents, 10);

      for (let i = 0; i < agentCount; i++) {
        const slot = agentSlots[i % agentSlots.length]!;
        createAgentPlan({
          type: slot.type,
          model: slot.model ?? options.model,
          skillDocPath: options.skillDoc,
          skillUrl,
          simulationBaseName: `Validator${i}`,
        });
      }

      const summaryLogPath = runLogDir
        ? path.join(runLogDir, 'simulation-summary.jsonl')
        : undefined;
      const summaryLog = createJsonlLogger(summaryLogPath);
      const startedAt = Date.now();
      summaryLog({
        event: 'simulation_start',
        startedAt,
        serverUrl: options.server,
        skillUrl,
        agentCount,
        handsToPlay: parseInt(options.hands, 10),
        tableConfig: {
          blinds: { small: blinds[0]!, big: blinds[1]! },
          initialStack: parseInt(options.stack, 10),
          actionTimeoutMs: parseInt(options.timeout, 10),
        },
        agentSlots,
      });

      const simulator = new LiveSimulator({
        serverUrl: options.server,
        agentCount,
        agentSlots,
        handsToPlay: parseInt(options.hands, 10),
        tableConfig: {
          blinds: { small: blinds[0]!, big: blinds[1]! },
          initialStack: parseInt(options.stack, 10),
          actionTimeoutMs: parseInt(options.timeout, 10),
        },
        maxRunDurationMs: parseInt(options.maxRunMinutes, 10) * 60 * 1000,
        verbose: options.verbose,
        serviceRoleKey,
        llmModel: options.model,
        skillDocPath: options.skillDoc,
        skillUrl,
        logDir: runLogDir,
      });

      console.log('Starting live simulation...');
      console.log(`Agents: ${options.agents} (${options.types})`);
      if (options.model) console.log(`Default LLM model: ${options.model}`);
      if (skillUrl) console.log(`Skill URL: ${skillUrl}`);
      if (runLogDir) console.log(`Log directory: ${runLogDir}`);
      console.log(`Hands: ${options.hands}`);
      console.log(`Max run duration: ${options.maxRunMinutes}m`);
      console.log(`Server: ${options.server}`);

      const result = await simulator.run();
      summaryLog({
        event: 'simulation_finish',
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        handsPlayed: result.handsPlayed,
        errors: result.errors,
        errorCount: result.errors.length,
        agentResults: result.agentResults,
      });

      console.log('\n=== Simulation Complete ===');
      console.log(`Hands played: ${result.handsPlayed}`);
      console.log(`Duration: ${result.duration}ms`);

      if (result.errors.length > 0) {
        console.log(`Errors: ${result.errors.length}`);
        for (const error of result.errors) {
          console.log(`  - ${error}`);
        }
      }
    } catch (err) {
      if (runLogDir) {
        const failureLog = createJsonlLogger(path.join(runLogDir, 'simulation-summary.jsonl'));
        failureLog({
          event: 'simulation_failed',
          finishedAt: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        });
      }
      console.error('Simulation failed:', err);
      process.exit(1);
    }
  });

// Replay command
program
  .command('replay')
  .description('Replay events from a log file')
  .argument('<file>', 'Event log file (JSON or JSONL)')
  .option('--verify', 'Verify chip conservation and state transitions')
  .option('-v, --verbose', 'Verbose output')
  .action((file, options) => {
    try {
      const simulator = new ReplaySimulator({
        eventsPath: file,
        verify: options.verify,
        verbose: options.verbose,
      });

      console.log(`Replaying events from ${file}...`);

      const result = simulator.run();

      console.log('\n=== Replay Complete ===');
      console.log(`Hands replayed: ${result.handsReplayed}`);
      console.log(`Success: ${result.success}`);

      if (result.errors.length > 0) {
        console.log(`\nErrors (${result.errors.length}):`);
        for (const error of result.errors) {
          console.log(`  - ${error}`);
        }
      }

      if (result.chipConservationViolations.length > 0) {
        console.log(`\nChip Conservation Violations (${result.chipConservationViolations.length}):`);
        for (const violation of result.chipConservationViolations) {
          console.log(`  - ${violation}`);
        }
      }

      if (result.illegalStateTransitions.length > 0) {
        console.log(`\nIllegal State Transitions (${result.illegalStateTransitions.length}):`);
        for (const transition of result.illegalStateTransitions) {
          console.log(`  - ${transition}`);
        }
      }

      if (!result.success) {
        process.exit(1);
      }
    } catch (err) {
      console.error('Replay failed:', err);
      process.exit(1);
    }
  });

// pnpm exec inserts "--" before forwarded args; strip it so Commander parses correctly
const argv = process.argv.slice(2);
if (argv[0] === '--') argv.shift();
program.parse([process.argv[0]!, process.argv[1]!, ...argv]);
