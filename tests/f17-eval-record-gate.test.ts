import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

/**
 * Audit F17, spec ruling 5: the change gate (ci_gates/check_committee_eval_record.py, Gate G-0 check [17]). It reads the
 * committee routing (functions/src/p1/costTable.ts TASK_MODEL and the Next legacy model in platform/p1/constants.ts), the
 * registry version (platform/p1/systemPolicy.ts), the grounding rules version (functions/src/p1/grounding.ts) and the
 * evaluation set, and fails unless docs/evals/committee-brain-eval-record.json names exactly those with a passing
 * result: a model, routing, policy, rules or set change without a matching evaluation record fails, whatever the diff.
 */

const REPO = process.cwd()
const GATE = resolve(REPO, "ci_gates/check_committee_eval_record.py")
const FILES = [
  "functions/src/p1/costTable.ts",
  "platform/p1/constants.ts",
  "platform/p1/systemPolicy.ts",
  "functions/src/p1/grounding.ts",
  "docs/evals/committee-brain-eval-set.json",
  "docs/evals/committee-brain-eval-record.json",
]
const RECORD = "docs/evals/committee-brain-eval-record.json"
const roots: string[] = []
/** The grounding rules and the set version as the repository has them, so the cases below follow a version bump. */
const RULES = /export const GROUNDING_RULES_VERSION = "([^"]+)"/u.exec(readFileSync(join(REPO, "functions/src/p1/grounding.ts"), "utf8"))![1]!
const RULES_DECL = `export const GROUNDING_RULES_VERSION = "${RULES}"`
const SET_VERSION = (JSON.parse(readFileSync(join(REPO, "docs/evals/committee-brain-eval-set.json"), "utf8")) as { version: string }).version

function gate(root: string): { code: number; out: string } {
  const r = spawnSync("python3", ["-I", GATE, "--root", root], { encoding: "utf8" })
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` }
}

/** A copy of the files the gate reads, in a temporary tree. */
function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "f17-eval-gate-"))
  roots.push(root)
  for (const f of FILES) {
    mkdirSync(dirname(join(root, f)), { recursive: true })
    cpSync(join(REPO, f), join(root, f))
  }
  return root
}

const edit = (root: string, file: string, from: string | RegExp, to: string) => {
  const p = join(root, file)
  const before = readFileSync(p, "utf8")
  const after = before.replace(from, to)
  expect(after, `${file}: ${String(from)}`).not.toBe(before)
  writeFileSync(p, after)
}
type EvalRecord = Record<string, unknown> & { evalSet: { items: number; sha256: string }; routing: Record<string, string>; live: unknown; liveNote?: string }
const record = (root: string) => JSON.parse(readFileSync(join(root, RECORD), "utf8")) as EvalRecord
const writeRecord = (root: string, r: Record<string, unknown>) => writeFileSync(join(root, RECORD), `${JSON.stringify(r, null, 2)}\n`)

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe("audit F17: the committee-brain evaluation record gate (spec ruling 5)", () => {
  it("passes on the repository as it stands", () => {
    expect(existsSync(GATE)).toBe(true)
    const r = gate(REPO)
    expect(r.out).toMatch(/^PASS/m)
    expect(r.code).toBe(0)
  })

  it("fails on an unrecorded change of the committee model, and passes once the evaluation is recorded for it", () => {
    const root = tree()
    edit(root, "functions/src/p1/costTable.ts", 'committee: "anthropic/claude-opus-5.5"', 'committee: "vendor/other-model-2"')
    const failed = gate(root)
    expect(failed.code).toBe(1)
    expect(failed.out).toMatch(/FAIL/)
    expect(failed.out).toContain("functions:committee")
    expect(failed.out).toContain("vendor/other-model-2")

    const r = record(root)
    writeRecord(root, { ...r, modelId: "vendor/other-model-2", routing: { ...r.routing, "functions:committee": "vendor/other-model-2" }, date: "2026-10-18" })
    const recorded = gate(root)
    expect(recorded.out).toMatch(/^PASS/m)
    expect(recorded.code).toBe(0)
  })

  it("fails on a new task route that the record does not name", () => {
    const root = tree()
    edit(root, "functions/src/p1/costTable.ts", 'Object.freeze({ committee: "anthropic/claude-opus-5.5" })', 'Object.freeze({ committee: "anthropic/claude-opus-5.5", research: "vendor/cheap-model" })')
    const r = gate(root)
    expect(r.code).toBe(1)
    expect(r.out).toContain("functions:research")
  })

  it("fails on an unrecorded change of the Next legacy committee model", () => {
    const root = tree()
    edit(root, "platform/p1/constants.ts", /COMMITTEE_BRAIN_GATEWAY_MODEL = "[^"]+"/, 'COMMITTEE_BRAIN_GATEWAY_MODEL = "vendor/legacy-2"')
    const r = gate(root)
    expect(r.code).toBe(1)
    expect(r.out).toContain("next:committee-brain")
  })

  it("fails on an unrecorded registry version, and passes once recorded", () => {
    const root = tree()
    edit(root, "platform/p1/systemPolicy.ts", 'SYSTEM_POLICY_VERSION = "f17.1"', 'SYSTEM_POLICY_VERSION = "f17.2"')
    const failed = gate(root)
    expect(failed.code).toBe(1)
    expect(failed.out).toContain("policy")
    writeRecord(root, { ...record(root), policy: { policyId: "committee-brain", version: "f17.2" } })
    expect(gate(root).code).toBe(0)
  })

  it("fails on an unrecorded change of the grounding rules", () => {
    const root = tree()
    edit(root, "functions/src/p1/grounding.ts", RULES_DECL, 'export const GROUNDING_RULES_VERSION = "f17.99"')
    const r = gate(root)
    expect(r.code).toBe(1)
    expect(r.out).toContain("grounding rules")
  })

  it("fails when the evaluation set changes without a new record (its SHA-256)", () => {
    const root = tree()
    edit(root, "docs/evals/committee-brain-eval-set.json", `"version": "${SET_VERSION}"`, `"version": "${SET_VERSION}" `)
    const r = gate(root)
    expect(r.code).toBe(1)
    expect(r.out).toContain("sha256")
  })

  it.each([
    ["a failed result", { result: "fail" }, "result"],
    ["a deterministic failure", { graded: { deterministic: { passed: 56, failed: 1 } } }, "deterministic"],
    ["no NOT RUN note for a live run that did not happen", { live: false, liveNote: "skipped" }, "NOT RUN"],
    ["a live flag that is not a boolean", { live: "no" }, "live"],
    ["a malformed date", { date: "17/10/2026" }, "date"],
    ["a live run with failures", { live: true, liveRun: { passed: 50, failed: 7, date: "2026-10-18" } }, "live"],
  ])("fails on a record with %s", (_label, patch, word) => {
    const root = tree()
    writeRecord(root, { ...record(root), ...patch })
    const r = gate(root)
    expect(r.code).toBe(1)
    expect(r.out).toContain(word)
  })

  // Review round (Codex P2 on PR #63): a live record must name a run of every item with none failed, in integers.
  const ITEMS = record(REPO).evalSet.items
  it.each([
    ["a live run of no item", { passed: 0, failed: 0, date: "2026-10-18" }],
    ["a live run of fewer items than the set", { passed: ITEMS - 1, failed: 0, date: "2026-10-18" }],
    ["a live run of more items than the set", { passed: ITEMS + 1, failed: 0, date: "2026-10-18" }],
    ["a boolean failed count", { passed: ITEMS, failed: false, date: "2026-10-18" }],
    ["a boolean passed count", { passed: true, failed: 0, date: "2026-10-18" }],
    ["a negative failed count", { passed: ITEMS, failed: -1, date: "2026-10-18" }],
    ["a string count", { passed: String(ITEMS), failed: 0, date: "2026-10-18" }],
    ["no passed count", { failed: 0, date: "2026-10-18" }],
    ["no failed count", { passed: ITEMS, date: "2026-10-18" }],
    ["no date", { passed: ITEMS, failed: 0 }],
    ["a date that does not exist", { passed: ITEMS, failed: 0, date: "2026-02-30" }],
    ["a date in another format", { passed: ITEMS, failed: 0, date: "18/10/2026" }],
  ])("fails a live record with %s", (_label, liveRun) => {
    const root = tree()
    writeRecord(root, { ...record(root), live: true, liveNote: undefined, liveRun })
    const r = gate(root)
    expect(r.code, r.out).toBe(1)
    expect(r.out).toContain("live")
  })

  // JSON.stringify never writes 60.0 or 0.0, and Python reads them as floats EQUAL to the integers (60.0 == 60, 0.0 == 0),
  // so a comparison alone accepts them: the counts are written into the record text as a hand edit would write them.
  it.each([
    ["a passed count written as a float (N.0)", `${ITEMS}.0`, "0"],
    ["a passed count written with an exponent (Ne0)", `${ITEMS}e0`, "0"],
    ["a failed count written as a float (0.0)", `${ITEMS}`, "0.0"],
  ])("fails a live record with %s (integers only)", (_label, passed, failed) => {
    const root = tree()
    writeRecord(root, { ...record(root), live: true, liveNote: undefined, liveRun: { passed: ITEMS, failed: 0, date: "2026-10-18" } })
    edit(root, RECORD, `"passed": ${ITEMS},\n    "failed": 0,\n    "date"`, `"passed": ${passed},\n    "failed": ${failed},\n    "date"`)
    const r = gate(root)
    expect(r.code, r.out).toBe(1)
    expect(r.out).toContain("live")
  })

  it.each([
    ["a passed count written as a float (N.0)", `${ITEMS}.0`, "0"],
    ["a failed count written as a float (0.0)", `${ITEMS}`, "0.0"],
  ])("fails a deterministic result with %s (integers only)", (_label, passed, failed) => {
    const root = tree()
    writeRecord(root, { ...record(root), graded: { deterministic: { passed: ITEMS, failed: 0 } } })
    edit(root, RECORD, `"passed": ${ITEMS},\n      "failed": 0\n`, `"passed": ${passed},\n      "failed": ${failed}\n`)
    const r = gate(root)
    expect(r.code, r.out).toBe(1)
    expect(r.out).toContain("deterministic")
  })

  it.each([
    ["a boolean failed count", { passed: ITEMS, failed: false }],
    ["a boolean passed count", { passed: true, failed: 0 }],
    ["a fractional passed count", { passed: ITEMS + 0.5, failed: 0 }],
  ])("fails a deterministic result with %s", (_label, deterministic) => {
    const root = tree()
    writeRecord(root, { ...record(root), graded: { deterministic } })
    const r = gate(root)
    expect(r.code, r.out).toBe(1)
    expect(r.out).toContain("deterministic")
  })

  it("passes with a recorded live run that passed", () => {
    const root = tree()
    const r = record(root)
    writeRecord(root, { ...r, live: true, liveNote: undefined, liveRun: { passed: r.evalSet.items, failed: 0, date: "2026-10-18" } })
    expect(gate(root).code).toBe(0)
  })

  it.each([
    ["the routing is not a literal it can read", "functions/src/p1/costTable.ts", /Object\.freeze\(\{ committee: "[^"]+" \}\)/, "Object.freeze(buildRouting())"],
    ["the registry version is computed", "platform/p1/systemPolicy.ts", 'SYSTEM_POLICY_VERSION = "f17.1"', "SYSTEM_POLICY_VERSION = currentVersion()"],
  ])("fails closed when %s", (_label, file, from, to) => {
    const root = tree()
    edit(root, file, from, to)
    const r = gate(root)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/cannot read/)
  })

  it("fails closed when the record is missing", () => {
    const root = tree()
    rmSync(join(root, RECORD))
    const r = gate(root)
    expect(r.code).toBe(1)
    expect(r.out).toContain("committee-brain-eval-record.json")
  })

  it("the record on the repository names the set by its SHA-256 and states that the live run did not happen", () => {
    const r = record(REPO)
    const set = readFileSync(join(REPO, "docs/evals/committee-brain-eval-set.json"), "utf8")
    expect(r.evalSet.sha256).toBe(createHash("sha256").update(set, "utf8").digest("hex"))
    expect(r.live).toBe(false)
    expect(r.liveNote).toMatch(/^NOT RUN/)
  })
})

// Re-audit L3 (FAIL 6/10 at 63b6fa2): three ways the gate passed a record it should not.
describe("audit F17 re-audit L3: the evaluation record gate's remaining holes", () => {
  /** A UTC day `offset` days from today, as YYYY-MM-DD. */
  const isoDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const ITEMS_NOW = record(REPO).evalSet.items
  const fullRun = (date: string) => ({ passed: ITEMS_NOW, failed: 0, date })

  it.each([
    ["starting NOT RUN", "NOT RUN: AI_GATEWAY_API_KEY is not set."],
    ["saying NOT RUN later on", "The live evaluation: NOT RUN."],
  ])("fails a live record whose note says the run did not happen (%s)", (_label, liveNote) => {
    const root = tree()
    writeRecord(root, { ...record(root), live: true, liveNote, liveRun: fullRun(isoDay(-1)) })
    const r = gate(root)
    expect(r.code, r.out).toBe(1)
    expect(r.out).toContain("NOT RUN")
  })

  it.each([
    ["two days ahead", 2],
    ["years ahead", 3650],
  ])("fails a live run dated in the future (%s)", (_label, days) => {
    const root = tree()
    writeRecord(root, { ...record(root), live: true, liveNote: undefined, liveRun: fullRun(isoDay(days)) })
    const r = gate(root)
    expect(r.code, r.out).toBe(1)
    expect(r.out).toContain("future")
  })

  it("fails a record dated in the future", () => {
    const root = tree()
    writeRecord(root, { ...record(root), date: isoDay(2) })
    const r = gate(root)
    expect(r.code, r.out).toBe(1)
    expect(r.out).toContain("future")
  })

  it("allows one day of clock skew, for the live run and the record", () => {
    const root = tree()
    writeRecord(root, { ...record(root), date: isoDay(1), live: true, liveNote: undefined, liveRun: fullRun(isoDay(1)) })
    const r = gate(root)
    expect(r.code, r.out).toBe(0)
  })

  // A commented-out declaration above the real one: the gate must read the real export, so a changed value with the
  // recorded value left in a comment above it fails, and a stale comment above an unchanged value passes.
  const GR = "functions/src/p1/grounding.ts"
  const CT = "functions/src/p1/costTable.ts"
  const SP = "platform/p1/systemPolicy.ts"
  const ROUTING = 'export const TASK_MODEL: Readonly<Record<TaskType, string>> = Object.freeze({ committee: "anthropic/claude-opus-5.5" })'
  const CHANGED_ROUTING = 'export const TASK_MODEL: Readonly<Record<TaskType, string>> = Object.freeze({ committee: "vendor/other-model-2" })'
  it.each([
    ["the grounding rules, a line comment", GR, RULES_DECL, `// ${RULES_DECL}\nexport const GROUNDING_RULES_VERSION = "f17.99"`],
    ["the grounding rules, a block comment", GR, RULES_DECL, `/*\n${RULES_DECL}\n*/\nexport const GROUNDING_RULES_VERSION = "f17.99"`],
    ["the registry version, a line comment", SP, 'export const SYSTEM_POLICY_VERSION = "f17.1"', '// export const SYSTEM_POLICY_VERSION = "f17.1"\nexport const SYSTEM_POLICY_VERSION = "f17.9"'],
    ["the routing, a line comment", CT, ROUTING, `// ${ROUTING}\n${CHANGED_ROUTING}`],
    ["the routing, a block comment", CT, ROUTING, `/* ${ROUTING} */\n${CHANGED_ROUTING}`],
  ])("fails a changed value hidden behind a commented-out declaration: %s", (_label, file, from, to) => {
    const root = tree()
    edit(root, file, from, to)
    const r = gate(root)
    expect(r.code, r.out).toBe(1)
  })

  it.each([
    ["the grounding rules", GR, RULES_DECL, `// export const GROUNDING_RULES_VERSION = "f17.0"\n${RULES_DECL}`],
    ["the routing", CT, "export const TASK_MODEL:", '/* export const TASK_MODEL = Object.freeze({ committee: "vendor/old" }) */\nexport const TASK_MODEL:'],
  ])("reads the real declaration under a stale comment: %s", (_label, file, from, to) => {
    const root = tree()
    edit(root, file, from, to)
    const r = gate(root)
    expect(r.out).toMatch(/^PASS/m)
    expect(r.code).toBe(0)
  })

  it("does not read a // or /* inside a string as a comment", () => {
    const root = tree()
    edit(root, GR, RULES_DECL, `const NOTE = "see https://example.invalid/a // b /* c"\n${RULES_DECL}`)
    const r = gate(root)
    expect(r.out).toMatch(/^PASS/m)
  })

  it("fails closed on two real declarations", () => {
    const root = tree()
    edit(root, GR, RULES_DECL, `${RULES_DECL}\nexport const GROUNDING_RULES_VERSION = "f17.99"`)
    const r = gate(root)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/cannot read/)
  })

  // Re-audit round 2: a declaration written inside a string or template literal is not a declaration. With the real
  // value computed, the gate must fail closed, not read the literal (the re-auditor's template-literal shadow).
  it.each([
    [
      "the routing, a template literal",
      CT,
      ROUTING,
      'const ROUTES = { committee: "vendor/other-model-2" }\nexport const TASK_MODEL: Readonly<Record<TaskType, string>> = Object.freeze(ROUTES)\nconst NOTE = `' +
        ROUTING +
        "`",
    ],
    ["the grounding rules, a template literal", GR, RULES_DECL, "const NOTE = `\n" + RULES_DECL + "\n`\nexport const GROUNDING_RULES_VERSION = currentRules()"],
    ["the grounding rules, a single-quoted string", GR, RULES_DECL, "const NOTE = '" + RULES_DECL + "'\nexport const GROUNDING_RULES_VERSION = currentRules()"],
  ])("fails closed on a declaration that exists only inside a literal: %s", (_label, file, from, to) => {
    const root = tree()
    edit(root, file, from, to)
    const r = gate(root)
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/cannot read/)
  })

  it.each([
    ["in lower case", "not run: no key"],
    ["inside a sentence", "Ran fine; an earlier attempt was not run."],
  ])("fails a live record whose note says the run did not happen (%s)", (_label, liveNote) => {
    const root = tree()
    writeRecord(root, { ...record(root), live: true, liveNote, liveRun: fullRun(isoDay(-1)) })
    const r = gate(root)
    expect(r.code, r.out).toBe(1)
    expect(r.out).toContain("NOT RUN")
  })
})
