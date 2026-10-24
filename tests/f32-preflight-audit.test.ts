import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const repoRoot = process.cwd()
const STAGING_PROJECT_ID = "demo-sikander"

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

describe("F32 deploy preflight (R3-001 / R3-004)", () => {
  let isolatedRoot: string

  beforeAll(() => {
    isolatedRoot = cloneWorkspace()
  }, 300_000)

  afterAll(() => {
    fs.rmSync(isolatedRoot, { recursive: true, force: true })
  })

  it("refuses to run without --project-id", () => {
    const result = runPreflight(isolatedRoot, ["--profile", "staging"])
    expect(result.status).not.toBe(0)
    expect(result.out).toMatch(/project-id/i)
  })

  it("rejects an env file outside functions/.env.<projectId>", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f32-preflight-"))
    const envFile = path.join(dir, "bad.env")
    fs.writeFileSync(
      envFile,
      "SIKANDER_INGRESS_SETTINGS=ALLOW_INTERNAL_AND_GCLB\nTRUSTED_PROXY_HOPS=1\n",
    )
    const result = runPreflight(isolatedRoot, [
      "--profile",
      "staging",
      "--project-id",
      STAGING_PROJECT_ID,
      "--env-file",
      envFile,
    ])
    expect(result.status).not.toBe(0)
    expect(result.out).toMatch(new RegExp(`functions/\\.env\\.${STAGING_PROJECT_ID}`))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("rejects when functions/.env.<projectId> is missing", () => {
    const missingProject = "f32-no-such-deploy-env"
    const result = runPreflight(isolatedRoot, ["--profile", "staging", "--project-id", missingProject])
    expect(result.status).not.toBe(0)
    expect(result.out).toMatch(new RegExp(`functions/\\.env\\.${missingProject}`))
  })

  it("rejects production preflight when --project-id is the staging project", () => {
    const canonical = path.join(isolatedRoot, "functions", `.env.${STAGING_PROJECT_ID}`)
    expect(fs.existsSync(canonical)).toBe(true)
    const result = runPreflight(isolatedRoot, ["--profile", "production", "--project-id", STAGING_PROJECT_ID])
    expect(result.status).not.toBe(0)
    expect(result.out).toMatch(/project-id|gcpProjectId|profile/i)
  })

  it("rejects an env file whose effective values are wrong (dotenv last-wins)", () => {
    const canonical = path.join(isolatedRoot, "functions", `.env.${STAGING_PROJECT_ID}`)
    fs.writeFileSync(
      canonical,
      "SIKANDER_INGRESS_SETTINGS=ALLOW_INTERNAL_AND_GCLB\nTRUSTED_PROXY_HOPS=1\nSIKANDER_INGRESS_SETTINGS=ALLOW_ALL\n",
    )
    const result = runPreflight(isolatedRoot, ["--profile", "staging", "--project-id", STAGING_PROJECT_ID])
    expect(result.status).not.toBe(0)
    fs.writeFileSync(
      canonical,
      "SIKANDER_INGRESS_SETTINGS=ALLOW_INTERNAL_AND_GCLB\nTRUSTED_PROXY_HOPS=1\n",
    )
  })

  it("rejects commented-out contract values masquerading as set", () => {
    const canonical = path.join(isolatedRoot, "functions", `.env.${STAGING_PROJECT_ID}`)
    fs.writeFileSync(
      canonical,
      "# SIKANDER_INGRESS_SETTINGS=ALLOW_INTERNAL_AND_GCLB\n# TRUSTED_PROXY_HOPS=1\nSIKANDER_INGRESS_SETTINGS=ALLOW_ALL\nTRUSTED_PROXY_HOPS=0\n",
    )
    const result = runPreflight(isolatedRoot, ["--profile", "staging", "--project-id", STAGING_PROJECT_ID])
    expect(result.status).not.toBe(0)
    fs.writeFileSync(
      canonical,
      "SIKANDER_INGRESS_SETTINGS=ALLOW_INTERNAL_AND_GCLB\nTRUSTED_PROXY_HOPS=1\n",
    )
  })

  it("does not execute Python via crafted --profile (R4-003)", () => {
    const marker = path.join(os.tmpdir(), `f32-preflight-inject-${process.pid}`)
    fs.rmSync(marker, { force: true })
    const evilProfile = `staging"); import pathlib; pathlib.Path(${JSON.stringify(marker)}).write_text("pwned"); #`
    runPreflight(isolatedRoot, ["--profile", evilProfile, "--project-id", STAGING_PROJECT_ID])
    expect(fs.existsSync(marker)).toBe(false)
  })

  it("does not mutate the committed repo functions/.env.demo-sikander", () => {
    const committed = path.join(repoRoot, "functions", `.env.${STAGING_PROJECT_ID}`)
    const before = fs.existsSync(committed) ? fs.readFileSync(committed, "utf8") : null
    const canonical = path.join(isolatedRoot, "functions", `.env.${STAGING_PROJECT_ID}`)
    fs.writeFileSync(canonical, "SIKANDER_INGRESS_SETTINGS=ALLOW_ALL\nTRUSTED_PROXY_HOPS=0\n")
    runPreflight(isolatedRoot, ["--profile", "staging", "--project-id", STAGING_PROJECT_ID])
    if (before === null) {
      expect(fs.existsSync(committed)).toBe(false)
    } else {
      expect(fs.readFileSync(committed, "utf8")).toBe(before)
    }
  })
})
