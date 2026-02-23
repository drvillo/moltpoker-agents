import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

/**
 * Creates a JSONL logger that writes to the specified file path.
 * Returns a no-op function if no path is provided.
 * 
 * Features:
 * - Automatically creates parent directories
 * - Adds timestamp (`ts`) to each entry
 * - Wraps writes in try/catch to prevent agent crashes
 * - Returns no-op if logPath is undefined
 */
export function createJsonlLogger(
  logPath?: string
): (entry: Record<string, unknown>) => void {
  if (!logPath) {
    return () => {}
  }

  // Create directory if needed
  const dir = dirname(logPath)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    console.warn(`Failed to create log directory ${dir}:`, err)
    return () => {}
  }

  return (entry: Record<string, unknown>) => {
    try {
      const logEntry = { ts: Date.now(), ...entry }
      appendFileSync(logPath, JSON.stringify(logEntry) + '\n')
    } catch (err) {
      // Silently fail to avoid disrupting the agent
      // Could optionally log to console.warn in debug mode
    }
  }
}
