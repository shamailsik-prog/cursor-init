import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

/**
 * Audit F39 end to end (spec docs/superpowers/specs/2026-10-18-f39-frozen-install-design.md, ruling 6): the user flow
 * is a contributor or CI runner doing a clean frozen install from the checked-in manifests.
 *
 * Each case works on a clean copy of the checked-in manifests, lockfiles and install surfaces (no node_modules) and
 * runs the real npm: `npm ci --dry-run` is npm's own lockfile validator, the step `npm ci` runs before it installs.
 * (a) and (b) use the npm on the PATH, which the pin requires to be npm 10.9 (CI's Node 22 line). (c) and (d) use
 * Node 24's bundled npm, 11.19.1, through npx: on main the root `npm ci` failed there with
 * "Missing: undici@8.11.2 from lock file", the failure the audit reported.
 */

const REPO = process.cwd()
const GUARD = resolve(REPO, "ci_gates/check_lockfiles.py")
/** The npm that Node 24.22.0 bundles (nodejs.org/dist/index.json). */
const NODE24_NPM = "11.19.1"
const CHECKED_IN = [
  "package.json",
  "package-lock.json",
  "functions/package.json",
  "functions/package-lock.json",
  ".github/workflows",
  ".cursor/environment.json",
  ".claude/hooks",
  // Vouches for the hook's and the Cursor environment's npm ci targets (review round 2).
  "ci_gates/lockfile_install_allowlist.json",
]
// npx may download npm the first time; a dry run itself takes a few seconds.
const NPM_TIMEOUT_MS = 180_000
const TEST_TIMEOUT_MS = 240_000

const copies: string[] = []
afterAll(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function cleanCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "f39-frozen-"))
  copies.push(dir)
  for (const rel of CHECKED_IN) cpSync(join(REPO, rel), join(dir, rel), { recursive: true })
  return dir
}

type Json = Record<string, unknown>
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Json
function editJson(path: string, edit: (j: Json) => void): void {
  const j = readJson(path)
  edit(j)
  writeFileSync(path, `${JSON.stringify(j, null, 2)}\n`)
}

function run(cmd: string, args: string[], cwd: string): { code: number; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: NPM_TIMEOUT_MS })
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

const guard = (root: string) => run("python3", ["-I", GUARD, "--root", root, "--npm-ci"], root)

/** `npm ci --dry-run` at the copy's root under a given npm release. */
const npmCiDryRun = (version: string, dir: string) =>
  run("npx", ["-y", `npm@${version}`, "ci", "--dry-run", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", dir], dir)

describe("F39 end to end: a clean frozen install from the checked-in manifests", () => {
  it(
    "(a) passes the guard: npm's own npm ci validator accepts both lockfiles under the pinned npm",
    () => {
      const r = guard(cleanCopy())
      expect(r.out).toContain("PASS: 2 lockfiles match their manifests (functions/package-lock.json, package-lock.json)")
      expect(r.out).toMatch(/PASS: npm ci --dry-run package-lock\.json \(npm 10\.9\.\d+\)/)
      expect(r.out).toMatch(/PASS: npm ci --dry-run functions\/package-lock\.json \(npm 10\.9\.\d+\)/)
      expect(r.code).toBe(0)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "(b) fails the guard when an override is added to package.json and not to the lock",
    () => {
      const dir = cleanCopy()
      editJson(join(dir, "package.json"), (m) => {
        ;(m.overrides as Json).ms = "2.1.2"
      })
      const r = guard(dir)
      expect(r.out).toMatch(/package-lock\.json: npm ci --dry-run exit 1 under npm 10\.9\.\d+/)
      expect(r.out).toContain("Missing: ms@2.1.2 from lock file")
      expect(r.out).toContain("=== lockfile guard FAILED")
      expect(r.code).toBe(1)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    `(c) the reported failure: Node 24's npm (${NODE24_NPM}) accepts the checked-in lock; main's override form is rejected`,
    () => {
      // The pin refuses npm 11 by design (case d). devEngines is not part of the lockfile, so taking it out of the
      // copy isolates the question the audit asked: is the checked-in lock valid for this npm?
      const dir = cleanCopy()
      editJson(join(dir, "package.json"), (m) => {
        delete m.devEngines
      })
      const repaired = npmCiDryRun(NODE24_NPM, dir)
      expect(repaired.out).not.toContain("Missing:")
      expect(repaired.out).not.toContain("Invalid:")
      expect(repaired.code).toBe(0)

      // Control: main's eve-scoped override, with the same lock, fails under the same npm.
      editJson(join(dir, "package.json"), (m) => {
        m.overrides = { eve: { undici: "8.11.2" } }
      })
      const preFix = npmCiDryRun(NODE24_NPM, dir)
      expect(preFix.out).toContain("Missing: undici@8.11.2 from lock file")
      expect(preFix.code).toBe(1)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    `(d) the pin refuses npm ${NODE24_NPM} before it resolves anything`,
    () => {
      const r = npmCiDryRun(NODE24_NPM, cleanCopy())
      expect(r.out).toContain("EBADDEVENGINES")
      expect(r.out).toContain(`Invalid semver version "~10.9.0" does not match "${NODE24_NPM}" for "packageManager"`)
      expect(r.code).toBe(1)
    },
    TEST_TIMEOUT_MS,
  )
})
