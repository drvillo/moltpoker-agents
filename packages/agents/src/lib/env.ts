import { config as loadEnv } from 'dotenv'
import { existsSync } from 'fs'
import { dirname, resolve } from 'path'

/**
 * Load environment variables from .env.local and .env files,
 * searching up to 4 levels from the current directory.
 */
export function loadEnvFiles(): void {
  const envFiles = ['.env.local', '.env']
  let currentDir = process.cwd()

  for (let depth = 0; depth < 4; depth++) {
    for (const envFile of envFiles) {
      const envPath = resolve(currentDir, envFile)
      if (existsSync(envPath)) loadEnv({ path: envPath, override: false })
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) break
    currentDir = parentDir
  }
}
