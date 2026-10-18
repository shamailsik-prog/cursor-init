import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
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
  it("passes when required flags are only in a markdown release-label table", () => {
    const repo = makeRepo({ "README.md": "base\n" }, { "README.md": "head\n" })
    const result = runGate(repo.root, {
      PR_TITLE: "Backend slice",
      PR_BODY: [
        "## Release labels (honest)",
        "",
        "| Label | Value |",
        "|---|---|",
        "| backend_real | true |",
        "| frontend_real | false |",
        "| transport_stub | true |",
        "| classification | **PARTIAL** — no product-done claim |",
        "",
        "Never COMPLETE while `transport_stub=true`.",
      ].join("\n"),
      BASE_SHA: repo.baseSha,
      HEAD_SHA: repo.headSha,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("PASS: PR phase-claim gate.")
  })

  it("passes markdown-table flags with bold/backtick cells", () => {
    const repo = makeRepo({ "README.md": "base\n" }, { "README.md": "head\n" })
    const result = runGate(repo.root, {
      PR_TITLE: "Backend slice",
      PR_BODY: [
        "| **backend_real** | **true** |",
        "| `frontend_real` | `false` |",
        "| transport_stub | true |",
        "no COMPLETE/product-done claim",
      ].join("\n"),
      BASE_SHA: repo.baseSha,
      HEAD_SHA: repo.headSha,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("PASS: PR phase-claim gate.")
  })

  it("fails when markdown table omits required flags", () => {
    const repo = makeRepo({ "README.md": "base\n" }, { "README.md": "head\n" })
    const result = runGate(repo.root, {
      PR_TITLE: "Incomplete table",
      PR_BODY: [
        "| backend_real | true |",
        "| transport_stub | true |",
      ].join("\n"),
      BASE_SHA: repo.baseSha,
      HEAD_SHA: repo.headSha,
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("missing: frontend_real")
  })

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

  it("passes never COMPLETE while transport_stub disclaimer phrasing", () => {
    const repo = makeRepo({ "README.md": "base\n" }, { "README.md": "head\n" })
    const result = runGate(repo.root, {
      PR_TITLE: "Scope correction",
      PR_BODY: [
        "backend_real=true",
        "frontend_real=false",
        "transport_stub=true",
        "classification=PARTIAL (never COMPLETE while transport_stub=true)",
      ].join("\n"),
      BASE_SHA: repo.baseSha,
      HEAD_SHA: repo.headSha,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("PASS: PR phase-claim gate.")
  })

  it("passes PR #136-style metadata with incidental docs-only queue wording", () => {
    const repo = makeRepo(
      { "app/api/d2/ops-reporting/route.ts": "export const route = 'base'\n" },
      {
        "app/api/d2/ops-reporting/route.ts": "export const route = 'head'\n",
        "platform/spine/store.ts": "export const store = 'head'\n",
        "tests/api.ops-reporting.test.ts": "export const t = 1\n",
      }
    )
    const result = runGate(repo.root, {
      PR_TITLE: "Add workflow waiver-expiry dispute and SLA breach escalation scaffolding",
      PR_BODY: [
        "- update roadmap (docs-only queue update)",
        "backend_real=true",
        "frontend_real=false",
        "transport_stub=true",
        "classification=PARTIAL (never COMPLETE while transport_stub=true)",
      ].join("\n"),
      BASE_SHA: repo.baseSha,
      HEAD_SHA: repo.headSha,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("PASS: PR phase-claim gate.")
  })

  it("fails affirmative docs-only claims when substantive paths changed", () => {
    const repo = makeRepo(
      { "app/api/d2/ops-reporting/route.ts": "export const route = 'base'\n" },
      { "app/api/d2/ops-reporting/route.ts": "export const route = 'head'\n" }
    )
    const result = runGate(repo.root, {
      PR_TITLE: "docs-only",
      PR_BODY: [
        "docs-only PR",
        "backend_real=true",
        "frontend_real=false",
        "transport_stub=true",
      ].join("\n"),
      BASE_SHA: repo.baseSha,
      HEAD_SHA: repo.headSha,
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("route/tests changed")
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

  it("passes PR #147 residual not-a-product-done-claim disclaimer phrasing", () => {
    const repo = makeRepo({ "README.md": "base\n" }, { "README.md": "head\n" })
    const result = runGate(repo.root, {
      PR_TITLE:
        "Workflow alert adjudication SLO debt-remediation + checkpoint expiry-attestation exception reconciliation",
      PR_BODY: [
        "backend_real=true",
        "frontend_real=false",
        "transport_stub=true",
        "classification=PARTIAL — internal scaffolding only; **not** a product-done claim while `transport_stub=true`",
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

  describe("transport_stub claim against the filing transport stub markers (P3-59)", () => {
    // The gate reads the stub markers from the working tree it runs in, so each case builds a
    // repository that does, or does not, still carry them.
    const STUBBED = {
      "README.md": "base\n",
      "platform/persistence/filingDispatchQueue.ts": 'export const state = "blocked_todo_firm"\n',
      "app/api/d4/filings/route.ts": "// TODO(firm): external court submission transport\n",
    }
    const CLEAN = { "README.md": "base\n", "platform/persistence/filingDispatchQueue.ts": "export const state = 1\n" }

    it("fails transport_stub=false while the filing transport stub markers remain, naming the files", () => {
      const repo = makeRepo(STUBBED, { ...STUBBED, "README.md": "head\n" })
      const result = runGate(repo.root, {
        PR_TITLE: "Auto-confirm close-out",
        PR_BODY: ["backend_real=true", "frontend_real=false", "transport_stub=false"].join("\n"),
        BASE_SHA: repo.baseSha,
        HEAD_SHA: repo.headSha,
      })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("transport_stub=false but filing transport stub markers remain")
      expect(result.stdout).toContain("platform/persistence/filingDispatchQueue.ts")
      expect(result.stdout).toContain("app/api/d4/filings/route.ts")
    })

    it("fails transport_stub false in a markdown release-label table while the markers remain", () => {
      const repo = makeRepo(STUBBED, { ...STUBBED, "README.md": "head\n" })
      const result = runGate(repo.root, {
        PR_TITLE: "Backend slice",
        PR_BODY: ["| backend_real | true |", "| frontend_real | false |", "| `transport_stub` | **false** |"].join("\n"),
        BASE_SHA: repo.baseSha,
        HEAD_SHA: repo.headSha,
      })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("transport_stub=false but filing transport stub markers remain")
    })

    it("passes transport_stub=true while the markers remain", () => {
      const repo = makeRepo(STUBBED, { ...STUBBED, "README.md": "head\n" })
      const result = runGate(repo.root, {
        PR_TITLE: "Auto-confirm close-out",
        PR_BODY: ["backend_real=true", "frontend_real=false", "transport_stub=true"].join("\n"),
        BASE_SHA: repo.baseSha,
        HEAD_SHA: repo.headSha,
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("PASS: PR phase-claim gate.")
    })

    it("passes transport_stub=false once no stub marker remains", () => {
      const repo = makeRepo(CLEAN, { ...CLEAN, "README.md": "head\n" })
      const result = runGate(repo.root, {
        PR_TITLE: "Real transport",
        PR_BODY: ["backend_real=true", "frontend_real=false", "transport_stub=false"].join("\n"),
        BASE_SHA: repo.baseSha,
        HEAD_SHA: repo.headSha,
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("PASS: PR phase-claim gate.")
    })

    it("reports both failures for a COMPLETE claim with transport_stub=false while the markers remain", () => {
      const repo = makeRepo(STUBBED, { ...STUBBED, "README.md": "head\n" })
      const result = runGate(repo.root, {
        PR_TITLE: "Phase complete",
        PR_BODY: ["backend_real=true", "frontend_real=true", "transport_stub=false"].join("\n"),
        BASE_SHA: repo.baseSha,
        HEAD_SHA: repo.headSha,
      })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("transport_stub=false but filing transport stub markers remain")
      expect(result.stdout).toContain("PR claims COMPLETE/product-done while filing transport TODO/stub markers still exist.")
    })

    describe("only line-anchored flag declarations count, and conflicting declarations fail (final review I1)", () => {
      const gate = (files: Record<string, string>, body: string) => {
        const repo = makeRepo(files, { ...files, "README.md": "head\n" })
        return runGate(repo.root, { PR_TITLE: "Auto-confirm fixes", PR_BODY: body, BASE_SHA: repo.baseSha, HEAD_SHA: repo.headSha })
      }

      it("fails transport_stub declared false and then true (the later one no longer wins)", () => {
        const result = gate(CLEAN, ["backend_real=true", "frontend_real=false", "transport_stub=false", "transport_stub=true"].join("\n"))
        expect(result.status).toBe(1)
        expect(result.stdout).toContain("conflicting transport_stub declarations")
      })

      it("fails transport_stub declared true and then false", () => {
        const result = gate(CLEAN, ["backend_real: true", "frontend_real: false", "transport_stub: true", "", "Notes.", "transport_stub: false"].join("\n"))
        expect(result.status).toBe(1)
        expect(result.stdout).toContain("conflicting transport_stub declarations")
      })

      it("fails a list-item transport_stub: false in the prose mixed with a table row that says true", () => {
        const result = gate(
          STUBBED,
          [
            "## Flags",
            "- transport_stub: false",
            "",
            "| flag | value |",
            "| --- | --- |",
            "| backend_real | true |",
            "| frontend_real | false |",
            "| transport_stub | true |",
          ].join("\n")
        )
        expect(result.status).toBe(1)
        expect(result.stdout).toContain("conflicting transport_stub declarations")
      })

      it("passes a prose mention of `transport_stub: false` beside a table row that says true", () => {
        const result = gate(
          STUBBED,
          [
            "| flag | value |",
            "| --- | --- |",
            "| backend_real | true |",
            "| frontend_real | false |",
            "| transport_stub | true |",
            "",
            "The claim gate fails `transport_stub: false` while the filing transport stub markers remain.",
          ].join("\n")
        )
        expect(result.status).toBe(0)
        expect(result.stdout).toContain("PASS: PR phase-claim gate.")
      })

      it("passes a transport_stub=true line followed by a prose mention of transport_stub=false (a mention is not a declaration)", () => {
        const result = gate(
          STUBBED,
          ["backend_real=true", "frontend_real=false", "transport_stub=true", "", "A PR that says transport_stub=false while the markers remain is refused."].join("\n")
        )
        expect(result.status).toBe(0)
        expect(result.stdout).toContain("PASS: PR phase-claim gate.")
      })

      it("treats a flag that appears only inside a sentence as missing", () => {
        const result = gate(CLEAN, ["backend_real=true", "frontend_real=false", "We keep transport_stub=true for now."].join("\n"))
        expect(result.status).toBe(1)
        expect(result.stdout).toContain("missing: transport_stub")
      })

      it("fails conflicting backend_real and frontend_real declarations the same way", () => {
        const result = gate(
          CLEAN,
          ["backend_real=true", "frontend_real=false", "transport_stub=true", "| backend_real | false |", "| `frontend_real` | **true** |"].join("\n")
        )
        expect(result.status).toBe(1)
        expect(result.stdout).toContain("conflicting backend_real declarations")
        expect(result.stdout).toContain("conflicting frontend_real declarations")
        expect(result.stdout).not.toContain("missing:")
      })

      it("passes one flag declared twice with the same value (a key=value line and a table row)", () => {
        const result = gate(STUBBED, ["backend_real=true", "frontend_real=false", "transport_stub=true", "| transport_stub | **true** |"].join("\n"))
        expect(result.status).toBe(0)
        expect(result.stdout).toContain("PASS: PR phase-claim gate.")
      })

      it("passes this PR's own body (#21), which quotes `transport_stub: false` in prose and declares true in its table", () => {
        const body = readFileSync(resolve(process.cwd(), "tests/fixtures/pr-21-body.md"), "utf-8")
        expect(body).toContain("`transport_stub: false`")
        const result = gate(STUBBED, body)
        expect(result.status).toBe(0)
        expect(result.stdout).toContain("PASS: PR phase-claim gate.")
      })
    })
  })

  describe("Cursor Bugbot's generated summary block is not the author's claim", () => {
    const FLAGS = ["| Flag | Value |", "| --- | --- |", "| backend_real | true |", "| frontend_real | false |", "| transport_stub | true |"]
    // The block Bugbot appends to PR bodies; its prose is generated from the diff (PR #72's said "cannot complete").
    const summary = (prose: string) =>
      ["<!-- CURSOR_SUMMARY -->", "---", "", "> [!NOTE]", "> **Medium Risk**", `> ${prose}`, "<!-- /CURSOR_SUMMARY -->"].join("\n")
    const run = (body: string) => {
      const repo = makeRepo({ "README.md": "base\n" }, { "README.md": "head\n" })
      return runGate(repo.root, { PR_TITLE: "fix(F28): end failed corpus jobs as failures", PR_BODY: body, BASE_SHA: repo.baseSha, HEAD_SHA: repo.headSha })
    }

    it("passes when only the bot summary uses the word complete", () => {
      const body = [...FLAGS, "", "Not a COMPLETE / product-done claim.", "", summary("Corpus work that cannot complete now surfaces as a Celery FAILURE.")].join("\n")
      const result = run(body)
      expect(result.stdout).toContain("PASS: PR phase-claim gate.")
      expect(result.status).toBe(0)
    })

    it("still fails a COMPLETE claim the author makes outside the bot summary", () => {
      const body = [...FLAGS, "", "Phase complete.", "", summary("Corpus work that cannot complete now surfaces as a Celery FAILURE.")].join("\n")
      const result = run(body)
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("PR claims COMPLETE/product-done while frontend_real=false.")
    })

    it("does not count flags declared only inside the bot summary", () => {
      const inside = ["Body text.", "", "<!-- CURSOR_SUMMARY -->", ...FLAGS, "<!-- /CURSOR_SUMMARY -->"].join("\n")
      const result = run(inside)
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("(missing: backend_real, frontend_real, transport_stub)")
    })

    it("reads an unterminated summary marker as ordinary text (fails closed)", () => {
      const body = [...FLAGS, "", "Not a COMPLETE / product-done claim.", "", "<!-- CURSOR_SUMMARY -->", "> Phase complete."].join("\n")
      const result = run(body)
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("PR claims COMPLETE/product-done while frontend_real=false.")
    })
  })

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
}, 60_000)
