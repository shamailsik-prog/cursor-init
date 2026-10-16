import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Timestamp } from "firebase-admin/firestore"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { adminDb } from "../src/admin"
import { ROUTES, createRouter, type Route } from "../src/http/router"
import { platformConfigRef } from "../src/p1/config"
import * as d1ClientNumbering from "../src/d1/client/numberingOp"
import * as d1ClientOps from "../src/d1/client/ops"
import * as d1ConflictOps from "../src/d1/conflict/ops"
import * as d1EntityOps from "../src/d1/entity/ops"
import * as d1EntityUnmerge from "../src/d1/entity/unmerge"
import * as d1MatterOps from "../src/d1/matter/ops"
import * as d4DoctypeOps from "../src/d4/doctypeOps"
import * as d4Drafts from "../src/d4/drafts"
import * as d4GateOps from "../src/d4/gateOps"
import * as p1Ops from "../src/p1/ops"
import * as p2Ops from "../src/p2/ops"
import * as p5Gates from "../src/p5/gates"
import * as p5Identity from "../src/p5/identity"
import * as p5Mfa from "../src/p5/mfa"
import { EMULATORS, mintIdToken, mintMfaIdToken, mockRes, uniq } from "./emu"

/**
 * Re-audit LOW-3 (audit F09): the effect fence rests on a convention. Every `once` POST route must stage its allow row
 * with `CallAudit.stage` inside the transaction that commits its effect, never with the non-transactional
 * `audit.allow()`, because that staging is what creates the operation's effect marker. Two guards hold it:
 *
 * - static, over EVERY `once` route in ROUTES: the operation's source (and any helper in the same file it hands
 *   `audit` to) stages an allow row inside a transaction and never calls `audit.allow()`;
 * - runtime, through the real router on the emulators, for the `once` routes whose happy path needs only light
 *   fixtures: a 2xx leaves an `idempotency_effects` marker for the request's key (RUNTIME_COVERED below).
 */

const SRC = path.resolve(__dirname, "../src")

/** Every module that exports a route operation, by source file. */
const MODULES: Array<[string, Record<string, unknown>]> = [
  ["d1/client/numberingOp.ts", d1ClientNumbering],
  ["d1/client/ops.ts", d1ClientOps],
  ["d1/conflict/ops.ts", d1ConflictOps],
  ["d1/entity/ops.ts", d1EntityOps],
  ["d1/entity/unmerge.ts", d1EntityUnmerge],
  ["d1/matter/ops.ts", d1MatterOps],
  ["d4/doctypeOps.ts", d4DoctypeOps],
  ["d4/drafts.ts", d4Drafts],
  ["d4/gateOps.ts", d4GateOps],
  ["p1/ops.ts", p1Ops],
  ["p2/ops.ts", p2Ops],
  ["p5/gates.ts", p5Gates],
  ["p5/identity.ts", p5Identity],
  ["p5/mfa.ts", p5Mfa],
]

const routeName = (r: Route) => r.path.split("/").pop()!
const ONCE_ROUTES = ROUTES.filter((r) => r.method !== "GET" && (r.idempotency ?? "once") === "once")

/** The `once` routes the runtime guard drives through their happy path; every other `once` route is guarded statically only. */
const RUNTIME_COVERED = [
  "enforceMfaForRole",
  "approveMfaDisable",
  "generateRecoveryCodes",
  "syncMfaStatus",
  "setFirmNumbering",
  "registerClient",
  "runConflictCheck",
  "openMatter",
  "advanceStage",
  "closeMatter",
  "confirmMerge",
  "disputeLink",
  "rejectLink",
  "setBudgetAlerts",
  "setAiKillSwitch",
  "setPlatformAiKillSwitch",
  "createDraft",
  "saveDraftVersion",
  "restoreDraftVersion",
  "gateDraft",
] as const

// ---------------------------------------------------------------------------
// The static guard
// ---------------------------------------------------------------------------

/** Index just past the string, template literal or comment that starts at `i`, or `i` when none starts there. */
function skipLiteral(src: string, i: number): number {
  const c = src[i]
  if (c === "/" && src[i + 1] === "/") {
    const nl = src.indexOf("\n", i)
    return nl < 0 ? src.length : nl
  }
  if (c === "/" && src[i + 1] === "*") return src.indexOf("*/", i + 2) + 2
  if (c === '"' || c === "'" || c === "`") {
    let j = i + 1
    for (; j < src.length && src[j] !== c; j++) if (src[j] === "\\") j++
    return j + 1
  }
  return i
}

/** The text of the balanced block that opens at `open` (`{` or `(`), strings, template literals and comments skipped. */
export function blockAt(src: string, open: number): string {
  const [l, r] = src[open] === "(" ? ["(", ")"] : ["{", "}"]
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const next = skipLiteral(src, i)
    if (next !== i) {
      i = next - 1
      continue
    }
    if (src[i] === l) depth++
    if (src[i] === r && --depth === 0) return src.slice(open, i + 1)
  }
  throw new Error("unbalanced block")
}

/** The body of the function `name` declared at the top level of `src` (`function` or `async function`), or null. */
function declaration(src: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\n)(?:export )?(?:async )?function ${name}\\b`).exec(src)
  if (!m) return null
  const params = src.indexOf("(", m.index)
  let i = params + blockAt(src, params).length
  // Past a return type such as `: Promise<{ a: string }>`: the body is the first `{` outside angle brackets.
  for (let angle = 0; i < src.length; i++) {
    if (src[i] === "=" && src[i + 1] === ">") {
      i++
      continue
    }
    if (src[i] === "<") angle++
    if (src[i] === ">") angle--
    if (src[i] === "{" && angle === 0) return blockAt(src, i)
  }
  return null
}

/** The functions `text` calls with `audit` itself as an argument (not a member such as `audit.target`), by name. */
function callsWithAudit(text: string): string[] {
  const names: string[] = []
  const re = /\b([A-Za-z_]\w*)\s*\(/g
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const args = blockAt(text, m.index + m[0].length - 1)
    if (/(?:^|[^.\w])audit\b(?!\s*[.?])/.test(args.slice(1, -1))) names.push(m[1]!)
  }
  return names
}

export type GuardVerdict = { stagesAllowInTransaction: boolean; callsAuditAllow: boolean; via: string[] }

/**
 * The static check of one operation: `opText` is the operation's object literal; `src` its file. Follows each function
 * declared in the same file that the operation hands `audit` to (and those it hands it on to), and reports whether an
 * allow row is staged with `.stage(tx, "allow"` in a function body that also runs a transaction, and whether
 * `audit.allow()` is called anywhere on that path.
 */
export function checkOperation(src: string, opText: string): GuardVerdict {
  const texts: Array<[string, string]> = [["run", opText]]
  const seen = new Set<string>(["runAudited"])
  for (let k = 0; k < texts.length; k++) {
    for (const name of callsWithAudit(texts[k]![1])) {
      if (seen.has(name)) continue
      seen.add(name)
      const body = declaration(src, name)
      if (body !== null) texts.push([name, body])
    }
  }
  const staging = texts.filter(([, t]) => /\.stage\(\s*tx\s*,\s*"allow"/.test(t) && /\b(runTransaction|inTransaction)\(/.test(t))
  return {
    stagesAllowInTransaction: staging.length > 0,
    callsAuditAllow: texts.some(([, t]) => /\baudit\.allow\(\s*\)/.test(t)),
    via: staging.map(([n]) => n),
  }
}

function operationSource(handler: unknown): { file: string; name: string; src: string; opText: string } {
  const found = MODULES.flatMap(([file, mod]) => Object.entries(mod).filter(([, v]) => v === handler).map(([name]) => ({ file, name })))
  if (found.length !== 1) throw new Error(`operation found ${found.length} times in MODULES`)
  const { file, name } = found[0]!
  const src = readFileSync(path.join(SRC, file), "utf8")
  const at = src.indexOf(`export const ${name}`)
  const eq = src.indexOf("= {", at)
  return { file, name, src, opText: blockAt(src, eq + 2) }
}

describe("re-audit LOW-3: every `once` POST route stages its allow row in its effect transaction (static guard)", () => {
  it("the checker has teeth: it refuses an operation that calls audit.allow(), or that stages no allow row in a transaction", () => {
    const good = `export const okOp = {\n  run: async (s, data, audit) => {\n    await adminDb().runTransaction(async (tx) => {\n      await audit.stage(tx, "allow", "ok")\n      tx.set(ref, {})\n    })\n  },\n}\n`
    const viaHelper = `async function store(ref: X, input: { a: string }, audit: CallAudit): Promise<{ b: number }> {\n  await adminDb().runTransaction(async (tx) => {\n    await audit.stage(tx, "allow", "ok")\n  })\n  return { b: 1 }\n}\nexport const helperOp = {\n  run: async (s, data, audit) => store(ref, { a: "x" }, audit),\n}\n`
    const allowOnly = `export const badOp = {\n  run: async (s, data, audit) => {\n    await audit.allow()\n    await ref.set({})\n  },\n}\n`
    const outsideTx = `export const badOp2 = {\n  run: async (s, data, audit) => {\n    await audit.stage(tx, "allow", "ok")\n  },\n}\n`
    const verdict = (src: string, name: string) => checkOperation(src, blockAt(src, src.indexOf("= {", src.indexOf(`export const ${name}`)) + 2))
    expect(verdict(good, "okOp")).toMatchObject({ stagesAllowInTransaction: true, callsAuditAllow: false })
    expect(verdict(viaHelper, "helperOp")).toMatchObject({ stagesAllowInTransaction: true, callsAuditAllow: false, via: ["store"] })
    expect(verdict(allowOnly, "badOp")).toMatchObject({ stagesAllowInTransaction: false, callsAuditAllow: true })
    expect(verdict(outsideTx, "badOp2")).toMatchObject({ stagesAllowInTransaction: false })
  })

  it("covers every `once` POST route, and each stages its allow row in a transaction and never calls audit.allow()", () => {
    expect(ONCE_ROUTES.length).toBeGreaterThanOrEqual(25)
    const failures: string[] = []
    for (const route of ONCE_ROUTES) {
      const { file, name, src, opText } = operationSource(route.handler)
      const v = checkOperation(src, opText)
      if (!v.stagesAllowInTransaction || v.callsAuditAllow) failures.push(`${routeName(route)} (${file} ${name}): ${JSON.stringify(v)}`)
    }
    expect(failures).toEqual([])
  })

  it("the runtime guard's list names only `once` routes, and every `once` route is guarded statically or at runtime", () => {
    const once = new Set(ONCE_ROUTES.map(routeName))
    for (const name of RUNTIME_COVERED) expect(once.has(name), name).toBe(true)
    expect([...once].sort()).toEqual(ONCE_ROUTES.map(routeName).sort())
  })
})

// ---------------------------------------------------------------------------
// The runtime guard
// ---------------------------------------------------------------------------

const db = () => adminDb()
const markerOf = (firmId: string, key: string) => db().collection("idempotency_effects").doc(`${firmId || "_nofirm"}_${key.toLowerCase()}`).get()

describe.skipIf(!EMULATORS)("re-audit LOW-3: a 2xx from a `once` POST route leaves the operation's effect marker (runtime guard)", () => {
  const createdFirms: string[] = []
  const T = Date.parse("2026-10-11T10:00:00.000Z")
  const router = createRouter(ROUTES, { now: () => T })
  const covered: string[] = []

  afterEach(async () => {
    await platformConfigRef().delete()
  })

  afterAll(async () => {
    await Promise.all(createdFirms.map((id) => db().collection("firms").doc(id).delete()))
  })

  /** POSTs `name` with a fresh key; asserts a 2xx and the marker for that key; returns the body. */
  async function post(name: (typeof RUNTIME_COVERED)[number], token: string, firmId: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const route = ROUTES.find((r) => r.method === "POST" && routeName(r) === name)!
    const key = randomUUID()
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${token}`, "idempotency-key": key }
    if (firmId !== "") headers["x-firm-id"] = firmId
    const { res, out } = mockRes()
    await router({ method: "POST", path: route.path, headers, body: data, rawBody: Buffer.from(JSON.stringify(data)), ip: "127.0.0.1" } as never, res as never)
    expect([name, out.status]).toEqual([name, 200])
    expect([name, (await markerOf(firmId, key)).exists]).toEqual([name, true])
    covered.push(name)
    return out.body as Record<string, unknown>
  }

  it("drives each RUNTIME_COVERED route through its happy path; every 2xx leaves its marker", { timeout: 120_000 }, async () => {
    const firmId = uniq("firm")
    createdFirms.push(firmId)
    await db().collection("firms").doc(firmId).set({ name: "F", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS", rateLimits: { general: 1000, p1: 1000 } })
    const claims = (role: string) => ({ firmId, role, clearanceLevel: "privileged-restricted" })
    const P = await mintIdToken(claims("partner"))
    const A = await mintIdToken(claims("associate"))
    const C = await mintIdToken(claims("clerk"))

    // P5 identity and MFA.
    await post("enforceMfaForRole", P.token, firmId, { role: "intern", enforced: false })
    await post("syncMfaStatus", P.token, firmId, {})
    await post("approveMfaDisable", P.token, firmId, { uid: C.uid })
    const mfa = await mintMfaIdToken(claims("partner"))
    await post("generateRecoveryCodes", mfa.token, firmId, {})

    // D1: numbering, clients, a conflict check, a matter through its life.
    await post("setFirmNumbering", P.token, firmId, { clientPrefix: "SKD", matterPrefix: "NHS" })
    const client = await post("registerClient", P.token, firmId, { name: "Tariq Zarvani", type: "individual", primaryMobile: "03011234500", classification: "internal" })
    const check = await post("runConflictCheck", P.token, firmId, { client: { clientId: client.clientId }, opposingParties: [{ name: "Haris Qalbani" }] })
    const matter = await post("openMatter", P.token, firmId, { conflictCheckId: check.checkId, title: "Recovery suit", classification: "confidential" })
    await post("advanceStage", P.token, firmId, { matterId: matter.matterId, to: "filed" })
    await post("closeMatter", P.token, firmId, { matterId: matter.matterId, reason: "Client withdrew inst." })

    // D1 entity decisions: three pairs, each two clients sharing a CNIC and a mobile.
    const pairRow = async (n: number) => {
      const extra = { type: "individual", primaryMobile: `0302123450${n}`, cnic: `421011234567${n}`, classification: "internal" }
      const a = await post("registerClient", P.token, firmId, { name: "Muhammad Ali", ...extra })
      const b = await post("registerClient", P.token, firmId, { name: "Mohammad Ali", ...extra })
      const [left, right] = [a.entityId as string, b.entityId as string].sort()
      return `${firmId}_${left}_${right}_cnic`
    }
    const NOTE = "Same CNIC and mobile on both intake forms, checked."
    await post("confirmMerge", A.token, firmId, { linkId: await pairRow(1), note: NOTE })
    await post("disputeLink", A.token, firmId, { linkId: await pairRow(2), note: "These look like two different people, check." })
    await post("rejectLink", P.token, firmId, { linkId: await pairRow(3), note: NOTE })

    // P1 settings (the platform switch is firmless).
    await post("setBudgetAlerts", P.token, firmId, { monthlyBudgetUsd: 100 })
    await post("setAiKillSwitch", P.token, firmId, { disableAll: false, disabledModels: [], reason: "Runtime guard" })
    const admin = await mintIdToken({ platformAdmin: true })
    await post("setPlatformAiKillSwitch", admin.token, "", { disableAll: false, disabledModels: [], reason: "Runtime guard" })

    // D4 drafting on a seeded matter the partner is a member of.
    const draftMatter = uniq("matter")
    await db().collection("matters").doc(draftMatter).set({ firmId, classification: "internal", title: "Recovery suit", stage: "pre_filing", status: "open", createdAt: Timestamp.now() })
    await db().collection("matter_members").doc(`${draftMatter}_${P.uid}`).set({ firmId, matterId: draftMatter, userId: P.uid, classification: "internal" })
    const BODY = "IN THE HIGH COURT. The petitioner submits as follows.\nThe respondents have failed to act."
    const draft = await post("createDraft", P.token, firmId, { matterId: draftMatter, documentTypeId: "constitutional_petition_199", title: "Petition against the impugned order", body: BODY })
    const draftId = (draft.draftId ?? (draft.draft as Record<string, unknown> | undefined)?.draftId) as string
    await post("saveDraftVersion", P.token, firmId, { draftId, baseVersion: 1, title: "Revised petition", body: `${BODY}\nA new paragraph.` })
    await post("restoreDraftVersion", P.token, firmId, { draftId, baseVersion: 2, fromVersion: 1 })
    await post("gateDraft", P.token, firmId, { draftId, version: 3 })

    expect([...new Set(covered)].sort()).toEqual([...RUNTIME_COVERED].sort())
  })
})
