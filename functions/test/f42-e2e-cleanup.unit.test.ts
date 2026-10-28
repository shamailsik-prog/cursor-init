import { readFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const DELETION_E2E = path.join(__dirname, "f42-retention-deletion.e2e.emu.test.ts")

/** Closes `afterAll(async () => { … }, <timeout>)` — any numeric timeout, not only 120_000. */
const AFTER_ALL_ASYNC_HOOK_CLOSE = /\}\s*,\s*[\d_]+\s*\)/

/**
 * FA-F42-R1-015-001-001 / FA-F42-R1-015-001-001-001-001: regex tempering so the required
 * `deleteFirmScopedData(firms, uids)` cannot sit after the hook body close (Mmove / MmoveT /
 * MmoveNoTO / MmoveOtherTO). Complements AST check for hooks with no timeout argument.
 */
export const AFTER_ALL_DELETE_FIRMS_UIDS_GUARD = new RegExp(
  [
    String.raw`afterAll\s*\(\s*async\s*\(\s*\)\s*=>\s*\{`,
    String.raw`(?:(?!\}\s*,\s*[\d_]+\s*\))[\s\S])*`,
    String.raw`deleteFirmScopedData\s*\(\s*firms\s*,\s*uids\s*\)`,
    String.raw`(?:(?!\}\s*,\s*[\d_]+\s*\))[\s\S])*?`,
    String.raw`\}\s*(?:,\s*[\d_]+\s*)?\)`,
  ].join(""),
)

/** Pre-#188 vacuous span; **MmoveT** still matches this while failing `AFTER_ALL_DELETE_FIRMS_UIDS_GUARD`. */
export const VACUOUS_AFTER_ALL_DELETE_FIRMS_UIDS_GUARD =
  /afterAll[\s\S]*?deleteFirmScopedData\s*\(\s*firms\s*,\s*uids\s*\)/

const UNIT_SELF = path.join(__dirname, "f42-e2e-cleanup.unit.test.ts")

/** Single production wiring check for `f42-retention-deletion.e2e.emu.test.ts` afterAll cleanup (M4 + tempered regex). */
export function assertF42DeletionE2EAfterAllWiring(src: string, fileName: string): void {
  expect(deleteFirmScopedDataInAfterAllAsyncHook(src, fileName)).toBe(true)
  expect(src).toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
  expect(src).not.toMatch(/deleteFirmScopedData\s*\(\s*\[\s*\]\s*,\s*\[\s*\]\s*\)/)
}

function isDeleteFirmScopedDataFirmsUids(node: ts.CallExpression): boolean {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "deleteFirmScopedData") {
    return false
  }
  if (node.arguments.length !== 2) return false
  const [a0, a1] = node.arguments
  return ts.isIdentifier(a0) && a0.text === "firms" && ts.isIdentifier(a1) && a1.text === "uids"
}

function asyncHookBodyContainsDeleteFirmScopedData(body: ts.ConciseBody): boolean {
  if (!ts.isBlock(body)) return false
  let found = false
  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isDeleteFirmScopedDataFirmsUids(node)) {
      found = true
    }
    ts.forEachChild(node, walk)
  }
  for (const stmt of body.statements) {
    walk(stmt)
  }
  return found
}

function isTopLevelAfterAllAsyncCall(stmt: ts.Statement): ts.ArrowFunction | undefined {
  if (!ts.isExpressionStatement(stmt)) return undefined
  const expr = stmt.expression
  if (!ts.isCallExpression(expr)) return undefined
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== "afterAll") return undefined
  const fn = expr.arguments[0]
  if (!fn || !ts.isArrowFunction(fn)) return undefined
  if (!fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return undefined
  return fn
}

/**
 * True when exactly one **file-top-level** `afterAll(async () => { … })` contains
 * `deleteFirmScopedData(firms, uids)`. Nested hooks (e.g. under `describe.skip`) never run and are rejected (**MdescribeSkip**).
 */
export function deleteFirmScopedDataInAfterAllAsyncHook(source: string, fileName = "fixture.ts"): boolean {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  let matchCount = 0
  for (const stmt of sf.statements) {
    const fn = isTopLevelAfterAllAsyncCall(stmt)
    if (fn && asyncHookBodyContainsDeleteFirmScopedData(fn.body)) {
      matchCount++
    }
  }
  return matchCount === 1
}

describe("FA-F42-R1-015: F42 deletion e2e registers every extra firm and auth user for afterAll cleanup", () => {
  it("records otherFirm (uniq(\"f42x\")) and the low-clearance partner uid", () => {
    const src = readFileSync(DELETION_E2E, "utf8")
    expect(src).toMatch(/const otherFirm = uniq\("f42x"\)[\s\S]*?firms\.push\(otherFirm\)/)
    expect(src).toMatch(
      /const low = await mintIdToken\(\{ firmId: f\.firmId, role: "partner", clearanceLevel: "public" \}\)[\s\S]*?uids\.push\(low\.uid\)/,
    )
  })

  it("afterAll wires deleteFirmScopedData to the file-level firms and uids arrays (kills M4 empty-array mutant)", () => {
    const src = readFileSync(DELETION_E2E, "utf8")
    assertF42DeletionE2EAfterAllWiring(src, DELETION_E2E)
  })

  it("FA-F42-R1-015-001-001-002: vacuous afterAll regex is not wired for production e2e checks (MmoveT control + meta pin)", () => {
    const mmoveTSrc = `
import { afterAll, it } from "vitest"
import { deleteFirmScopedData } from "./firmCleanup"
const firms: string[] = []
const uids: string[] = []
afterAll(async () => {}, 120_000)
it.skip("moved cleanup", async () => { await deleteFirmScopedData(firms, uids) }, 120_000)
`
    expect(mmoveTSrc).toMatch(VACUOUS_AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
    expect(mmoveTSrc).not.toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)

    const unitSrc = readFileSync(UNIT_SELF, "utf8")
    const m4Block = unitSrc.match(
      /it\("afterAll wires deleteFirmScopedData[\s\S]*?\n  \}\)/,
    )?.[0]
    expect(m4Block, "M4 test must delegate to shared wiring helper").toBeTruthy()
    expect(m4Block!).toContain("assertF42DeletionE2EAfterAllWiring")
    expect(m4Block!).not.toMatch(/expect\s*\(\s*src\s*\)\s*\.\s*toMatch\s*\(/)

    const helperBlock = unitSrc.match(
      /export function assertF42DeletionE2EAfterAllWiring[\s\S]*?\n\}/,
    )?.[0]
    expect(helperBlock, "shared wiring helper must use tempered guard constant").toBeTruthy()
    expect(helperBlock!).toMatch(/\bAFTER_ALL_DELETE_FIRMS_UIDS_GUARD\b/)
    expect(helperBlock!).not.toMatch(/\bVACUOUS_AFTER_ALL_DELETE_FIRMS_UIDS_GUARD\b/)
    expect(helperBlock!).not.toMatch(/afterAll\[\\s\\S\]\*\?deleteFirmScopedData/)
  })

  it("FA-F42-R1-015-001-001-002-001: MvacuousConstInHelper (vacuous guard const in helper fails tightened meta pin)", () => {
    const mutantHelper = `export function assertF42DeletionE2EAfterAllWiring(src: string): void {
  expect(src).toMatch(VACUOUS_AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
}`
    expect(mutantHelper).toContain("AFTER_ALL_DELETE_FIRMS_UIDS_GUARD")
    expect(mutantHelper).not.toMatch(/\bAFTER_ALL_DELETE_FIRMS_UIDS_GUARD\b/)
    expect(mutantHelper).toMatch(/\bVACUOUS_AFTER_ALL_DELETE_FIRMS_UIDS_GUARD\b/)
  })

  it("FA-F42-R1-015-001-001: Mmove (cleanup only in it.skip) fails the afterAll hook guard", () => {
    const mmoveSrc = `
import { afterAll, it } from "vitest"
import { deleteFirmScopedData } from "./firmCleanup"
const firms: string[] = []
const uids: string[] = []
afterAll(async () => {}, 120_000)
it.skip("moved cleanup", () => { deleteFirmScopedData(firms, uids) })
`
    expect(deleteFirmScopedDataInAfterAllAsyncHook(mmoveSrc)).toBe(false)
    expect(mmoveSrc).not.toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
  })

  it("FA-F42-R1-015-001-001: MmoveT (empty afterAll; cleanup in it.skip with 120_000 timeout) fails the guard", () => {
    const mmoveTSrc = `
import { afterAll, it } from "vitest"
import { deleteFirmScopedData } from "./firmCleanup"
const firms: string[] = []
const uids: string[] = []
afterAll(async () => {}, 120_000)
it.skip("moved cleanup", async () => { await deleteFirmScopedData(firms, uids) }, 120_000)
`
    expect(deleteFirmScopedDataInAfterAllAsyncHook(mmoveTSrc)).toBe(false)
    expect(mmoveTSrc).not.toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
  })

  it("FA-F42-R1-015-001-001-001-001: MmoveNoTO (empty afterAll without timeout; cleanup in it.skip) fails the guard", () => {
    const mmoveNoTOSrc = `
import { afterAll, it } from "vitest"
import { deleteFirmScopedData } from "./firmCleanup"
const firms: string[] = []
const uids: string[] = []
afterAll(async () => {})
it.skip("moved cleanup", async () => { await deleteFirmScopedData(firms, uids) }, 120_000)
`
    expect(deleteFirmScopedDataInAfterAllAsyncHook(mmoveNoTOSrc)).toBe(false)
  })

  it("FA-F42-R1-015-001-001-001-001: MmoveOtherTO (empty afterAll with 60_000; cleanup in it.skip with 120_000) fails the guard", () => {
    const mmoveOtherTOSrc = `
import { afterAll, it } from "vitest"
import { deleteFirmScopedData } from "./firmCleanup"
const firms: string[] = []
const uids: string[] = []
afterAll(async () => {}, 60_000)
it.skip("moved cleanup", async () => { await deleteFirmScopedData(firms, uids) }, 120_000)
`
    expect(deleteFirmScopedDataInAfterAllAsyncHook(mmoveOtherTOSrc)).toBe(false)
    expect(mmoveOtherTOSrc).not.toMatch(AFTER_ALL_DELETE_FIRMS_UIDS_GUARD)
  })

  it("FA-F42-R1-015-001-001-001-001-001: MdescribeSkip (cleanup only in afterAll under describe.skip) fails the AST guard", () => {
    const mdescribeSkipSrc = `
import { afterAll, describe } from "vitest"
import { deleteFirmScopedData } from "./firmCleanup"
const firms: string[] = []
const uids: string[] = []
describe.skip("skipped suite", () => {
  afterAll(async () => { await deleteFirmScopedData(firms, uids) }, 120_000)
})
`
    expect(deleteFirmScopedDataInAfterAllAsyncHook(mdescribeSkipSrc)).toBe(false)
  })

  it("AFTER_ALL_ASYNC_HOOK_CLOSE matches any numeric afterAll timeout suffix (not only 120_000)", () => {
    expect("}, 120_000)").toMatch(AFTER_ALL_ASYNC_HOOK_CLOSE)
    expect("}, 60_000)").toMatch(AFTER_ALL_ASYNC_HOOK_CLOSE)
  })
})
