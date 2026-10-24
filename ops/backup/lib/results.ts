import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

/**
 * Where a drill writes its measured result (the CI job uploads the directory). Default: ops/backup/.results,
 * which .gitignore keeps out of the tree.
 */
export function resultsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SIKANDER_BACKUP_RESULTS_DIR?.trim() || path.resolve(__dirname, "..", ".results")
}

export type DrillResult = {
  store: string
  /** Time from the start of the restore to a verified result, in milliseconds (spec R15). */
  rtoMs: number
  /** Fixture size the figure was measured on. */
  details: Record<string, string | number | boolean>
}

export function recordDrillResult(result: DrillResult, env: NodeJS.ProcessEnv = process.env): string {
  const dir = resultsDir(env)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${result.store}.json`)
  const body = { ...result, measuredAt: new Date().toISOString(), node: process.version, platform: process.platform }
  writeFileSync(file, JSON.stringify(body, null, 2) + "\n")
  return file
}
