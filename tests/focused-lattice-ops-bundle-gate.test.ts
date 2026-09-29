import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const GATE_SCRIPT = resolve(process.cwd(), "ci_gates/check_focused_lattice_ops_bundle.py")
const RUNNER = resolve(process.cwd(), "ci_gates/run_focused_lattice_ops_vitest.sh")

function runGate(cwd: string, scriptPath = GATE_SCRIPT) {
  return execSync(`python3 "${scriptPath}"`, { cwd, encoding: "utf-8" })
}

function expectGateFail(cwd: string) {
  let threw = false
  try {
    runGate(cwd)
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
}

describe("focused lattice ops bundle gate", () => {
  it("passes on the real repository runner and ledger", () => {
    const out = runGate(process.cwd())
    expect(out).toContain("PASSED")
  })

  it("fails when a lattice frontend-real file is removed from FILES", () => {
    const root = mkdtempSync(join(tmpdir(), "focused-lattice-bundle-gate-"))
    mkdirSync(join(root, "ci_gates"), { recursive: true })
    mkdirSync(join(root, "docs/audits"), { recursive: true })
    const runnerSrc = readFileSync(RUNNER, "utf-8")
    const stripped = runnerSrc.replace(
      /^\s+tests\/ops\.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-533-534-frontend-real\.test\.ts\s*$/m,
      ""
    )
    writeFileSync(join(root, "ci_gates/run_focused_lattice_ops_vitest.sh"), stripped)
    writeFileSync(
      join(root, "docs/audits/lattice-focused-ops-vitest-bundle.md"),
      readFileSync(
        resolve(process.cwd(), "docs/audits/lattice-focused-ops-vitest-bundle.md"),
        "utf-8"
      )
    )
    writeFileSync(join(root, "ci_gates/check_focused_lattice_ops_bundle.py"), readFileSync(GATE_SCRIPT))
    execSync(`ln -s "${resolve(process.cwd(), "tests")}" "${join(root, "tests")}"`)
    const gateInTemp = join(root, "ci_gates/check_focused_lattice_ops_bundle.py")
    let threw = false
    try {
      runGate(root, gateInTemp)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})
