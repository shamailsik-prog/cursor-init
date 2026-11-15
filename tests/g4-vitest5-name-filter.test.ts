/**
 * Vitest 5 matches `-t` against "suite > test". A space-joined anchor selects
 * nothing, and vitest still exits 0. The gate checker must fail that, and the
 * arrow form must select the named test.
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = path.resolve(import.meta.dirname, "..")
const BOOT =
  "D4 boot (P4-3, P4-10) the entry point exports api, and the router built with every layer flag off serves exactly the D4 routes, each kind general"

function firstAlternative(filter: string): string {
  let out = ""
  for (let i = 0; i < filter.length; i++) {
    if (filter[i] === "\\") {
      out += filter.slice(i, i + 2)
      i += 1
      continue
    }
    out += filter[i]
    if (filter[i] === "$" && filter[i + 1] === "|") break
  }
  return out
}

function runBoot(pattern: string, jsonPath: string): void {
  execFileSync(
    "npx",
    ["vitest", "run", "test/d4.boot.test.ts", "-t", pattern, "--reporter=json", `--outputFile=${jsonPath}`],
    { cwd: path.join(ROOT, "functions"), env: process.env, stdio: "pipe" },
  )
}

function checkSelection(jsonPath: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync("node", [path.join(ROOT, "ci_gates/check_vitest_json_selection.mjs"), jsonPath], {
      cwd: ROOT,
      env: { ...process.env, EXPECTED: BOOT, LABEL: "proof" },
      encoding: "utf8",
    })
    return { code: 0, stdout }
  } catch (error) {
    const failed = error as { status?: number; stdout?: string }
    return { code: failed.status ?? 1, stdout: String(failed.stdout ?? "") }
  }
}

describe("G-4 vitest 5 name filter", () => {
  it("a space-joined anchor selects 0 tests and the gate fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g4-red-"))
    const jsonPath = path.join(dir, "boot.json")
    const wrong = `^${BOOT.replace(/[\][\\.*^$()+?{}|]/g, "\\$&")}$`
    runBoot(wrong, jsonPath)
    const result = checkSelection(jsonPath)
    expect(result.code).toBe(1)
    expect(result.stdout).toContain("FAIL: the name pattern selected 0 tests")
  })

  it("the gate's arrow pattern selects the named test", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g4-green-"))
    const filter = execFileSync("bash", ["ci_gates/gate_g4_phase4a.sh", "--inner", dir, "--filter-only"], {
      cwd: ROOT,
      encoding: "utf8",
    })
    const fn = filter.split("\n").find((line) => line.startsWith("fn "))?.slice(3) ?? ""
    const arrow = firstAlternative(fn)
    expect(arrow).toContain(" > ")
    expect(arrow).not.toContain("D4 boot \\(P4-3, P4-10\\) the entry point")

    const jsonPath = path.join(dir, "boot.json")
    runBoot(arrow, jsonPath)
    const result = checkSelection(jsonPath)
    expect(result.stdout).toContain("1 passed")
    expect(result.code).toBe(0)
  })

  it("phase 3d refusal rows use Vitest 5's unquoted 40-character titles", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g4-3d-"))
    const filter = execFileSync("bash", ["ci_gates/gate_g4_phase3d.sh", "--inner", dir, "--filter-only"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim()
    expect(filter).toContain(" > ")
    expect(filter).not.toContain("disableAll \\(…")
    expect(filter).toContain("disableAll \\(th…")

    const listed = execFileSync(
      "npx",
      ["vitest", "list", "test/p1.gateway.emu.test.ts", "--no-static-parse", "--silent"],
      {
        cwd: path.join(ROOT, "functions"),
        encoding: "utf8",
        env: {
          ...process.env,
          FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
          FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
        },
      },
    )
    const refusals = listed
      .split("\n")
      .filter((line) => line.includes("refusals (P3-61 steps 2 to 8) > ") && line.includes("→ blocked"))
      .map((line) => line.replace(/^test\/p1\.gateway\.emu\.test\.ts > /, ""))
    expect(refusals).toHaveLength(15)
    const pattern = new RegExp(filter)
    const oldQuoted = "callP1 (P3-61, P3-63..P3-66, P3-69) > refusals (P3-61 steps 2 to 8) > 'the firm switch with disableAll' → blocked 'kill_switch_firm', no provider call, a blocked row, event and deny audit row"
    expect(pattern.test(oldQuoted)).toBe(false)
    for (const name of refusals) expect(pattern.test(name)).toBe(true)
  })
})
