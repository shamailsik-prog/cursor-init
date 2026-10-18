import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

/**
 * Audit F39, spec ruling 3 (docs/superpowers/specs/2026-10-18-f39-frozen-install-design.md): the frozen-install guard
 * (ci_gates/check_lockfiles.py; Gate G-0 check [18] runs its static checks, the gates job runs it with --npm-ci).
 *
 * Fixture trees are built in temporary directories (offline, no npm). Every "must fail" case asserts the guard's own
 * message, so a missing guard (python3 exits 2 on a missing script) can never satisfy it.
 */

const REPO = process.cwd()
const GUARD = resolve(REPO, "ci_gates/check_lockfiles.py")
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Json = Record<string, unknown>

const PIN = {
  packageManager: "npm@10.9.9",
  devEngines: { packageManager: { name: "npm", version: "~10.9.0", onFail: "error" } },
}

const ROOT_MANIFEST: Json = {
  name: "fixture-app",
  version: "1.0.0",
  private: true,
  scripts: { build: "node build.mjs", "functions:build": "npm --prefix functions run build" },
  dependencies: { "left-pad": "1.3.0", eve: "^0.56.0" },
  devDependencies: { ms: "^2.1.3" },
  overrides: { eve: { "undici@8.9.0": "8.11.2" } },
  ...PIN,
}

const FUNCTIONS_MANIFEST: Json = {
  name: "functions",
  version: "0.0.0",
  private: true,
  engines: { node: "22" },
  dependencies: { pg: "^8.16.3" },
  devDependencies: { typescript: "^5.6.0" },
  ...PIN,
}

/** The fields npm copies from a manifest into its lockfile's root entry. */
const ROOT_FIELDS = [
  "name",
  "version",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundleDependencies",
  "engines",
  "os",
  "cpu",
  "workspaces",
]

/** A lockfile as npm writes it for the manifest: lockfileVersion 3, the root entry, one entry per direct dependency. */
function lockFor(manifest: Json): Json {
  const root: Json = {}
  for (const field of ROOT_FIELDS) if (manifest[field] !== undefined) root[field] = manifest[field]
  const packages: Record<string, Json> = { "": root }
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries((manifest[field] as Record<string, string>) ?? {})) {
      packages[`node_modules/${name}`] = {
        version: String(spec).replace(/^[\^~]/, ""),
        ...(field === "devDependencies" ? { dev: true } : {}),
      }
    }
  }
  return { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages }
}

function write(root: string, rel: string, body: string | Json): void {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`)
}

const read = (root: string, rel: string): Json => JSON.parse(readFileSync(join(root, rel), "utf8")) as Json

/** A root package and a functions package, each with a lockfile npm would have written, and frozen installs in CI. */
function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "f39-guard-"))
  roots.push(root)
  write(root, "package.json", ROOT_MANIFEST)
  write(root, "package-lock.json", lockFor(ROOT_MANIFEST))
  write(root, "functions/package.json", FUNCTIONS_MANIFEST)
  write(root, "functions/package-lock.json", lockFor(FUNCTIONS_MANIFEST))
  write(
    root,
    ".github/workflows/ci.yml",
    [
      "name: CI",
      "on: [pull_request]",
      "jobs:",
      "  unit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          cache: npm",
      "      - run: npm ci",
      "      - run: npm --prefix functions ci",
      "      - run: npm run test:unit",
      "",
    ].join("\n"),
  )
  return root
}

function guard(root: string, ...args: string[]): { code: number; out: string } {
  const r = spawnSync("python3", ["-I", GUARD, "--root", root, ...args], { encoding: "utf8" })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}

function editManifest(root: string, rel: string, edit: (m: Json) => void): void {
  const m = read(root, rel)
  edit(m)
  write(root, rel, m)
}

const deps = (m: Json, field = "dependencies") => m[field] as Record<string, string>

function expectFail(root: string, ...messages: string[]): string {
  const r = guard(root)
  for (const message of messages) expect(r.out).toContain(message)
  expect(r.out).toContain("=== lockfile guard FAILED")
  expect(r.code).toBe(1)
  return r.out
}

describe("F39 lockfile guard: manifests and lockfiles agree (ci_gates/check_lockfiles.py)", () => {
  it("passes a tree whose lockfiles npm wrote from their manifests, pinned, with frozen installs", () => {
    const r = guard(tree())
    expect(r.out).toContain("PASS: 2 lockfiles match their manifests (functions/package-lock.json, package-lock.json)")
    expect(r.out).toContain("PASS: npm pinned to npm@10.9.9 (devEngines ~10.9.0, onFail error) in 2 manifests")
    expect(r.out).toContain("PASS: install surfaces install frozen (npm ci)")
    expect(r.code).toBe(0)
  })

  it("fails a range edited in package.json only, which npm ci itself tolerates (the locked 1.3.0 satisfies ^1.3.0)", () => {
    const root = tree()
    editManifest(root, "package.json", (m) => {
      deps(m)["left-pad"] = "^1.3.0"
    })
    expectFail(root, 'package-lock.json: root entry dependencies.left-pad is "1.3.0" but package.json says "^1.3.0"')
  })

  it("fails a dependency added to package.json and not to the lock", () => {
    const root = tree()
    editManifest(root, "package.json", (m) => {
      deps(m).zod = "4.5.4"
    })
    expectFail(
      root,
      'package-lock.json: root entry dependencies.zod is (absent) but package.json says "4.5.4"',
      "package-lock.json: dependencies.zod has no node_modules/zod entry",
    )
  })

  it("fails a dev dependency removed from package.json and left in the lock", () => {
    const root = tree()
    editManifest(root, "package.json", (m) => {
      delete m.devDependencies
    })
    expectFail(root, 'package-lock.json: root entry devDependencies.ms is "^2.1.3" but package.json says (absent)')
  })

  it("fails a version change in the root package, and engines drift in the functions package", () => {
    const root = tree()
    editManifest(root, "package.json", (m) => {
      m.version = "1.0.1"
    })
    editManifest(root, "functions/package.json", (m) => {
      m.engines = { node: "24" }
    })
    expectFail(
      root,
      'package-lock.json: root entry version is "1.0.0" but package.json says "1.0.1"',
      'functions/package-lock.json: root entry engines.node is "22" but functions/package.json says "24"',
    )
  })

  it("treats an empty dependency map as absent, as npm does", () => {
    const root = tree()
    editManifest(root, "functions/package.json", (m) => {
      m.optionalDependencies = {}
    })
    const r = guard(root)
    expect(r.out).toContain("PASS: 2 lockfiles match their manifests")
    expect(r.code).toBe(0)
  })

  it("fails a lockfile without a manifest and a manifest with dependencies but no lockfile", () => {
    const root = tree()
    write(root, "tools/orphan/package-lock.json", lockFor({ name: "orphan", version: "1.0.0" }))
    write(root, "tools/unlocked/package.json", { name: "unlocked", version: "1.0.0", dependencies: { ms: "2.1.3" } })
    // A manifest that declares nothing to install needs no lockfile.
    write(root, "lib/esm/package.json", { type: "module" })
    const out = expectFail(
      root,
      "tools/orphan/package-lock.json: no package.json beside it",
      "tools/unlocked/package.json: declares dependencies but has no package-lock.json beside it",
    )
    expect(out).not.toContain("lib/esm/package.json")
  })

  it("fails a manifest with overrides and no lockfile", () => {
    const root = tree()
    write(root, "tools/overrides-only/package.json", { name: "o", version: "1.0.0", overrides: { ms: "2.1.2" } })
    expectFail(root, "tools/overrides-only/package.json: declares dependencies but has no package-lock.json beside it")
  })

  it("fails a foreign lockfile: the pinned package manager is npm", () => {
    const root = tree()
    write(root, "yarn.lock", "# yarn lockfile v1\n")
    write(root, "functions/pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
    expectFail(
      root,
      "yarn.lock: foreign lockfile (the pinned package manager is npm)",
      "functions/pnpm-lock.yaml: foreign lockfile (the pinned package manager is npm)",
    )
  })

  it("fails a lockfile that is not lockfileVersion 3, or has no root entry", () => {
    const root = tree()
    const lock = read(root, "package-lock.json")
    lock.lockfileVersion = 2
    write(root, "package-lock.json", lock)
    const fnLock = read(root, "functions/package-lock.json")
    delete (fnLock.packages as Record<string, unknown>)[""]
    write(root, "functions/package-lock.json", fnLock)
    expectFail(
      root,
      "package-lock.json: lockfileVersion 2, expected 3 (regenerate it with the pinned npm)",
      'functions/package-lock.json: no root entry (packages[""])',
    )
  })

  it("fails a lockfile that is not JSON", () => {
    const root = tree()
    write(root, "functions/package-lock.json", "{ not json")
    expectFail(root, "functions/package-lock.json: not valid JSON")
  })

  it("fails closed without a root manifest, and without a root lockfile", () => {
    const empty = mkdtempSync(join(tmpdir(), "f39-guard-empty-"))
    roots.push(empty)
    expectFail(empty, "package.json: missing at the repository root")

    const root = tree()
    rmSync(join(root, "package-lock.json"))
    expectFail(root, "package.json: declares dependencies but has no package-lock.json beside it")
  })

  it("skips node_modules, build caches, test fixture directories and nested git worktrees", () => {
    const root = tree()
    const drifted = { name: "x", version: "1.0.0", dependencies: { ms: "^2.1.3" } }
    const skipped = [
      "node_modules/eve",
      "functions/node_modules/pg",
      ".next",
      ".stryker-tmp/sandbox-1",
      "tests/fixtures/app",
      ".claude/worktrees/agent-1",
    ]
    for (const dir of skipped) {
      write(root, `${dir}/package.json`, drifted)
      write(root, `${dir}/package-lock.json`, lockFor({ ...drifted, dependencies: { ms: "2.1.3" } }))
      write(root, `${dir}/yarn.lock`, "# yarn\n")
    }
    // A git worktree (or nested repository) holds its own .git; it is another checkout, not part of this tree.
    write(root, ".claude/worktrees/agent-1/.git", "gitdir: /elsewhere/.git/worktrees/agent-1\n")
    const r = guard(root)
    expect(r.out).toContain("PASS: 2 lockfiles match their manifests")
    expect(r.code).toBe(0)
  })
})

describe("F39 lockfile guard: the npm pin (packageManager + devEngines)", () => {
  type PinCase = { name: string; file: string; edit: (m: Json) => void; message: string }
  const devEngines = (m: Json) => (m.devEngines as { packageManager: Record<string, string> }).packageManager
  const PIN_CASES: PinCase[] = [
    { name: "no packageManager", file: "package.json", edit: (m) => void delete m.packageManager, message: "package.json: no packageManager (expected npm@X.Y.Z)" },
    { name: "packageManager not npm", file: "package.json", edit: (m) => void (m.packageManager = "yarn@4.5.0"), message: 'package.json: packageManager "yarn@4.5.0" is not npm@X.Y.Z' },
    { name: "no devEngines", file: "functions/package.json", edit: (m) => void delete m.devEngines, message: "functions/package.json: no devEngines.packageManager pin" },
    { name: "devEngines not npm", file: "package.json", edit: (m) => void (devEngines(m).name = "pnpm"), message: 'package.json: devEngines.packageManager.name is "pnpm", expected "npm"' },
    { name: "warn-only pin", file: "package.json", edit: (m) => void (devEngines(m).onFail = "warn"), message: 'package.json: devEngines.packageManager.onFail is "warn", expected "error"' },
    { name: "floating range", file: "package.json", edit: (m) => void (devEngines(m).version = "^10.9.0"), message: 'package.json: devEngines.packageManager.version "^10.9.0" is not a pin (use ~X.Y.0 or X.Y.Z)' },
    { name: "packageManager outside the range", file: "package.json", edit: (m) => void (m.packageManager = "npm@11.19.1"), message: "package.json: packageManager npm@11.19.1 is outside devEngines.packageManager.version ~10.9.0" },
    { name: "two manifests disagree", file: "functions/package.json", edit: (m) => void (m.packageManager = "npm@10.9.8"), message: "functions/package.json: npm pin npm@10.9.8 (~10.9.0) differs from package.json's npm@10.9.9 (~10.9.0)" },
  ]

  it.each(PIN_CASES)("fails: $name", ({ file, edit, message }) => {
    const root = tree()
    editManifest(root, file, edit)
    expectFail(root, message)
  })

  it("accepts an exact devEngines version equal to packageManager", () => {
    const root = tree()
    for (const file of ["package.json", "functions/package.json"]) {
      editManifest(root, file, (m) => void (devEngines(m).version = "10.9.9"))
    }
    const r = guard(root)
    expect(r.out).toContain("PASS: npm pinned to npm@10.9.9 (devEngines 10.9.9, onFail error) in 2 manifests")
    expect(r.code).toBe(0)
  })
})

describe("F39 lockfile guard: install surfaces install frozen", () => {
  const surfaceTree = (rel: string, body: string) => {
    const root = tree()
    write(root, rel, body)
    return root
  }
  const workflow = (run: string) =>
    ["name: X", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v4", `      - run: ${run}`, ""].join("\n")

  it.each([
    ["npm install", 'non-frozen npm command "npm install"'],
    ["npm i", 'non-frozen npm command "npm i"'],
    ["npm --prefix functions install", 'non-frozen npm command "npm --prefix functions install"'],
    ["npm install --no-audit --no-fund", 'non-frozen npm command "npm install --no-audit --no-fund"'],
    ["npm add left-pad", 'non-frozen npm command "npm add left-pad"'],
    ["npm isntall", 'non-frozen npm command "npm isntall"'],
    ["npm update", 'non-frozen npm command "npm update"'],
    ["npm it", 'non-frozen npm command "npm it"'],
    ["npm uninstall left-pad", 'non-frozen npm command "npm uninstall left-pad"'],
    ["npm dedupe", 'non-frozen npm command "npm dedupe"'],
    ["npm ci && npm --prefix functions i", 'non-frozen npm command "npm --prefix functions i"'],
    ["npm ci --package-lock=false", '"--package-lock=false" skips the lockfile'],
    ["npm ci --no-package-lock", '"--no-package-lock" skips the lockfile'],
  ])("a workflow running `%s` fails", (run, message) => {
    const root = surfaceTree(".github/workflows/x.yml", workflow(run))
    expectFail(root, `.github/workflows/x.yml:7: ${message}`)
  })

  it("the Cursor environment, a Claude hook and a package script are install surfaces too", () => {
    const root = tree()
    write(root, ".cursor/environment.json", { install: "npm install && npm --prefix functions ci" })
    write(root, ".claude/hooks/session-start.sh", '#!/bin/bash\nset -e\nnpm install --prefix "$dir" --no-audit\n')
    editManifest(root, "package.json", (m) => {
      ;(m.scripts as Record<string, string>).setup = "npm install && npm run build"
    })
    expectFail(
      root,
      '.cursor/environment.json:2: non-frozen npm command "npm install"',
      '.claude/hooks/session-start.sh:3: non-frozen npm command "npm install --prefix"',
      'package.json: scripts.setup: non-frozen npm command "npm install"',
    )
  })

  it("passes frozen installs, global tool installs, npx, pip, scripts named install-something and comments", () => {
    const root = surfaceTree(
      ".github/workflows/ok.yml",
      [
        "name: OK",
        "jobs:",
        "  a:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/setup-node@v4",
        "        with:",
        "          cache: npm",
        "      # npm install would rewrite the lock; this job never runs it.",
        "      - run: npm ci && npm --prefix functions ci",
        "      - run: npm ci --prefix functions --no-audit --no-fund",
        "      - run: npm install -g npm@10.9.9",
        "      - run: npm i --global firebase-tools",
        "      - run: npm install --location=global corepack",
        "      - run: npx playwright install chromium --with-deps",
        "      - run: python -m pip install -r corpus_service/requirements-test.txt",
        "      - run: npm run install-deps",
        "      - name: npm audit (root, production dependencies)",
        "        run: npm audit --omit=dev --json > audit/npm-root.json || true",
        "      - run: node ci_gates/check_known_advisories.mjs --npm npm:root=audit/npm-root.json",
        "",
      ].join("\n"),
    )
    write(root, ".claude/hooks/session-start.sh", '#!/bin/bash\n# npm ci installs exactly what the lockfile pins.\nnpm ci --prefix "$dir" --no-audit\n')
    const r = guard(root)
    expect(r.out).toContain("PASS: install surfaces install frozen (npm ci)")
    expect(r.code).toBe(0)
  })
})

describe("F39 lockfile guard: --npm-ci runs the pinned npm's own validator", () => {
  /** A stand-in npm that reports a version and records every argv it was called with. */
  function stubNpm(root: string, version: string, ciExit: number, ciOutput = ""): { bin: string; calls: string } {
    const bin = join(root, ".stub", "npm")
    const calls = join(root, ".stub", "calls.log")
    write(
      root,
      ".stub/npm",
      [
        "#!/bin/sh",
        `if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi`,
        `echo "$@" >> "${calls}"`,
        `printf '%b\\n' "${ciOutput}"`,
        `exit ${ciExit}`,
        "",
      ].join("\n"),
    )
    chmodSync(bin, 0o755)
    return { bin, calls }
  }

  it("refuses an npm outside the pin before running npm ci", () => {
    const root = tree()
    const npm = stubNpm(root, "11.19.1", 0)
    const r = guard(root, "--npm-ci", "--npm", npm.bin)
    expect(r.out).toContain("npm 11.19.1 is outside the pin ~10.9.0 (package.json devEngines.packageManager)")
    expect(r.out).toContain("=== lockfile guard FAILED")
    expect(r.code).toBe(1)
    expect(existsSync(npm.calls)).toBe(false)
  })

  it("runs npm ci --dry-run per lockfile directory with an explicit prefix, and passes when npm accepts both", () => {
    const root = tree()
    const npm = stubNpm(root, "10.9.9", 0)
    const r = guard(root, "--npm-ci", "--npm", npm.bin)
    expect(r.out).toContain("PASS: npm ci --dry-run package-lock.json (npm 10.9.9)")
    expect(r.out).toContain("PASS: npm ci --dry-run functions/package-lock.json (npm 10.9.9)")
    expect(r.code).toBe(0)
    const calls = readFileSync(npm.calls, "utf8").trim().split("\n").sort()
    expect(calls).toEqual(
      [
        `ci --dry-run --ignore-scripts --no-audit --no-fund --prefix ${join(root, "functions")}`,
        `ci --dry-run --ignore-scripts --no-audit --no-fund --prefix ${root}`,
      ].sort(),
    )
  })

  it("fails with npm's own error lines when npm ci would fail", () => {
    const root = tree()
    const npm = stubNpm(root, "10.9.9", 1, "npm error code EUSAGE\\nnpm error Missing: ms@2.1.2 from lock file")
    const r = guard(root, "--npm-ci", "--npm", npm.bin)
    expect(r.out).toContain("package-lock.json: npm ci --dry-run exit 1 under npm 10.9.9")
    expect(r.out).toContain("npm error Missing: ms@2.1.2 from lock file")
    expect(r.out).toContain("=== lockfile guard FAILED")
    expect(r.code).toBe(1)
  })

  it("fails closed when the npm version cannot be read", () => {
    const root = tree()
    const r = guard(root, "--npm-ci", "--npm", join(root, "no-such-npm"))
    expect(r.out).toContain("cannot run npm --version")
    expect(r.out).toContain("=== lockfile guard FAILED")
    expect(r.code).toBe(1)
  })
})

describe("F39 lockfile guard: review round (Codex P2 x2 on PR #66)", () => {
  const TWO_LOCKS =
    "functions/npm-shrinkwrap.json and functions/package-lock.json: two lockfiles in one directory; npm ci uses " +
    "npm-shrinkwrap.json and ignores package-lock.json (keep one)"

  it("P2-1: fails a valid package-lock.json beside an npm-shrinkwrap.json at lockfileVersion 2 (npm ci uses the shrinkwrap)", () => {
    const root = tree()
    const shrinkwrap = lockFor(FUNCTIONS_MANIFEST)
    shrinkwrap.lockfileVersion = 2
    write(root, "functions/npm-shrinkwrap.json", shrinkwrap)
    expectFail(root, TWO_LOCKS)
  })

  it("P2-1: fails two lockfiles in one directory even when both match the manifest", () => {
    const root = tree()
    write(root, "functions/npm-shrinkwrap.json", lockFor(FUNCTIONS_MANIFEST))
    expectFail(root, TWO_LOCKS)
  })

  it("P2-1: a shrinkwrap on its own is the lockfile checked: a matching one passes, a drifted one fails", () => {
    const root = tree()
    renameSync(join(root, "functions/package-lock.json"), join(root, "functions/npm-shrinkwrap.json"))
    const ok = guard(root)
    expect(ok.out).toContain("PASS: 2 lockfiles match their manifests (functions/npm-shrinkwrap.json, package-lock.json)")
    expect(ok.code).toBe(0)

    const shrinkwrap = read(root, "functions/npm-shrinkwrap.json")
    shrinkwrap.lockfileVersion = 2
    write(root, "functions/npm-shrinkwrap.json", shrinkwrap)
    expectFail(root, "functions/npm-shrinkwrap.json: lockfileVersion 2, expected 3 (regenerate it with the pinned npm)")
  })

  it("P2-2: fails a root package.json that declares no dependencies and has no lockfile (npm ci needs one)", () => {
    const root = mkdtempSync(join(tmpdir(), "f39-guard-bare-"))
    roots.push(root)
    write(root, "package.json", { name: "bare", version: "1.0.0", private: true, ...PIN })
    expectFail(root, "package.json: no lockfile at the repository root (npm ci fails without one)")
  })

  it("P2-2: fails an install surface that runs npm ci in a directory without a lockfile or without a package.json", () => {
    const root = tree()
    // Declares nothing, so only the install surface below makes its missing lockfile a failure.
    write(root, "tools/site/package.json", { name: "site", version: "1.0.0", private: true })
    write(
      root,
      ".github/workflows/x.yml",
      [
        "name: X",
        "jobs:",
        "  a:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - run: npm --prefix tools/site ci",
        "      - run: npm ci --prefix=./tools/site/ --no-audit",
        "      - run: npm clean-install -C tools/docs",
        "",
      ].join("\n"),
    )
    expectFail(
      root,
      ".github/workflows/x.yml:7: npm ci runs in tools/site, which has no lockfile (npm ci fails without one)",
      ".github/workflows/x.yml:8: npm ci runs in tools/site, which has no lockfile (npm ci fails without one)",
      ".github/workflows/x.yml:9: npm ci runs in tools/docs, which has no package.json",
    )
  })

  it("P2-2: npm ci where a lockfile exists passes, and a prefix held in a variable is not guessed", () => {
    const root = tree()
    write(root, "tools/site/package.json", { name: "site", version: "1.0.0", private: true })
    write(root, ".claude/hooks/session-start.sh", '#!/bin/bash\nfor dir in . functions; do npm ci --prefix "$dir"; done\n')
    write(root, ".cursor/environment.json", { install: "npm ci && npm --prefix ./functions ci && npm ci --prefix=functions/" })
    const r = guard(root)
    expect(r.out).toContain("PASS: install surfaces install frozen (npm ci)")
    expect(r.code).toBe(0)
  })
})

describe("F39 lockfile guard: review round 2 (Copilot, thread 4305283954): quoting and npm ci targets", () => {
  const ALLOWLIST = "ci_gates/lockfile_install_allowlist.json"
  const workflowWith = (...lines: string[]) =>
    ["name: X", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v4", ...lines, ""].join("\n")
  const vouch = (root: string, entries: Json[]) => write(root, ALLOWLIST, { entries })

  // A quote must never end the command before the subcommand is read (the guard used to stop at the first quote).
  it.each([
    ["npm --prefix \"functions\" install", 'non-frozen npm command "npm --prefix functions install"'],
    ["npm --prefix '$dir' i", 'non-frozen npm command "npm --prefix $dir i"'],
    ['npm -C "x" add foo', 'non-frozen npm command "npm -C x add foo"'],
    ['npm "install"', 'non-frozen npm command "npm install"'],
    ['npm --prefix "a\\"b" install', 'non-frozen npm command "npm --prefix a\\"b install"'],
    ['bash -c "npm ci && npm install"', 'non-frozen npm command "npm install"'],
    ['bash -c "true; npm i left-pad"', 'non-frozen npm command "npm i left-pad"'],
    ['bash -c "echo y | npm add left-pad"', 'non-frozen npm command "npm add left-pad"'],
    ["sh -c 'cd functions && npm update'", 'non-frozen npm command "npm update"'],
  ])("a workflow running `%s` fails", (run, message) => {
    const root = tree()
    write(root, ".github/workflows/x.yml", workflowWith(`      - run: ${run}`))
    expectFail(root, `.github/workflows/x.yml:7: ${message}`)
  })

  it("a quoted option value does not hide an install in a hook, the Cursor environment or a package script", () => {
    const root = tree()
    write(root, ".claude/hooks/session-start.sh", '#!/bin/bash\nnpm --prefix "$dir" install\n')
    write(root, ".cursor/environment.json", { install: 'npm --prefix "functions" install' })
    editManifest(root, "package.json", (m) => {
      ;(m.scripts as Record<string, string>).setup = 'npm --prefix "functions" install'
    })
    expectFail(
      root,
      '.claude/hooks/session-start.sh:2: non-frozen npm command "npm --prefix $dir install"',
      '.cursor/environment.json:2: non-frozen npm command "npm --prefix functions install"',
      'package.json: scripts.setup: non-frozen npm command "npm --prefix functions install"',
    )
  })

  it("fails closed on a line that mentions npm but cannot be read as shell (unbalanced quote)", () => {
    const root = tree()
    write(root, ".github/workflows/x.yml", workflowWith('      - run: npm ci "unterminated'))
    expectFail(root, ".github/workflows/x.yml:7: cannot read this line as shell commands")
  })

  it("follows a step's working-directory, inline and in a run block", () => {
    const root = tree()
    write(root, "tools/site/package.json", { name: "site", version: "1.0.0", private: true })
    write(
      root,
      ".github/workflows/x.yml",
      workflowWith(
        "      - name: inline",
        "        working-directory: tools/site",
        "        run: npm ci",
        "      - name: block",
        "        working-directory: ./tools/site/",
        "        run: |",
        "          echo installing",
        "          npm ci --no-audit",
        "      - working-directory: functions",
        "        run: npm ci",
      ),
    )
    const out = expectFail(
      root,
      ".github/workflows/x.yml:9: npm ci runs in tools/site, which has no lockfile (npm ci fails without one)",
      ".github/workflows/x.yml:14: npm ci runs in tools/site, which has no lockfile (npm ci fails without one)",
    )
    expect(out).not.toContain("x.yml:16")
  })

  it("follows a preceding cd in the same run block, and a cd it cannot read makes the target unknown", () => {
    const root = tree()
    write(root, "tools/site/package.json", { name: "site", version: "1.0.0", private: true })
    write(
      root,
      ".github/workflows/x.yml",
      workflowWith(
        "      - run: cd tools/site && npm ci",
        "      - run: cd functions && npm ci",
        "      - run: |",
        "          cd tools",
        "          cd site",
        "          npm ci",
        '      - run: cd "$GITHUB_WORKSPACE/app" && npm ci',
      ),
    )
    const out = expectFail(
      root,
      ".github/workflows/x.yml:7: npm ci runs in tools/site, which has no lockfile (npm ci fails without one)",
      ".github/workflows/x.yml:12: npm ci runs in tools/site, which has no lockfile (npm ci fails without one)",
      ".github/workflows/x.yml:13: npm ci target cannot be read (the working directory comes from cd $GITHUB_WORKSPACE/app)",
    )
    expect(out).not.toContain("x.yml:8")
  })

  it("a job-level default working-directory, or a --prefix held in a variable, is an unknown target that fails closed", () => {
    const root = tree()
    write(
      root,
      ".github/workflows/x.yml",
      [
        "name: X",
        "jobs:",
        "  a:",
        "    runs-on: ubuntu-latest",
        "    defaults:",
        "      run:",
        "        working-directory: functions",
        "    steps:",
        "      - run: npm ci",
        '      - run: npm ci --prefix "$PKG"',
        "",
      ].join("\n"),
    )
    expectFail(
      root,
      ".github/workflows/x.yml:9: npm ci target cannot be read (a workflow or job default working-directory is not followed)",
      ".github/workflows/x.yml:10: npm ci target cannot be read (--prefix $PKG is held in a variable)",
    )
  })

  it("an unknown target passes only when the allowlist vouches for it, and the vouched directories are checked", () => {
    const hook = '#!/bin/bash\ninstall_pkg() {\n  npm ci --prefix "$1" --no-audit\n}\ninstall_pkg .\ninstall_pkg functions\n'
    const entry = {
      surface: ".claude/hooks/session-start.sh",
      command: "npm ci --prefix $1 --no-audit",
      directories: [".", "functions"],
      reason: "install_pkg is called for . and functions",
    }

    const unvouched = tree()
    write(unvouched, ".claude/hooks/session-start.sh", hook)
    expectFail(unvouched, ".claude/hooks/session-start.sh:3: npm ci target cannot be read (--prefix $1 is held in a variable)")

    const vouched = tree()
    write(vouched, ".claude/hooks/session-start.sh", hook)
    vouch(vouched, [entry])
    const ok = guard(vouched)
    expect(ok.out).toContain("PASS: install surfaces install frozen (npm ci)")
    expect(ok.code).toBe(0)

    const wrongDir = tree()
    write(wrongDir, ".claude/hooks/session-start.sh", hook)
    vouch(wrongDir, [{ ...entry, directories: [".", "tools/site"] }])
    expectFail(wrongDir, ".claude/hooks/session-start.sh:3: npm ci runs in tools/site (vouched in ci_gates/lockfile_install_allowlist.json), which has no package.json")
  })

  it("a stale or malformed allowlist entry fails", () => {
    const stale = tree()
    vouch(stale, [{ surface: ".claude/hooks/session-start.sh", command: "npm ci --prefix $dir", directories: ["."], reason: "gone" }])
    expectFail(stale, 'ci_gates/lockfile_install_allowlist.json: stale entry for .claude/hooks/session-start.sh "npm ci --prefix $dir"')

    const malformed = tree()
    vouch(malformed, [{ surface: ".claude/hooks/session-start.sh", command: "npm ci --prefix $dir", directories: ["."] }])
    expectFail(malformed, "ci_gates/lockfile_install_allowlist.json: entry 1 needs surface, command, directories and reason")
  })
})
