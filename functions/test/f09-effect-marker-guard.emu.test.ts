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
 *   `audit` to) stages an allow row inside a transaction and never calls `audit.allow()`; and (re-audit LOW-A) nothing on
 *   the operation's path (it and every function it calls in its file or in a relative import under src) writes to
 *   Firestore, or dispatches a task, outside a transaction, except the writes in NON_TRANSACTIONAL_ALLOWLIST;
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

/**
 * The body of the function `name` declared at the top level of `src`, or null: a `function` / `async function`
 * declaration, or a `const name = (...) =>` arrow (its block, or its expression up to the end of the line).
 */
function declaration(src: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\n)(?:export )?(?:async )?function ${name}\\b`).exec(src)
  if (!m) {
    const arrow = new RegExp(`(?:^|\\n)(?:export )?const ${name}\\b[^\\n]*?=>\\s*`).exec(src)
    if (!arrow) return null
    const at = arrow.index + arrow[0].length
    if (src[at] === "{") return blockAt(src, at)
    // An expression body: up to the first line end or `;` outside brackets, strings and comments.
    let depth = 0
    let i = at
    for (; i < src.length; i++) {
      const next = skipLiteral(src, i)
      if (next !== i) {
        i = next - 1
        continue
      }
      if ("([{".includes(src[i]!)) depth++
      if (")]}".includes(src[i]!)) depth--
      if (depth <= 0 && (src[i] === "\n" || src[i] === ";")) break
    }
    return src.slice(at, i)
  }
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
    let args: string
    try {
      args = blockAt(text, m.index + m[0].length - 1)
    } catch {
      args = `${text.slice(m.index + m[0].length - 1)})` // an unbalanced tail (a regex literal holding a bracket): scan the rest
    }
    if (/(?:^|[^.\w])audit\b(?!\s*[.?])/.test(args.slice(1, -1))) names.push(m[1]!)
  }
  return names
}

/** The same-file functions `text` calls directly (`name(`, not a member call `x.name(`), by name. */
function directCalls(text: string): string[] {
  return [...text.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]!)
}

/** The receiver expression of the member call whose `.` is at `dot`: identifiers, dots and balanced `( )` to its left. */
function receiverAt(text: string, dot: number): string {
  let i = dot - 1
  while (i >= 0) {
    const c = text[i]!
    if (c === ")") {
      for (let depth = 0; i >= 0; i--) {
        if (text[i] === ")") depth++
        if (text[i] === "(" && --depth === 0) break
      }
      i--
      continue
    }
    if (/[\w$.!]/.test(c)) {
      i--
      continue
    }
    break
  }
  return text.slice(i + 1, dot)
}

/**
 * Re-audit LOW-A: the writes in `text` that are not part of a transaction. A Firestore write (`set`, `update`, `create`,
 * `add`, `delete`) on a receiver that is a db, a collection, a doc or a ref (anything but the transaction `tx`), and any
 * `.dispatch(` (a task handed to the job dispatcher). Maps, Sets and hashes (`names.add`, `matched.set`, `hash.update`)
 * are not Firestore receivers and are not flagged. Returned as `receiver.method`, whitespace removed.
 */
function nonTransactionalWrites(text: string): string[] {
  const flat = text.replace(/\s+\./g, ".")
  const out: string[] = []
  for (const m of flat.matchAll(/\.(set|update|create|add|delete|dispatch)\s*\(/g)) {
    const receiver = receiverAt(flat, m.index!).replace(/\s+/g, "")
    const method = m[1]!
    if (receiver === "tx" || receiver.startsWith("tx.")) continue
    const firestore =
      /(^|[^\w$])(adminDb\(\)|db)(\.|$)/.test(receiver) || /\.(doc|collection)\([^()]*\)$/.test(receiver) || /[Rr]ef(\([^()]*\))?!?$/.test(receiver)
    if (method === "dispatch" || firestore) out.push(`${receiver}.${method}`)
  }
  return out
}

export type GuardVerdict = { stagesAllowInTransaction: boolean; callsAuditAllow: boolean; via: string[]; nonTransactionalWrites: string[] }

const sourceCache = new Map<string, string | null>()
/** The text of `file` (relative to src), or null when there is no such file; cached. */
function sourceOf(file: string): string | null {
  if (!sourceCache.has(file)) {
    let text: string | null = null
    try {
      text = readFileSync(path.join(SRC, file), "utf8")
    } catch {
      text = null
    }
    sourceCache.set(file, text)
  }
  return sourceCache.get(file)!
}

/** The value imports of `src` (in `file`) from relative modules under src: local name to [module file, exported name]. */
function relativeImports(src: string, file: string): Map<string, [string, string]> {
  const out = new Map<string, [string, string]>()
  for (const m of src.matchAll(/(?:^|\n)import\s+\{([^}]*)\}\s+from\s+"(\.{1,2}\/[^"]+)"/g)) {
    const base = path.posix.join(path.posix.dirname(file), m[2]!)
    const target = [`${base}.ts`, `${base}/index.ts`].find((f) => sourceOf(f) !== null)
    if (target === undefined) continue
    for (const spec of m[1]!.split(",")) {
      const s = spec.trim()
      if (s === "" || s.startsWith("type ")) continue
      const [exported, local] = s.split(/\s+as\s+/)
      out.set((local ?? exported)!.trim(), [target, exported!.trim()])
    }
  }
  return out
}

/**
 * The static check of one operation: `opText` is the operation's object literal; `src` its file, at `file` (relative to
 * src; omitted for a synthetic sample, whose path then stays in `src`). Its path is the operation and every function it
 * calls that is declared in its file or imported from a relative module under src, transitively (`audit` handed on or
 * not). Reports whether an allow row is staged with `.stage(tx, "allow"` in a function body that also runs a transaction
 * (`via`: the function that hands `audit` on and stages it), whether `audit.allow()` is called anywhere on the path, and
 * every write on the path that is outside a transaction (re-audit LOW-A), as `function: receiver.method` (a function in
 * another file is named `file#function`).
 */
export function checkOperation(src: string, opText: string, file?: string): GuardVerdict {
  type Fn = { label: string; text: string; file: string | undefined; src: string }
  const path_: Fn[] = [{ label: "run", text: opText, file, src }]
  const seen = new Set<string>([`${file}#runAudited`, "p5/common.ts#runAudited"])
  for (let k = 0; k < path_.length; k++) {
    const at = path_[k]!
    const imports = at.file === undefined ? new Map<string, [string, string]>() : relativeImports(at.src, at.file)
    for (const name of [...callsWithAudit(at.text), ...directCalls(at.text)]) {
      const [toFile, toName] = declaration(at.src, name) !== null ? [at.file, name] : (imports.get(name) ?? [undefined, undefined])
      if (toName === undefined) continue
      if (seen.has(`${toFile}#${toName}`)) continue
      seen.add(`${toFile}#${toName}`)
      const toSrc = toFile === at.file ? at.src : sourceOf(toFile!)
      const body = toSrc === null ? null : declaration(toSrc, toName)
      if (body !== null) path_.push({ label: toFile === file ? toName : `${toFile}#${toName}`, text: body, file: toFile, src: toSrc! })
    }
  }
  const staging = path_.filter((f) => /\.stage\(\s*tx\s*,\s*"allow"/.test(f.text) && /\b(runTransaction|inTransaction)\(/.test(f.text))
  return {
    stagesAllowInTransaction: staging.length > 0,
    callsAuditAllow: path_.some((f) => /\baudit\.allow\(\s*\)/.test(f.text)),
    via: staging.map((f) => f.label),
    nonTransactionalWrites: path_.flatMap((f) => nonTransactionalWrites(f.text).map((w) => `${f.label}: ${w}`)),
  }
}

/**
 * Writes a `once` operation makes outside its effect transaction on purpose (re-audit LOW-A), each with the reason it is
 * not an effect the fence must cover. Keyed by route, or `*` for a write reached from any route's path; each entry is
 * `function: receiver.method` exactly as the checker reports it. An entry no route reaches fails the test, so the list
 * cannot go stale; any other write outside a transaction on a `once` path fails it too.
 */
const NON_TRANSACTIONAL_ALLOWLIST: Record<string, Array<{ write: string; reason: string }>> = {
  "*": [
    {
      write: "p5/audit.ts#appendAudit: ref.create",
      reason:
        "checkPermission (through requirePermission) appends the P5 permission-decision row, allow or deny, before the effect " +
        "transaction opens. It records that an authorisation check ran, which every attempt genuinely does, so a retry that " +
        "adds a second decision row is a true record, not a replayed effect. Given a `tx`, appendAudit stages in it instead.",
    },
  ],
  retryFailedJob: [
    {
      write: "run: runtimeDeps().dispatcher.dispatch",
      reason:
        "The Cloud Tasks hand-off after the requeue commits (audit.committed()); a task queue cannot join a Firestore " +
        "transaction. The effect is the requeued job row (dispatchSeq + 1, sweepAt), committed with the allow row and the " +
        "marker. The dispatch is best effort (a failure is logged): the worker claims only seq <= dispatchSeq under a lease, " +
        "and the sweeper re-dispatches a queued row once DISPATCH_GRACE_MS passes, so a lost or repeated dispatch is harmless.",
    },
  ],
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
    expect(verdict(good, "okOp").nonTransactionalWrites).toEqual([])
  })

  it("re-audit LOW-A (G3): the checker flags an effect written outside the transaction, in the operation or in a helper it calls", () => {
    const verdict = (src: string, name: string) => checkOperation(src, blockAt(src, src.indexOf("= {", src.indexOf(`export const ${name}`)) + 2))
    // The allow row (and so the marker) commits in the transaction; the effect lands after it, unfenced.
    const inline = `export const g3Op = {\n  run: async (s, data, audit) => {\n    await adminDb().runTransaction(async (tx) => {\n      await audit.stage(tx, "allow", "ok")\n    })\n    await adminDb().collection("things").doc(data.id).set({ done: true })\n  },\n}\n`
    const viaHelper = `async function persist(id: string): Promise<void> {\n  await thingRef(id).update({ done: true })\n}\nexport const g3HelperOp = {\n  run: async (s, data, audit) => {\n    await adminDb().runTransaction(async (tx) => {\n      await audit.stage(tx, "allow", "ok")\n      tx.set(thingRef(data.id), {})\n    })\n    await persist(data.id)\n  },\n}\n`
    const addAndDelete = `export const g3AddOp = {\n  run: async (s, data, audit) => {\n    await adminDb().runTransaction(async (tx) => {\n      await audit.stage(tx, "allow", "ok")\n    })\n    await db\n      .collection("events").add({ at: 1 })\n    await someRef.delete()\n    names.add("not firestore")\n  },\n}\n`
    expect(verdict(inline, "g3Op")).toMatchObject({ stagesAllowInTransaction: true, nonTransactionalWrites: [`run: adminDb().collection("things").doc(data.id).set`] })
    expect(verdict(viaHelper, "g3HelperOp")).toMatchObject({ stagesAllowInTransaction: true, nonTransactionalWrites: ["persist: thingRef(id).update"] })
    expect(verdict(addAndDelete, "g3AddOp").nonTransactionalWrites).toEqual([`run: db.collection("events").add`, "run: someRef.delete"])
    // Across files: the operation imports the helper that writes outside the transaction.
    sourceCache.set("g3/store.ts", `export const markDone = async (id: string) => {\n  await adminDb().collection("things").doc(id).update({ done: true })\n}\n`)
    const crossFile = `import { markDone } from "./store"\nexport const g3CrossOp = {\n  run: async (s, data, audit) => {\n    await adminDb().runTransaction(async (tx) => {\n      await audit.stage(tx, "allow", "ok")\n    })\n    await markDone(data.id)\n  },\n}\n`
    const at = crossFile.indexOf("= {", crossFile.indexOf("export const g3CrossOp")) + 2
    expect(checkOperation(crossFile, blockAt(crossFile, at), "g3/op.ts")).toMatchObject({
      stagesAllowInTransaction: true,
      nonTransactionalWrites: [`g3/store.ts#markDone: adminDb().collection("things").doc(id).update`],
    })
    // A real operation, mutated to write its effect after the transaction commits.
    const real = operationSource(p1Ops.setBudgetAlertsOp)
    const anchor = "    audit.committed()\n    return { monthlyBudgetMicroUsd"
    expect(real.opText).toContain(anchor)
    const mutant = real.opText.replace(anchor, "    audit.committed()\n    await ref.set({ monthlyBudgetMicroUsd }, { merge: true })\n    return { monthlyBudgetMicroUsd")
    expect(checkOperation(real.src, real.opText, real.file).nonTransactionalWrites).not.toContain("run: ref.set")
    expect(checkOperation(real.src, mutant, real.file).nonTransactionalWrites).toContain("run: ref.set")
  })

  it("the only rerun POSTs are the identity heal routes and the nine F02 Next-authority routes", () => {
    const rerun = ROUTES.filter((r) => r.method !== "GET" && r.idempotency === "rerun").map((r) => `${r.method} ${r.path}`)
    expect(rerun.sort()).toEqual(
      [
        "POST /api/platform/identity/onboardFirm",
        "POST /api/platform/identity/createFirmUser",
        "POST /api/platform/identity/setUserClaims",
        "POST /api/platform/identity/deactivateUser",
        "POST /api/platform/identity/disableMfa",
        "POST /api/d1/matters",
        "POST /api/d1/documents",
        "POST /api/d1/document-workflow",
        "POST /api/d1/reporting",
        "POST /api/d2/court-ops",
        "POST /api/d2/ops-reporting",
        "POST /api/d4/drafts",
        "POST /api/d4/filings",
        "POST /api/p5/tenancy",
      ].sort(),
    )
  })

  it("covers every `once` POST route: each stages its allow row in a transaction, never calls audit.allow(), and writes nothing outside it unless allowlisted", () => {
    expect(ONCE_ROUTES.length).toBeGreaterThanOrEqual(25)
    const failures: string[] = []
    const used = new Set<string>()
    for (const route of ONCE_ROUTES) {
      const { file, name, src, opText } = operationSource(route.handler)
      const v = checkOperation(src, opText, file)
      if (!v.stagesAllowInTransaction || v.callsAuditAllow) failures.push(`${routeName(route)} (${file} ${name}): ${JSON.stringify(v)}`)
      for (const write of v.nonTransactionalWrites) {
        const scope = [routeName(route), "*"].find((k) => (NON_TRANSACTIONAL_ALLOWLIST[k] ?? []).some((a) => a.write === write))
        if (scope !== undefined) used.add(`${scope} ${write}`)
        else failures.push(`${routeName(route)} (${file} ${name}) writes outside its transaction: ${write}`)
      }
    }
    expect(failures).toEqual([])
    const stale = Object.entries(NON_TRANSACTIONAL_ALLOWLIST).flatMap(([r, entries]) => entries.filter((e) => !used.has(`${r} ${e.write}`)).map((e) => `${r} ${e.write}`))
    expect(stale).toEqual([])
    for (const entries of Object.values(NON_TRANSACTIONAL_ALLOWLIST)) for (const e of entries) expect(e.reason.length, e.write).toBeGreaterThan(40)
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
