import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"

const GATE_SCRIPT = resolve(process.cwd(), "ci_gates/check_ops_helper_resolution.py")

function makeWorkspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ops-helper-gate-"))
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, relativePath)
    mkdirSync(resolve(absolutePath, ".."), { recursive: true })
    writeFileSync(absolutePath, content, "utf-8")
  }
  return root
}

function runGate(workspaceRoot: string, targetFile: string) {
  return spawnSync(
    "python3",
    [
      GATE_SCRIPT,
      "--workspace-root",
      workspaceRoot,
      "--file",
      join(workspaceRoot, targetFile),
    ],
    { encoding: "utf-8" }
  )
}

describe("ops helper resolution gate", () => {
  it("fails when runApiCall helper call has no definition/import", () => {
    const workspaceRoot = makeWorkspace({
      "app/ops/operator-audit-console.tsx": `
        export function OperatorAuditConsole() {
          runApiCallAllowingStatuses({ step: "x", method: "POST", path: "/api/x" }, [200])
          return null
        }
      `,
    })
    const result = runGate(workspaceRoot, "app/ops/operator-audit-console.tsx")
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("runApiCallAllowingStatuses")
  })

  it("passes when helper is imported and exported from a sibling module", () => {
    const workspaceRoot = makeWorkspace({
      "app/ops/helpers.ts": `
        export async function runApiCallAllowingStatuses() {
          return { ok: true, status: 200, body: null }
        }
      `,
      "app/ops/operator-audit-console.tsx": `
        import { runApiCallAllowingStatuses } from "./helpers"

        export function OperatorAuditConsole() {
          runApiCallAllowingStatuses()
          return null
        }
      `,
    })
    const result = runGate(workspaceRoot, "app/ops/operator-audit-console.tsx")
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("PASS")
  })
})
