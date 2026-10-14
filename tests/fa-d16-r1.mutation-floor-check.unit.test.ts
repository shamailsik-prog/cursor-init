/**
 * Re-audit R1-D3 (LOW): the per-file mutation floor must not be satisfiable vacuously. The checker
 * (scripts/check-mutation-per-file.mjs, run by `npm run mutation:documents`) fails when a floored
 * file is missing from the report, has no valid mutants at all, or when the report itself is
 * missing; mutants disabled with `// Stryker disable` (status Ignored) count against the score,
 * so silencing a mutant cannot raise it. The CI trigger (pull_request with a paths filter on the
 * vault) is in .github/workflows/mutation.yml.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const SCRIPT = resolve(__dirname, "..", "scripts", "check-mutation-per-file.mjs")
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fa-d16-r1-floor-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

type Status = "Killed" | "Timeout" | "Survived" | "NoCoverage" | "Ignored" | "CompileError" | "RuntimeError"

function check(floors: Record<string, number>, files: Record<string, Status[]> | null) {
  const report = join(dir, "mutation.json")
  if (files) {
    writeFileSync(
      report,
      JSON.stringify({
        files: Object.fromEntries(
          Object.entries(files).map(([f, statuses]) => [f, { mutants: statuses.map((status, i) => ({ id: String(i), status })) }])
        ),
      })
    )
  }
  const config = join(dir, "stryker.cfg.mjs")
  writeFileSync(
    config,
    `export const perFileBreak = ${JSON.stringify(floors)}\nexport default { jsonReporter: { fileName: ${JSON.stringify(report)} } }\n`
  )
  const run = spawnSync(process.execPath, [SCRIPT, config], { encoding: "utf8" })
  return { code: run.status, out: `${run.stdout}${run.stderr}` }
}

describe("R1-D3: the per-file mutation floor cannot pass vacuously", () => {
  it("passes a file at or above its floor and reports the score", () => {
    const r = check({ "a.ts": 75 }, { "a.ts": ["Killed", "Killed", "Timeout", "Survived"] })
    expect(r.code).toBe(0)
    expect(r.out).toContain("PASS a.ts: 75.00%")
  })

  it("fails a file below its floor", () => {
    const r = check({ "a.ts": 80 }, { "a.ts": ["Killed", "Killed", "Killed", "NoCoverage"] })
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL a.ts: 75.00%")
  })

  it("fails a floored file with no valid mutants instead of scoring it 100", () => {
    const empty = check({ "a.ts": 95 }, { "a.ts": [] })
    expect(empty.code).toBe(1)
    expect(empty.out).toContain("FAIL a.ts: no valid mutants")
    const onlyInvalid = check({ "a.ts": 95 }, { "a.ts": ["CompileError", "RuntimeError"] })
    expect(onlyInvalid.code).toBe(1)
    expect(onlyInvalid.out).toContain("FAIL a.ts: no valid mutants")
  })

  it("counts Ignored (Stryker-disabled) mutants as not killed", () => {
    const r = check({ "a.ts": 95 }, { "a.ts": ["Killed", "Killed", "Killed", "Ignored"] })
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL a.ts: 75.00%")
    expect(r.out).toContain("ignored 1")
  })

  it("fails when a floored file is missing from the report", () => {
    const r = check({ "a.ts": 50, "b.ts": 50 }, { "a.ts": ["Killed"] })
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL b.ts: not in")
  })

  it("fails when the report itself is missing", () => {
    const r = check({ "a.ts": 50 }, null)
    expect(r.code).toBe(1)
    expect(r.out).toContain("FAIL: no mutation report at")
  })

  it("fails when the config declares no floors", () => {
    const r = check({}, { "a.ts": ["Killed"] })
    expect(r.code).toBe(2)
  })
})
