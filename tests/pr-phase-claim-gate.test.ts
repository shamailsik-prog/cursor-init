import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const GATE_SCRIPT = resolve(process.cwd(), "ci_gates/check_pr_phase_claims.py")

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

function writeFile(root: string, relativePath: string, content: string) {
  const absolutePath = join(root, relativePath)
  mkdirSync(resolve(absolutePath, ".."), { recursive: true })
  writeFileSync(absolutePath, content, "utf-8")
}

function makeRepo(baseFiles: Record<string, string>, headFiles: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "phase-claim-gate-"))
  runGit(root, ["init"])
  runGit(root, ["config", "user.name", "Test Runner"])
  runGit(root, ["config", "user.email", "test@example.com"])

  for (const [path, content] of Object.entries(baseFiles)) {
    writeFile(root, path, content)
  }
  runGit(root, ["add", "."])
  runGit(root, ["commit", "-m", "base"])
  const baseSha = runGit(root, ["rev-parse", "HEAD"])

  for (const [path, content] of Object.entries(headFiles)) {
    writeFile(root, path, content)
  }
  runGit(root, ["add", "."])
  runGit(root, ["commit", "-m", "head"])
  const headSha = runGit(root, ["rev-parse", "HEAD"])

  return { root, baseSha, headSha }
}

function runGate(cwd: string, env: Record<string, string>) {
  return spawnSync("python3", [GATE_SCRIPT], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  })
}

describe("PR phase claim gate hardening", () => {
  it("fails when required flags are missing", () => {
    const repo = makeRepo({ "README.md": "base\n" }, { "README.md": "head\n" })
    const result = runGate(repo.root, {
      PR_TITLE: "Update notes",
      PR_BODY: "action-name→call-site evidence: set_backup_owner -> app/ops/operator-audit-console.tsx",
      BASE_SHA: repo.baseSha,
      HEAD_SHA: repo.headSha,
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("missing: backend_real, frontend_real, transport_stub")
  })

  it("fails COMPLETE claims when frontend_real=false", () => {
    const repo = makeRepo({ "README.md": "base\n" }, { "README.md": "head\n" })
    const result = runGate(repo.root, {
      PR_TITLE: "Phase complete",
      PR_BODY: [
        "backend_real=true",
        "frontend_real=false",
        "transport_stub=false",
        "action-name→call-site evidence: set_backup_owner -> app/ops/operator-audit-console.tsx",
      ].join("\n"),
      BASE_SHA: repo.baseSha,
      HEAD_SHA: repo.headSha,
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("frontend_real=false")
  })

  it("passes negated COMPLETE/product-done disclaimer phrasing", () => {
    const repo = makeRepo({ "README.md": "base\n" }, { "README.md": "head\n" })
    const result = runGate(repo.root, {
      PR_TITLE: "Scope correction",
      PR_BODY: [
        "backend_real=true",
        "frontend_real=false",
        "transport_stub=true",
        "no COMPLETE/product-done claim",
      ].join("\n"),
      BASE_SHA: repo.baseSha,
      HEAD_SHA: repo.headSha,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("PASS: PR phase-claim gate.")
  })

  it("passes residual PR #136 disclaimer phrases with test changes", () => {
    const repo = makeRepo(
      { "tests/api.ops-reporting.test.ts": "export const t = 1\n" },
      { "tests/api.ops-reporting.test.ts": "export const t = 2\n" }
    )
    const result = runGate(repo.root, {
      PR_TITLE: "Add workflow waiver-expiry dispute and SLA breach escalation scaffolding",
      PR_BODY: [
        "backend_real=true",
        "frontend_real=false",
        "transport_stub=true",
        "queue the immediate next slice (docs-only queue update)",
        "classification=PARTIAL (never COMPLETE while transport_stub=true)",
      ].join("\n"),
      BASE_SHA: repo.baseSha,
      HEAD_SHA: repo.headSha,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("PASS: PR phase-claim gate.")
  })

  it("fails actual docs-only claims when tests change", () => {
    const repo = makeRepo(
      { "tests/api.ops-reporting.test.ts": "export const t = 1\n" },
      { "tests/api.ops-reporting.test.ts": "export const t = 2\n" }
    )
    const result = runGate(repo.root, {
      PR_TITLE: "Docs-only claim with test delta",
      PR_BODY: [
        "backend_real=true",
        "frontend_real=false",
        "transport_stub=true",
        "this PR is docs-only",
      ].join("\n"),
      BASE_SHA: repo.baseSha,
      HEAD_SHA: repo.headSha,
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("scaffold/docs-only or no runtime changes")
  })

  it("fails real COMPLETE claims even when residual disclaimers are also present", () => {
    const repo = makeRepo({ "README.md": "base\n" }, { "README.md": "head\n" })
    const result = runGate(repo.root, {
      PR_TITLE: "Phase complete",
      PR_BODY: [
        "backend_real=true",
        "frontend_real=false",
        "transport_stub=true",
        "queue the immediate next slice (docs-only queue update)",
        "classification=PARTIAL (never COMPLETE while transport_stub=true)",
      ].join("\n"),
      BASE_SHA: repo.baseSha,
      HEAD_SHA: repo.headSha,
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("frontend_real=false")
    expect(result.stdout).toContain("transport_stub=true")
  })

  it("fails literal COMPLETE claims", () => {
    const repo = makeRepo({ "README.md": "base\n" }, { "README.md": "head\n" })
    const result = runGate(repo.root, {
      PR_TITLE: "COMPLETE",
      PR_BODY: [
        "backend_real=true",
        "frontend_real=false",
        "transport_stub=false",
      ].join("\n"),
      BASE_SHA: repo.baseSha,
      HEAD_SHA: repo.headSha,
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("frontend_real=false")
  })

  it("fails literal product-done claims", () => {
    const repo = makeRepo({ "README.md": "base\n" }, { "README.md": "head\n" })
    const result = runGate(repo.root, {
      PR_TITLE: "product-done",
      PR_BODY: [
        "backend_real=true",
        "frontend_real=true",
        "transport_stub=true",
        "action-name→call-site evidence: set_backup_owner -> app/ops/operator-audit-console.tsx",
      ].join("\n"),
      BASE_SHA: repo.baseSha,
      HEAD_SHA: repo.headSha,
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("transport_stub=true")
  })

  it("passes backend-only claims without /ops call-site evidence", () => {
    const repo = makeRepo(
      { "app/api/d2/ops-reporting/route.ts": "export const route = 'base'\n" },
      { "app/api/d2/ops-reporting/route.ts": "export const route = 'head'\n" }
    )
    const result = runGate(repo.root, {
      PR_TITLE: "Backend-only scaffolding",
      PR_BODY: [
        "backend_real=true",
        "frontend_real=false",
        "transport_stub=true",
        "no /ops call-site changes in this slice",
      ].join("\n"),
      BASE_SHA: repo.baseSha,
      HEAD_SHA: repo.headSha,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("PASS: PR phase-claim gate.")
  })

  it("fails frontend_real=true claims without /ops call-site evidence", () => {
    const repo = makeRepo({ "README.md": "base\n" }, { "README.md": "head\n" })
    const result = runGate(repo.root, {
      PR_TITLE: "Frontend claim without evidence",
      PR_BODY: [
        "backend_real=true",
        "frontend_real=true",
        "transport_stub=true",
      ].join("\n"),
      BASE_SHA: repo.baseSha,
      HEAD_SHA: repo.headSha,
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("call-site evidence for /ops")
  })

  it("fails self-certified DONE to Shamail", () => {
    const repo = makeRepo({ "README.md": "base\n" }, { "README.md": "head\n" })
    const result = runGate(repo.root, {
      PR_TITLE: "Shamail done",
      PR_BODY: [
        "backend_real=true",
        "frontend_real=true",
        "transport_stub=true",
        "action-name→call-site evidence: set_backup_owner -> app/ops/operator-audit-console.tsx",
      ].join("\n"),
      BASE_SHA: repo.baseSha,
      HEAD_SHA: repo.headSha,
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("Do not self-certify DONE/COMPLETE to Shamail")
  })

  it("fails ops changes without focused tests", () => {
    const repo = makeRepo(
      { "app/ops/operator-audit-console.tsx": "export const x = 1\n" },
      { "app/ops/operator-audit-console.tsx": "export const x = 2\n" }
    )
    const result = runGate(repo.root, {
      PR_TITLE: "Batch E ops hardening",
      PR_BODY: [
        "backend_real=true",
        "frontend_real=true",
        "transport_stub=true",
        "action-name→call-site evidence: set_backup_owner -> app/ops/operator-audit-console.tsx",
        "real fetch path: /api/d4/filings",
      ].join("\n"),
      BASE_SHA: repo.baseSha,
      HEAD_SHA: repo.headSha,
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("no focused tests under tests/ops*.test.ts were changed")
  }, 30000)

  it("passes with required flags and evidence for ops changes", () => {
    const repo = makeRepo(
      {
        "app/ops/operator-audit-console.tsx": "export const x = 1\n",
        "tests/ops.batch-e-frontend-real.test.ts": "export const t = 1\n",
      },
      {
        "app/ops/operator-audit-console.tsx": "export const x = 2\n",
        "tests/ops.batch-e-frontend-real.test.ts": "export const t = 2\n",
      }
    )
    const result = runGate(repo.root, {
      PR_TITLE: "Batch E ops hardening",
      PR_BODY: [
        "backend_real=true",
        "frontend_real=true",
        "transport_stub=true",
        "action-name→call-site evidence: set_backup_owner -> app/ops/operator-audit-console.tsx",
        "real fetch path: /api/d4/filings",
      ].join("\n"),
      BASE_SHA: repo.baseSha,
      HEAD_SHA: repo.headSha,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("PASS: PR phase-claim gate.")
  })
}, 30000)
