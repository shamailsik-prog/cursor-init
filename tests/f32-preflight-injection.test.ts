import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

const repoRoot = process.cwd()
const STAGING_PROJECT_ID = "demo-sikander"
const VULNERABLE_FIXTURE = path.join(repoRoot, "ci_gates/fixtures/deploy-preflight-heredoc-vulnerable.sh")
const STAGING_ENV_TEMPLATE = path.join(repoRoot, "functions", `.env.${STAGING_PROJECT_ID}`)

function cloneWorkspace(): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "f32-preflight-repo-"))
  for (const entry of fs.readdirSync(repoRoot)) {
    if (entry === "node_modules" || entry === ".git" || entry === "audit") continue
    fs.cpSync(path.join(repoRoot, entry), path.join(dest, entry), { recursive: true })
  }
  return dest
}

function writeDeployEnvForProjectId(root: string, projectId: string): void {
  const envPath = path.join(root, "functions", `.env.${projectId}`)
  fs.mkdirSync(path.dirname(envPath), { recursive: true })
  fs.writeFileSync(envPath, fs.readFileSync(STAGING_ENV_TEMPLATE, "utf8"))
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

describe("F32 deploy preflight injection (R117-004)", () => {
  it("heredoc regression fixture is exploitable with a crafted profile", () => {
    const marker = path.join(os.tmpdir(), `f32-preflight-inject-fixture-${process.pid}`)
    fs.rmSync(marker, { force: true })
    const evilProfile = `staging", "${STAGING_PROJECT_ID}"); import pathlib; pathlib.Path(${JSON.stringify(marker)}).write_text("pwned"); #`
    spawnSync("bash", [VULNERABLE_FIXTURE, evilProfile, STAGING_PROJECT_ID], { cwd: repoRoot })
    expect(fs.existsSync(marker)).toBe(true)
    fs.rmSync(marker, { force: true })
  })

  it("full old preflight heredoc is exploitable via project-id when deploy env file exists", () => {
    const root = cloneWorkspace()
    const envPath = path.join(root, "functions", `.env.${STAGING_PROJECT_ID}`)
    expect(fs.existsSync(envPath)).toBe(true)
    const marker = path.join(os.tmpdir(), `f32-preflight-inject-full-${process.pid}`)
    fs.rmSync(marker, { force: true })
    const evilProjectId = `demo-sikander"); import pathlib; pathlib.Path(${JSON.stringify(marker)}).write_text("pwned"); #`
    const res = spawnSync(
      "bash",
      ["ci_gates/fixtures/deploy-preflight-heredoc-vulnerable-full.sh", "staging", evilProjectId],
      { cwd: root },
    )
    expect(res.status).toBe(0)
    expect(fs.existsSync(marker)).toBe(true)
    fs.rmSync(marker, { force: true })
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("012be148-style heredoc is exploitable when poisoned deploy env path exists", () => {
    const root = cloneWorkspace()
    const marker = path.join(os.tmpdir(), `f32-preflight-inject-012be148-${process.pid}`)
    fs.rmSync(marker, { force: true })
    const evilProjectId = `demo-sikander"); import pathlib; pathlib.Path(${JSON.stringify(marker)}).write_text("pwned"); #`
    writeDeployEnvForProjectId(root, evilProjectId)
    const res = spawnSync(
      "bash",
      ["ci_gates/fixtures/deploy-preflight-heredoc-012be148.sh", "staging", evilProjectId],
      { cwd: root },
    )
    expect(res.status).toBe(0)
    expect(fs.existsSync(marker)).toBe(true)
    fs.rmSync(marker, { force: true })
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("full old preflight heredoc does not run exploit without deploy env file", () => {
    const root = cloneWorkspace()
    fs.unlinkSync(path.join(root, "functions", `.env.${STAGING_PROJECT_ID}`))
    const marker = path.join(os.tmpdir(), `f32-preflight-inject-noenv-${process.pid}`)
    fs.rmSync(marker, { force: true })
    const evilProjectId = `demo-sikander"); import pathlib; pathlib.Path(${JSON.stringify(marker)}).write_text("pwned"); #`
    spawnSync(
      "bash",
      ["ci_gates/fixtures/deploy-preflight-heredoc-vulnerable-full.sh", "staging", evilProjectId],
      { cwd: root },
    )
    expect(fs.existsSync(marker)).toBe(false)
    fs.rmSync(root, { recursive: true, force: true })
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

  it("production deploy-preflight.sh is not exploitable with crafted --project-id even when poisoned env file exists", () => {
    const isolatedRoot = cloneWorkspace()
    const marker = path.join(os.tmpdir(), `f32-preflight-inject-safe-project-${process.pid}`)
    fs.rmSync(marker, { force: true })
    const evilProjectId = `demo-sikander"); import pathlib; pathlib.Path(${JSON.stringify(marker)}).write_text("pwned"); #`
    writeDeployEnvForProjectId(isolatedRoot, evilProjectId)
    runPreflight(isolatedRoot, ["--profile", "staging", "--project-id", evilProjectId])
    expect(fs.existsSync(marker)).toBe(false)
    fs.rmSync(isolatedRoot, { recursive: true, force: true })
  })
})
