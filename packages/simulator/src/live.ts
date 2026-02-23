import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ChildProcess } from 'child_process';
import WebSocket from 'ws';
import { createSimulationAgentPlan, type AgentPlan } from '@moltpoker/agents';
import { ChildProcessSpawnStrategy, type SpawnStrategy } from './spawn-strategy.js';

/** Parsed agent slot: type plus optional inline model override (e.g. llm:anthropic:claude-sonnet-4-5) */
export interface AgentSlot {
  type: string;
  model?: string;
}

/**
 * Parse compact slot syntax: "type" or "type:provider:model".
 * E.g. "llm", "llm:anthropic:claude-sonnet-4-5", "protocol:openai:gpt-4.1"
 */
export function parseAgentSlots(spec: string): AgentSlot[] {
  return spec.split(',').map((s) => {
    const t = s.trim();
    const firstColon = t.indexOf(':');
    if (firstColon < 0) return { type: t };
    const type = t.slice(0, firstColon);
    const model = t.slice(firstColon + 1);
    if (!model || !model.includes(':')) return { type: t };
    return { type, model };
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function sanitizeNodeOptionsForChild(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  // Child agents run built dist JS via plain node. Inheriting --conditions=development
  // can force workspace packages to resolve to src/*.ts entrypoints and crash.
  const sanitized = raw
    .replace(/--conditions=development/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized.length > 0 ? sanitized : undefined;
}

export interface LiveSimulatorOptions {
  serverUrl: string;
  agentCount: number;
  /** Parsed agent slots (type + optional model). Cycled when agentCount > slots.length. */
  agentSlots: AgentSlot[];
  handsToPlay: number;
  /** Maximum duration to wait for a run to complete (ms). */
  maxRunDurationMs?: number;
  tableConfig?: {
    blinds?: { small: number; big: number };
    initialStack?: number;
    actionTimeoutMs?: number;
  };
  /** Bucket key for table creation (defaults to "default") */
  bucketKey?: string;
  verbose?: boolean;
  /** Service role key for admin API authentication */
  serviceRoleKey?: string;
  /** Default LLM model for llm/autonomous/protocol agents (e.g. "openai:gpt-4.1") */
  llmModel?: string;
  /** Default path to skill.md for llm agents */
  skillDocPath?: string;
  /** Default URL to skill.md for autonomous/protocol agents (e.g. "http://localhost:3000/skill.md") */
  skillUrl?: string;
  /** Path to molt-agent binary (default: resolved from workspace root) */
  agentBinPath?: string;
  /** Use auto-join instead of admin table creation (default: true) */
  useAutoJoin?: boolean;
  /** Directory where per-agent logs are written */
  logDir?: string;
  /** Additional environment variables to pass to spawned agent processes */
  env?: Record<string, string>;
  /** Called as soon as the table is created (admin-create mode), so run history can show table ID while running */
  onTableCreated?: (tableId: string) => void;
}

export interface LiveSimulatorResult {
  handsPlayed: number;
  duration: number;
  /** Table ID created by admin-create mode, null if auto-join mode */
  tableId: string | null;
  agentResults: Array<{
    agentId: string;
    agentType: string;
    finalStack: number;
    handsWon: number;
  }>;
  errors: string[];
}

/**
 * Live simulator - spawns multiple agents to play against each other
 */
export class LiveSimulator {
  private options: LiveSimulatorOptions;
  private processes: ChildProcess[] = [];
  private spawnStrategy: SpawnStrategy;

  constructor(options: LiveSimulatorOptions) {
    this.options = options;
    this.spawnStrategy = new ChildProcessSpawnStrategy();
  }

  /**
   * Get headers for admin API requests
   */
  private getAdminHeaders(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    // Only set Content-Type if there's a body to send
    if (hasBody) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.options.serviceRoleKey) {
      headers['Authorization'] = `Bearer ${this.options.serviceRoleKey}`;
    }
    return headers;
  }

  /**
   * Run the simulation
   */
  async run(): Promise<LiveSimulatorResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    const useAutoJoin = this.options.useAutoJoin !== false;

    if (useAutoJoin) {
      return this.runWithAutoJoin(startTime, errors);
    }
    return this.runWithAdminCreate(startTime, errors);
  }

  /**
   * Run simulation using auto-join (agents self-organize)
   */
  private async runWithAutoJoin(startTime: number, errors: string[]): Promise<LiveSimulatorResult> {
    if (this.options.verbose) {
      console.log('Using auto-join mode: agents will self-organize');
    }

    // Spawn agents without a table ID (they will auto-join)
    for (let i = 0; i < this.options.agentCount; i++) {
      const slot = this.options.agentSlots[i % this.options.agentSlots.length]!;
      const plan = this.createAgentPlan(slot, i);
      await this.spawnAgent(null, plan);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (this.options.verbose) {
      console.log(`Spawned ${this.options.agentCount} agents, waiting for auto-join and auto-start...`);
    }

    // Wait for agents to finish (they should auto-start when enough join)
    // Use a timeout-based approach since we don't have a table ID up front
    await new Promise((resolve) => setTimeout(resolve, this.options.handsToPlay * 15000 + 10000));

    // Kill agent processes
    for (const proc of this.processes) {
      proc.kill('SIGTERM');
    }

    const duration = Date.now() - startTime;

    return {
      handsPlayed: this.options.handsToPlay,
      duration,
      tableId: null,
      agentResults: [],
      errors,
    };
  }

  /**
   * Run simulation using admin table creation (traditional flow)
   */
  private async runWithAdminCreate(startTime: number, errors: string[]): Promise<LiveSimulatorResult> {
    const resolvedBucketKey = this.options.bucketKey ?? 'default';
    const createRequestBody = {
      config: {
        blinds: this.options.tableConfig?.blinds ?? { small: 1, big: 2 },
        initialStack: this.options.tableConfig?.initialStack ?? 1000,
        actionTimeoutMs: this.options.tableConfig?.actionTimeoutMs ?? 5000,
        maxSeats: Math.min(this.options.agentCount, 9),
        minPlayersToStart: this.options.agentCount,
      },
    };
    try {
      const tablesResponse = await fetch(`${this.options.serverUrl}/v1/tables`, {
        method: 'GET',
      });
      if (tablesResponse.ok) {
        const payload = (await tablesResponse.json()) as {
          tables?: Array<{ id: string; status: string; bucket_key?: string }>;
        };
        const waitingInBucket =
          payload.tables?.find(
            (t) => t.status === 'waiting' && (t.bucket_key ?? 'default') === resolvedBucketKey,
          ) ?? null;
        if (waitingInBucket) {
          await fetch(
            `${this.options.serverUrl}/v1/admin/tables/${waitingInBucket.id}/stop`,
            {
              method: 'POST',
              headers: this.getAdminHeaders(false),
            },
          );
        }
      }
    } catch {
      // Ignore pre-cleanup failures and continue with create
    }

    let tableId: string | null = null;
    try {
      // Create a table via admin API
      const tableResponse = await fetch(`${this.options.serverUrl}/v1/admin/tables`, {
        method: 'POST',
        headers: this.getAdminHeaders(true),
        body: JSON.stringify({
          ...createRequestBody,
          bucket_key: resolvedBucketKey,
        }),
      });

      if (!tableResponse.ok) {
        const error = await tableResponse.text();
        throw new Error(`Failed to create table: ${error}`);
      }

      const table = (await tableResponse.json()) as { id: string };
      tableId = table.id;
      this.options.onTableCreated?.(tableId);

      if (this.options.verbose) {
        console.log(`Created table: ${tableId}`);
      }

      // Spawn agent processes
      const agentPromises: Promise<void>[] = [];

      for (let i = 0; i < this.options.agentCount; i++) {
        const slot = this.options.agentSlots[i % this.options.agentSlots.length]!;

        const plan = this.createAgentPlan(slot, i);
        const promise = this.spawnAgent(tableId, plan);
        agentPromises.push(promise);

        // Small delay between spawns to avoid race conditions
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      if (this.options.verbose) {
        console.log('Waiting for auto-start...');
      }
      await this.waitForTableAutoStart(tableId);

      if (this.options.verbose) {
        console.log('Table started, playing hands...');
      }

      // Wait for hands to complete
      const handsPlayed = await this.waitForHandCompletion(tableId);

      // Stop the table
      if (this.options.verbose) {
        console.log('Stopping table...');
      }

      await fetch(`${this.options.serverUrl}/v1/admin/tables/${tableId}/stop`, {
        method: 'POST',
        headers: this.getAdminHeaders(false),
      });

      // Kill agent processes
      for (const proc of this.processes) {
        proc.kill('SIGTERM');
      }

      const duration = Date.now() - startTime;

      return {
        handsPlayed,
        duration,
        tableId,
        agentResults: [],
        errors,
      };
    } catch (err) {
      // Ensure child processes don't outlive failed runs
      for (const proc of this.processes) {
        proc.kill('SIGTERM');
      }
      this.processes = [];

      if (tableId) {
        try {
          await fetch(`${this.options.serverUrl}/v1/admin/tables/${tableId}/stop`, {
            method: 'POST',
            headers: this.getAdminHeaders(false),
          });
        } catch {
          // Ignore cleanup failure and rethrow original error
        }
      }
      throw err;
    }
  }

  private async waitForTableAutoStart(tableId: string): Promise<void> {
    const timeoutMs = 45000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const detailResponse = await fetch(`${this.options.serverUrl}/v1/admin/tables/${tableId}`, {
          method: 'GET',
          headers: this.getAdminHeaders(false),
        });
        if (detailResponse.ok) {
          const tableState = (await detailResponse.json()) as {
            status?: string;
            seats?: Array<{ seat_id: number; agent_id: string | null }>;
          };
          if (tableState.status === 'running') return;
        }
      } catch {
        // Ignore transient polling errors
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for table auto-start: ${tableId}`);
  }

  /**
   * Wait for hands to complete by observing via WebSocket
   */
  private async waitForHandCompletion(tableId: string): Promise<number> {
    const wsUrl = this.options.serverUrl.replace(/^http/, 'ws');
    const ws = new WebSocket(`${wsUrl}/v1/ws/observe/${tableId}`);

    let handsCompleted = 0;
    const targetHands = this.options.handsToPlay;
    const maxRunDurationMs = this.options.maxRunDurationMs ?? 120000;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        resolve(handsCompleted); // Return what we got
      }, maxRunDurationMs);

      ws.onopen = () => {};

      ws.onmessage = (event: WebSocket.MessageEvent) => {
        const message = JSON.parse(event.data.toString());
        if (message.type === 'hand_complete') {
          handsCompleted++;
          if (this.options.verbose) {
            console.log(`Hand ${handsCompleted}/${targetHands} complete`);
          }
          if (handsCompleted >= targetHands) {
            clearTimeout(timeout);
            ws.close();
            resolve(handsCompleted);
          }
        }
      };

      ws.onclose = () => {};

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket connection error'));
      };
    });
  }

  /**
   * Spawn an agent process
   */
  private createAgentPlan(slot: AgentSlot, index: number): AgentPlan {
    const agentType = slot.type.toLowerCase();
    const resolvedModel = slot.model ?? this.options.llmModel;
    const resolvedSkillDoc = this.options.skillDocPath;
    const resolvedSkillUrl = this.options.skillUrl;
    return createSimulationAgentPlan({
      type: agentType,
      model: resolvedModel,
      skillDocPath: resolvedSkillDoc,
      skillUrl: resolvedSkillUrl,
      llmLogPath: this.options.logDir
        ? path.join(this.options.logDir, `agent-${index}-${agentType}.jsonl`)
        : undefined,
    });
  }

  private async spawnAgent(tableId: string | null, plan: AgentPlan): Promise<void> {
    const agentBin =
      this.options.agentBinPath ??
      path.join(findRepoRoot(__dirname), 'packages', 'agents', 'dist', 'cli.js');

    const proc = this.spawnStrategy.spawn(plan, {
      agentBin,
      serverUrl: this.options.serverUrl,
      tableId,
      verbose: this.options.verbose,
      env: this.options.env,
      nodeOptions: sanitizeNodeOptionsForChild(process.env.NODE_OPTIONS),
    });

    this.processes.push(proc);

    return new Promise((resolve, reject) => {
      proc.on('error', reject);
      proc.on('spawn', resolve);
    });
  }

  /**
   * Stop all processes
   */
  stop(): void {
    for (const proc of this.processes) {
      proc.kill('SIGTERM');
    }
    this.processes = [];
  }
}
