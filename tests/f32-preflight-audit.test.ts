import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

const repoRoot = process.cwd()

function runPreflight(args: string[]): { status: number | null; out: string } {
  const res = spawnSync("bash", ["scripts/deploy-preflight.sh", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, SIKANDER_LIVE: "0" },
    timeout: 120_000,
  })
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` }
}

const STAGING_PROJECT_ID = "demo-sikander"

describe("F32 deploy preflight (FA-F32-001)", () => {
  it("refuses to run without --project-id", () => {
    const result = runPreflight(["--profile", "staging"])
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
    const result = runPreflight([
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
    const result = runPreflight(["--profile", "staging", "--project-id", missingProject])
    expect(result.status).not.toBe(0)
    expect(result.out).toMatch(new RegExp(`functions/\\.env\\.${missingProject}`))
  })

  it("rejects an env file whose effective values are wrong (dotenv last-wins)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f32-preflight-"))
    const envFile = path.join(dir, "bad.env")
    fs.writeFileSync(
      envFile,
      "SIKANDER_INGRESS_SETTINGS=ALLOW_INTERNAL_AND_GCLB\nTRUSTED_PROXY_HOPS=1\nSIKANDER_INGRESS_SETTINGS=ALLOW_ALL\n",
    )
    const canonical = path.join(repoRoot, "functions", `.env.${STAGING_PROJECT_ID}`)
    fs.mkdirSync(path.dirname(canonical), { recursive: true })
    fs.writeFileSync(canonical, fs.readFileSync(envFile, "utf8"))
    const result = runPreflight(["--profile", "staging", "--project-id", STAGING_PROJECT_ID])
    expect(result.status).not.toBe(0)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.unlinkSync(canonical)
  })

  it("rejects commented-out contract values masquerading as set", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f32-preflight-"))
    const envFile = path.join(dir, "comment.env")
    fs.writeFileSync(
      envFile,
      "# SIKANDER_INGRESS_SETTINGS=ALLOW_INTERNAL_AND_GCLB\n# TRUSTED_PROXY_HOPS=1\nSIKANDER_INGRESS_SETTINGS=ALLOW_ALL\nTRUSTED_PROXY_HOPS=0\n",
    )
    const canonical = path.join(repoRoot, "functions", `.env.${STAGING_PROJECT_ID}`)
    fs.writeFileSync(canonical, fs.readFileSync(envFile, "utf8"))
    const result = runPreflight(["--profile", "staging", "--project-id", STAGING_PROJECT_ID])
    expect(result.status).not.toBe(0)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.unlinkSync(canonical)
  })
})
