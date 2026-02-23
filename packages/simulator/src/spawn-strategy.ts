import { spawn, type ChildProcess } from 'child_process'
import type { AgentPlan } from '@drvillo/moltpoker-agents'

export interface SpawnRequest {
  agentBin: string
  serverUrl: string
  tableId: string | null
  verbose?: boolean
  env?: Record<string, string>
  nodeOptions?: string
}

export interface SpawnStrategy {
  spawn(plan: AgentPlan, request: SpawnRequest): ChildProcess
}

export class ChildProcessSpawnStrategy implements SpawnStrategy {
  spawn(plan: AgentPlan, request: SpawnRequest): ChildProcess {
    const args = buildSpawnArgs(plan, request)
    return spawn('node', args, {
      stdio: request.verbose ? 'inherit' : ['ignore', 'ignore', 'inherit'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...request.env,
        NODE_OPTIONS: request.nodeOptions,
      },
    })
  }
}

export function buildSpawnArgs(plan: AgentPlan, request: SpawnRequest): string[] {
  const args = [
    request.agentBin,
    '--type',
    plan.type,
    '--server',
    request.serverUrl,
    '--name',
    plan.name,
  ]

  if (request.tableId)
    args.push('--table-id', request.tableId)

  if (plan.model)
    args.push('--model', plan.model)

  if (plan.type === 'llm') {
    if (!plan.skillDocPath)
      throw new Error('skillDocPath is required for llm agents (--skill-doc)')
    args.push('--skill-doc', plan.skillDocPath)
  }

  if (plan.type === 'autonomous' || plan.type === 'protocol') {
    if (!plan.skillUrl)
      throw new Error(`skillUrl is required for ${plan.type} agents (--skill-url)`)
    args.push('--skill-url', plan.skillUrl)
  }

  if (plan.llmLogPath && (plan.type === 'llm' || plan.type === 'autonomous' || plan.type === 'protocol'))
    args.push('--llm-log-path', plan.llmLogPath)

  return args
}
