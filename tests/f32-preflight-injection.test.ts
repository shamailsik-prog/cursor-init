import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

const repoRoot = process.cwd()
const STAGING_PROJECT_ID = "demo-sikander"
const VULNERABLE_FIXTURE = path.join(repoRoot, "ci_gates/fixtures/deploy-preflight-heredoc-vulnerable.sh")

function cloneWorkspace(): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "f32-preflight-repo-"))
  for (const entry of fs.readdirSync(repoRoot)) {
    if (entry === "node_modules" || entry === ".git" || entry === "audit") continue
    fs.cpSync(path.join(repoRoot, entry), path.join(dest, entry), { recursive: true })
  }
  return dest
}

function runPreflight(root: string, args: string[]): { status: number | null; out: string } {
  const res = spawnSync("bash", ["scripts/deploy-preflight.sh", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SIKANDER_LIVE: "0" },
    timeout: 180_000,
  })
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` }
}

describe("F32 deploy preflight injection (R5-002)", () => {
  it("heredoc regression fixture is exploitable with a crafted profile", () => {
    const marker = path.join(os.tmpdir(), `f32-preflight-inject-fixture-${process.pid}`)
    fs.rmSync(marker, { force: true })
    const evilProfile = `staging", "${STAGING_PROJECT_ID}"); import pathlib; pathlib.Path(${JSON.stringify(marker)}).write_text("pwned"); #`
    spawnSync("bash", [VULNERABLE_FIXTURE, evilProfile, STAGING_PROJECT_ID], { cwd: repoRoot })
    expect(fs.existsSync(marker)).toBe(true)
    fs.rmSync(marker, { force: true })
  })

  it("heredoc fixture is exploitable via crafted --project-id", () => {
    const marker = path.join(os.tmpdir(), `f32-preflight-inject-project-${process.pid}`)
    fs.rmSync(marker, { force: true })
    const evilProjectId = `demo-sikander"); import pathlib; pathlib.Path(${JSON.stringify(marker)}).write_text("pwned"); #`
    spawnSync("bash", [VULNERABLE_FIXTURE, "staging", evilProjectId], { cwd: repoRoot })
    expect(fs.existsSync(marker)).toBe(true)
    fs.rmSync(marker, { force: true })
  })

  it("production deploy-preflight.sh is not exploitable with crafted profile", () => {
    const isolatedRoot = cloneWorkspace()
    const marker = path.join(os.tmpdir(), `f32-preflight-inject-safe-${process.pid}`)
    fs.rmSync(marker, { force: true })
    const evilProfile = `staging", "${STAGING_PROJECT_ID}"); import pathlib; pathlib.Path(${JSON.stringify(marker)}).write_text("pwned"); #`
    runPreflight(isolatedRoot, ["--profile", evilProfile, "--project-id", STAGING_PROJECT_ID])
    expect(fs.existsSync(marker)).toBe(false)
    fs.rmSync(isolatedRoot, { recursive: true, force: true })
  })

  it("production deploy-preflight.sh is not exploitable with crafted --project-id", () => {
    const isolatedRoot = cloneWorkspace()
    const marker = path.join(os.tmpdir(), `f32-preflight-inject-safe-project-${process.pid}`)
    fs.rmSync(marker, { force: true })
    const evilProjectId = `demo-sikander"); import pathlib; pathlib.Path(${JSON.stringify(marker)}).write_text("pwned"); #`
    runPreflight(isolatedRoot, ["--profile", "staging", "--project-id", evilProjectId])
    expect(fs.existsSync(marker)).toBe(false)
    fs.rmSync(isolatedRoot, { recursive: true, force: true })
  })
})
