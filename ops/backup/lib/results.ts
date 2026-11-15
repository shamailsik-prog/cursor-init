import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

/**
 * Where a drill writes its measured result (the CI job uploads the directory). Default: ops/backup/.results,
 * which .gitignore keeps out of the tree.
 */
export function resultsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SIKANDER_BACKUP_RESULTS_DIR?.trim() || path.resolve(__dirname, "..", ".results")
}

export type DrillContentUnit = { name: string; count: number; digest: string; match: boolean }

export type DrillTargetClaim = { kind: "local" | "emulator" | "temp"; engine: string; isolated: true }

export type DrillResult = {
  store: string
  /** Time from the start of the restore to a verified result, in milliseconds (spec R15). */
  rtoMs: number
  /** Fixture facts. A passing report also carries `contentUnits`. */
  details: Record<string, string | number | boolean | DrillContentUnit[] | undefined>
  idempotent?: boolean
  problems?: string[]
  target?: DrillTargetClaim
}

const CONTENT_SHA256 = /^[0-9a-f]{64}$/

function contentUnits(details: DrillResult["details"]): DrillContentUnit[] | null {
  const units = details.contentUnits
  return Array.isArray(units) ? units : null
}

function unitComplete(unit: DrillContentUnit): boolean {
  return (
    typeof unit?.name === "string" &&
    unit.name.length > 0 &&
    typeof unit.count === "number" &&
    Number.isInteger(unit.count) &&
    unit.count >= 0 &&
    typeof unit.digest === "string" &&
    CONTENT_SHA256.test(unit.digest) &&
    unit.match === true
  )
}

export function recordDrillResult(result: DrillResult, env: NodeJS.ProcessEnv = process.env): string {
  const passing = result.details.ok === true
  const units = contentUnits(result.details)
  if (passing) {
    if (!units || units.some((unit) => !unitComplete(unit))) {
      throw new Error("passing drill report requires per-unit counts and checksums")
    }
    if (units.length === 0) {
      throw new Error("passing drill report refuses a zero-unit restore")
    }
    const target = result.target
    if (!target || target.isolated !== true || !["local", "emulator", "temp"].includes(target.kind)) {
      throw new Error("passing drill report requires an isolated local, emulator, or temp target")
    }
  }
  const dir = resultsDir(env)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${result.store}.json`)
  const body = {
    schema: "sikander-backup-drill/1",
    store: result.store,
    ok: passing,
    idempotent: result.idempotent === true,
    rtoMs: result.rtoMs,
    target: result.target ?? null,
    content: { units: units ?? [] },
    problems: result.problems ?? [],
    details: result.details,
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
  }
  writeFileSync(file, JSON.stringify(body, null, 2) + "\n")
  return file
}
