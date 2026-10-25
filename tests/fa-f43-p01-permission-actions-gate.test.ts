/**
 * FA-F43-R1-P01, G-0 [23] (ci_gates/check_permission_actions.py; spec
 * docs/superpowers/specs/2026-10-24-fa-f43-p01-unknown-action-deny-design.md R7, R9): the gate parses DECIDE_ACTIONS out of
 * platform/p5/permissionDecision.ts without a TypeScript compiler (G-0 runs before node_modules exists). This suite holds
 * the parse to the module itself, runs the gate on the tree, and checks it is wired into G-0. The planted must-fail
 * trees are in ci_gates/test_check_permission_actions.py, which G-0 [23] also runs.
 *
 * On main 5840d3d there is no gate and no DECIDE_ACTIONS, so every case fails.
 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import * as table from "@/platform/p5/permissionDecision"

const ROOT = path.resolve(__dirname, "..")
const GATE = "ci_gates/check_permission_actions.py"

function gate(...args: string[]): { code: number | null; out: string; err: string } {
  const res = spawnSync("python3", [GATE, ...args], { cwd: ROOT, encoding: "utf8", timeout: 120_000 })
  return { code: res.status, out: res.stdout ?? "", err: res.stderr ?? "" }
}

describe("G-0 [23] permission-action parity gate", () => {
  it("parses exactly the module's DECIDE_ACTIONS, in order", () => {
    const listed = (table as { DECIDE_ACTIONS?: readonly string[] }).DECIDE_ACTIONS
    expect(listed).toBeDefined()
    const r = gate("--print-known")
    expect(r.code, r.err).toBe(0)
    expect(JSON.parse(r.out)).toEqual([...(listed ?? [])])
  })

  it("passes on this tree, and its inventory reaches every Next route action and both stacks", () => {
    const r = gate()
    expect(r.code, r.out + r.err).toBe(0)
    expect(r.out).toMatch(/^PASS permission-action parity: \d+ call sites/m)
    const rows = JSON.parse(gate("--print-inventory").out) as Array<{ file: string; entry: string; actions: string[]; how: string }>
    const actions = new Set(rows.flatMap((row) => row.actions))
    for (const action of ["list_matters", "research", "draft", "normalise_case_number", "committee_brain", "committee_brain_read"]) {
      expect(actions.has(action), action).toBe(true)
    }
    expect(new Set(rows.map((row) => row.entry))).toEqual(
      new Set(["platform/p5/checkPermission", "platform/p5/permissionDecision", "functions/src/p5/permission"])
    )
    // The only computed sites accepted without a resolvable type are the two P5 entry points' own forwards.
    expect(rows.filter((row) => row.how === "listed").map((row) => row.file).sort()).toEqual([
      "functions/src/p5/permission.ts",
      "platform/p5/checkPermission.ts",
    ])
    // Every action a call site names is one the table decides.
    const known = new Set((table as { DECIDE_ACTIONS?: readonly string[] }).DECIDE_ACTIONS ?? [])
    for (const action of actions) if (action !== "*") expect(known.has(action), action).toBe(true)
  })

  it("is G-0 check [23], with its planted-tree tests", () => {
    const g0 = readFileSync(path.join(ROOT, "ci_gates/gate_g0.sh"), "utf8")
    expect(g0).toMatch(/echo "\[23\] permission-action parity guard[^\n]*"\npython3 ci_gates\/check_permission_actions\.py \|\| fail=1\n/)
    expect(g0).toContain("python3 ci_gates/test_check_permission_actions.py >/dev/null 2>&1 || { echo \"FAIL: ci_gates/test_check_permission_actions.py\"; fail=1; }")
    const r = spawnSync("python3", ["ci_gates/test_check_permission_actions.py"], { cwd: ROOT, encoding: "utf8", timeout: 120_000 })
    expect(r.status, r.stderr).toBe(0)
  })
})
