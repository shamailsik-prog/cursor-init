// Audit F11 on the Firestore emulator, below the route level:
// - staging: every effect write a request makes through the four firestoreDbModular helpers commits its audit-outbox
//   entry in the same transaction or batch (fenced or not, a repository transaction, a provider dispatch), and a write
//   that fails commits neither; the audit log, the outbox and F10's records are not effects;
// - the reconciler (functions/src/p5/auditOutbox.ts): exactly-once publication, the grace, insert-only, poison to the
//   dead letter, counted and uncounted failures, the backlog alert, firm isolation;
// - the dead letter's firm-scoped listing on Firestore (F12 re-audit LOW-2).
// The F11 modules are loaded loosely so that each test fails on its own assertion against main.
// Spec: docs/superpowers/specs/2026-10-18-f11-atomic-request-audit-design.md.
import { randomUUID } from "node:crypto"
import { FieldValue, type DocumentReference, type Firestore, type Transaction } from "firebase-admin/firestore"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { beginIdempotentRequest, recordExternalEffect, resetIdempotencyForTests } from "@/platform/http/idempotency"
import { checkPermission } from "@/platform/p5/checkPermission"
import { withSession } from "@/platform/http/withSession"
import { deleteDoc, doc, runTransaction, setDoc, updateDoc } from "@/platform/persistence/firestoreDbModular"
import { createFirestoreRepositories } from "@/platform/persistence/firestoreSpineRepositories"
import { setRequestAuditSinkForTests } from "@/platform/persistence/requestAuditFlush"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import type { AuditEntry } from "@/platform/spine/store"
import { adminDb } from "@/tests/helpers/emulator-auth"

const HAS_FIRESTORE = Boolean(process.env.FIRESTORE_EMULATOR_HOST?.trim())
const GRACE_MS = 10 * 60_000
const ALERT_AGE_MS = 20 * 60_000
const PAST_GRACE = () => Date.now() + GRACE_MS + 60_000

type Row = Record<string, unknown> & { id: string }
type Log = { info(message: string, data?: unknown): void; warn(message: string, data?: unknown): void; error(message: string, data?: unknown): void }
type Backlog = { firing: boolean; transition: "fired" | "cleared" | null; oldestAgeMs: number | null; stale: number; unreadable?: number }
type ReconcileResult = { published: string[]; deadLettered: string[]; deferred: string[]; counted: string[]; backlog: Backlog }
type Reconcile = (deps: {
  db: unknown
  now?: () => number
  clock?: () => number
  log?: Log
  sweepPageSize?: number
  sweepPendingMax?: number
}) => Promise<ReconcileResult>

async function reconciler(): Promise<Reconcile> {
  const mod = (await import("@/functions/src/p5/auditOutbox").catch(() => ({}))) as { reconcileAuditOutbox?: Reconcile }
  expect(mod.reconcileAuditOutbox, "functions/src/p5/auditOutbox.ts reconcileAuditOutbox").toBeTypeOf("function")
  return mod.reconcileAuditOutbox!
}

/** A logger that keeps what it was told. */
function recordingLog(): Log & { lines: Array<{ level: string; message: string; data?: unknown }> } {
  const lines: Array<{ level: string; message: string; data?: unknown }> = []
  return {
    lines,
    info: (message, data) => void lines.push({ level: "info", message, data }),
    warn: (message, data) => void lines.push({ level: "warn", message, data }),
    error: (message, data) => void lines.push({ level: "error", message, data }),
  }
}

const db = (): Firestore => adminDb()
const created: Array<{ collection: string; id: string }> = []
const firms: string[] = []
const routes: string[] = []

async function docsWhere(collection: string, field: string, value: unknown): Promise<Row[]> {
  const snap = await db().collection(collection).where(field, "==", value).get()
  return snap.docs.map((d) => ({ ...(d.data() as Record<string, unknown>), id: d.id }))
}
const entriesOf = (route: string) => docsWhere("audit_outbox", "route", route)

async function cleanUp(): Promise<void> {
  const deletions: Array<Promise<unknown>> = []
  for (const { collection, id } of created.splice(0)) deletions.push(db().collection(collection).doc(id).delete())
  for (const route of routes.splice(0)) {
    for (const collection of ["audit_outbox", "idempotency_keys", "idempotency_effects"]) {
      for (const row of await docsWhere(collection, "route", route)) deletions.push(db().collection(collection).doc(row.id).delete())
    }
  }
  for (const firmId of firms.splice(0)) {
    for (const collection of ["audit_outbox", "audit_log", "audit_dead_letter"]) {
      for (const row of await docsWhere(collection, "firmId", firmId)) deletions.push(db().collection(collection).doc(row.id).delete())
    }
    for (const row of await docsWhere("audit_dead_letter", "row.firmId", firmId)) deletions.push(db().collection("audit_dead_letter").doc(row.id).delete())
  }
  await Promise.all(deletions)
}

// ---------------------------------------------------------------------------------------------------------------------
// Requests: insecure-dev partner_a of firmA (the seeded identity), Firestore persistence on the emulator.
// ---------------------------------------------------------------------------------------------------------------------
type Probe = { res: Response; route: string }

/** Runs `handler` as one request through withSession. `flushFails`: the end-of-request audit flush fails (503). */
async function inRequest(
  handler: (request: Request) => Promise<Response | void>,
  opts: { flushFails?: boolean; method?: "GET" | "POST" } = {}
): Promise<Probe> {
  const path = `/api/f11-probe/${randomUUID()}`
  const method = opts.method ?? "POST"
  const route = `${method} ${path}`
  routes.push(route)
  if (opts.flushFails) {
    setRequestAuditSinkForTests(async () => {
      throw new Error("audit store down")
    })
  }
  try {
    const request =
      method === "GET"
        ? new Request(`http://127.0.0.1${path}?actorId=partner_a`)
        : new Request(`http://127.0.0.1${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ actorId: "partner_a", action: "probe" }),
          })
    const res = await withSession(request, async (req) => (await handler(req)) ?? Response.json({ ok: true }))
    return { res, route }
  } finally {
    setRequestAuditSinkForTests(null)
  }
}

const probeRef = () => {
  const id = randomUUID()
  created.push({ collection: "f11_probe", id })
  // The helpers' ref, typed as the Admin SDK's (the database here is the Admin Firestore), so a test can read it back.
  return doc(db(), "f11_probe", id) as ReturnType<typeof doc> & DocumentReference
}

function pushRow(action: string): AuditEntry {
  const row: AuditEntry = { action, actorId: "partner_a", target: "f11_probe", classification: "internal" }
  getRuntimeStore().audit.push(row)
  return row
}

async function claim(request: Request) {
  const started = await beginIdempotentRequest(request, randomUUID(), `f11-${randomUUID()}`)
  expect(started.claim, "a durable claim").toBeDefined()
  return started.claim!
}

// ---------------------------------------------------------------------------------------------------------------------
// Reconciler fixtures: outbox entries written directly in the spec's shape, firms of their own.
// ---------------------------------------------------------------------------------------------------------------------
function newFirm(): string {
  const firmId = `f11r-${randomUUID().slice(0, 8)}`
  firms.push(firmId)
  return firmId
}

function auditRow(firmId: string, over: Record<string, unknown> = {}): Row {
  return { id: `aud_${randomUUID()}`, firmId, action: "f11_probe_row", actorId: "f11-user", target: "f11_probe/x", classification: "internal", at: Date.now() - GRACE_MS - 120_000, ...over }
}

async function stageEntry(firmId: string | null, rows: unknown, over: Record<string, unknown> = {}, docId?: string): Promise<string> {
  const requestId = randomUUID()
  const id = docId ?? `${requestId}_0`
  await db()
    .collection("audit_outbox")
    .doc(id)
    .set({
      v: 1,
      surface: "next",
      firmId,
      actorId: "f11-user",
      route: "POST /api/f11-probe",
      requestAction: "probe",
      operationId: null,
      requestId,
      seq: 0,
      effectPaths: [`f11_probe/${randomUUID()}`],
      rows,
      stagedAt: new Date(Date.now() - GRACE_MS - 60_000),
      attempts: 0,
      ...over,
    })
  created.push({ collection: "audit_outbox", id })
  return id
}

async function auditLogOf(firmId: string): Promise<Row[]> {
  return docsWhere("audit_log", "firmId", firmId)
}

/** The database, except that every transaction is refused at once with UNAVAILABLE (retryable, never counted). */
function transactionsDown(real: Firestore): Firestore {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "runTransaction") return async () => Promise.reject(Object.assign(new Error("unavailable"), { code: 14 }))
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  })
}

/** The database, counting the transactions it has finished. */
function countingTransactions(real: Firestore): { db: Firestore; count: () => number } {
  let finished = 0
  const counted = new Proxy(real, {
    get(target, prop) {
      if (prop === "runTransaction") {
        return (fn: (tx: Transaction) => Promise<unknown>, options?: unknown) =>
          target.runTransaction(fn, options as never).finally(() => {
            finished += 1
          })
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  })
  return { db: counted, count: () => finished }
}

const sweepCursorRef = () => db().collection("platform").doc("auditOutboxSweepCursor")
const sweepCursor = async (): Promise<Record<string, unknown>> => (await sweepCursorRef().get()).data() ?? {}
const outboxHas = async (id: string) => (await db().collection("audit_outbox").doc(id).get()).exists

/** The database, except that the audit log refuses every create with `error` (inside the reconciler's transactions). */
function auditLogRefusing(real: Firestore, error: () => Error): Firestore {
  const wrapTx = (tx: Transaction) =>
    new Proxy(tx, {
      get(target, prop) {
        if (prop === "create") {
          return (ref: { path: string }, data: unknown) => {
            if (ref.path.startsWith("audit_log/")) throw error()
            return target.create(ref as never, data as never)
          }
        }
        const value = Reflect.get(target, prop, target) as unknown
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    })
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "runTransaction") {
        return (fn: (tx: Transaction) => Promise<unknown>, options?: unknown) => target.runTransaction((tx) => fn(wrapTx(tx)), options as never)
      }
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  })
}

/** Publishes or dead-letters every entry the emulator holds (other files' leftovers too), so a run starts empty. */
async function drainAll(reconcile: Reconcile): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const r = await reconcile({ db: db(), now: () => Date.now() + 365 * 24 * 3_600_000, log: recordingLog() })
    if (r.backlog.oldestAgeMs === null && (r.backlog.unreadable ?? 0) === 0) return
  }
  throw new Error("the outbox did not drain")
}

describe.runIf(HAS_FIRESTORE)("F11 audit outbox on Firestore", { timeout: 120_000 }, () => {
  beforeEach(() => {
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    vi.stubEnv("GCLOUD_PROJECT", process.env.GCLOUD_PROJECT ?? "demo-sikander")
    resetRuntimeStoreForTests()
    resetIdempotencyForTests()
    setFirestorePersistenceForTests(db())
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(async () => {
    setFirestorePersistenceForTests(null)
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    resetRuntimeStoreForTests()
    resetIdempotencyForTests()
    await cleanUp()
  })

  afterAll(async () => {
    // The reconciler's backlog state and sweep cursor (spec rulings 9 and 19), written by the runs above.
    await db().collection("platform").doc("auditOutboxBacklog").delete()
    await db().collection("platform").doc("auditOutboxSweepCursor").delete()
  })

  describe("staging: the entry commits with the effect, or neither does", () => {
    it("a fenced write stages its entry in the effect's transaction, with the rows pushed before it and the F10 operation", async () => {
      const ref = probeRef()
      let operationId: string | undefined
      let before: AuditEntry | undefined
      const { res, route } = await inRequest(
        async (request) => {
          const c = await claim(request)
          operationId = c.operationId
          before = pushRow("f11_before_write")
          await setDoc(ref, { n: 1 })
          pushRow("f11_after_write")
          c.complete({ ok: true })
        },
        { flushFails: true }
      )
      expect(res.status).toBe(503)
      expect((await ref.get()).exists).toBe(true)
      const entries = await entriesOf(route)
      expect(entries).toHaveLength(1)
      const entry = entries[0]!
      expect(entry.effectPaths).toEqual([ref.path])
      expect([entry.firmId, entry.actorId, entry.requestAction, entry.operationId]).toEqual(["firmA", "partner_a", "probe", operationId])
      expect((entry.rows as Row[]).map((r) => r.action)).toEqual(["f11_before_write"])
      expect((entry.rows as Row[])[0]).toMatchObject({ id: before!.id, firmId: "firmA", at: before!.at })
    })

    it("unfenced setDoc, updateDoc and deleteDoc each stage an entry; a row is staged once, with the first write after it", async () => {
      const [a, b] = [probeRef(), probeRef()]
      const { route } = await inRequest(
        async () => {
          pushRow("f11_r1")
          await setDoc(a, { n: 1 })
          pushRow("f11_r2")
          await updateDoc(a, { n: 2 })
          await setDoc(b, { n: 1 })
          await deleteDoc(b)
        },
        { flushFails: true }
      )
      const entries = (await entriesOf(route)).sort((x, y) => Number(x.seq) - Number(y.seq))
      expect(entries.map((e) => e.effectPaths)).toEqual([[a.path], [a.path], [b.path], [b.path]])
      expect(entries.map((e) => (e.rows as Row[]).map((r) => r.action))).toEqual([["f11_r1"], ["f11_r2"], [], []])
      expect((await a.get()).data()).toEqual({ n: 2 })
      expect((await b.get()).exists).toBe(false)
    })

    it("a repository transaction stages one entry naming every document it wrote, in the same commit", async () => {
      const [a, b] = [probeRef(), probeRef()]
      // A request with a row to flush, so the failing flush keeps its entries (a request with none has nothing to fail).
      const { res, route } = await inRequest(
        async () => {
          pushRow("f11_tx")
          await runTransaction(db(), async (tx) => {
            await tx.get(a)
            tx.set(a, { n: 1 })
            tx.set(b, { n: 1 })
          })
        },
        { flushFails: true }
      )
      expect(res.status).toBe(503)
      const entries = await entriesOf(route)
      expect(entries.map((e) => [...(e.effectPaths as string[])].sort())).toEqual([[a.path, b.path].sort()])
      expect(entries.map((e) => (e.rows as Row[]).map((r) => r.action))).toEqual([["f11_tx"]])
    })

    it("a provider dispatch is staged with its F10 marker, before it happens", async () => {
      let operationId: string | undefined
      const { res, route } = await inRequest(
        async (request) => {
          const c = await claim(request)
          operationId = c.operationId
          pushRow("f11_dispatch")
          await recordExternalEffect("p1_dispatch")
        },
        { flushFails: true }
      )
      // The failed flush's 503 after a committed effect is answered as F10's terminal 409 (F10 ruling 9).
      expect(res.status).toBe(409)
      const entries = await entriesOf(route)
      expect(entries.map((e) => [e.effectPaths, e.operationId])).toEqual([[["external:p1_dispatch"], operationId]])
      const markers = await docsWhere("idempotency_effects", "route", route)
      expect(markers.map((m) => m.kind)).toEqual(["p1_dispatch"])
    })

    it("the audit log, the dead letter, the outbox and F10's records are not effects; a write outside a request stages nothing", async () => {
      const auditId = `aud_${randomUUID()}`
      const letterId = `f11_${randomUUID()}`
      created.push({ collection: "audit_log", id: auditId }, { collection: "audit_dead_letter", id: letterId })
      const { route } = await inRequest(
        async () => {
          await setDoc(doc(db(), "audit_log", auditId), { firmId: "firmA", action: "x" })
          await setDoc(doc(db(), "audit_dead_letter", letterId), { firmId: "firmA" })
        },
        { flushFails: true }
      )
      expect(await entriesOf(route)).toEqual([])
      const outside = probeRef()
      await setDoc(outside, { n: 1 })
      const naming = (await docsWhere("audit_outbox", "firmId", "firmA")).filter((e) => (e.effectPaths as string[]).includes(outside.path))
      expect(naming).toEqual([])
    })

    it("a write the database refuses commits neither the effect nor an entry (fenced and unfenced)", async () => {
      const missing = probeRef()
      const unfenced = await inRequest(async () => {
        await updateDoc(missing, { n: 1 })
      })
      expect(unfenced.res.status).toBe(500)
      const fenced = await inRequest(async (request) => {
        await claim(request)
        await updateDoc(missing, { n: 1 })
      })
      expect(fenced.res.status).toBe(500)
      expect((await missing.get()).exists).toBe(false)
      expect([...(await entriesOf(unfenced.route)), ...(await entriesOf(fenced.route))]).toEqual([])
    })

    it("a request whose audit rows all persisted deletes its entries; its rows are in the audit log once", async () => {
      const ref = probeRef()
      let row: AuditEntry | undefined
      const { res, route } = await inRequest(async (request) => {
        const c = await claim(request)
        row = pushRow("f11_released")
        await setDoc(ref, { n: 1 })
        c.complete({ ok: true })
      })
      expect(res.status).toBe(200)
      expect(await entriesOf(route)).toEqual([])
      created.push({ collection: "audit_log", id: row!.id! })
      expect((await db().collection("audit_log").doc(row!.id!).get()).data()).toMatchObject({ action: "f11_released", firmId: "firmA" })
    })
  })

  // Review round 1 (Codex P1): the request deleted its entries whenever its flush succeeded, so a request that committed
  // an early write and then failed before pushing its action row (or pushed only decision rows) lost the only durable
  // record of that write. An entry is now released only when the request reached its audited end (spec ruling 18).
  describe("review round 1 (P1): a request releases its entries only when it reached its audited end", () => {
    const keptAfter = async (handler: (request: Request) => Promise<Response | void>, method: "GET" | "POST" = "POST") => {
      const { res, route } = await inRequest(handler, { method })
      return { status: res.status, entries: (await entriesOf(route)).length }
    }

    it("a write, then the route's own refusal (400): kept", async () => {
      const ref = probeRef()
      const out = await keptAfter(async (request) => {
        await claim(request)
        await setDoc(ref, { n: 1 })
        return Response.json({ error: "a later step refused", code: "REQUEST_FAILED" }, { status: 400 })
      })
      expect(out).toEqual({ status: 400, entries: 1 })
    })

    it("a write, then a throw: kept", async () => {
      const ref = probeRef()
      const out = await keptAfter(async (request) => {
        await claim(request)
        await setDoc(ref, { n: 1 })
        throw new Error("a later step failed")
      })
      // F10 answers a throw after a committed effect with its terminal 409.
      expect(out).toEqual({ status: 409, entries: 1 })
    })

    it("a write, a 2xx and a completed claim, but only decision rows (no action row): kept", async () => {
      const ref = probeRef()
      const out = await keptAfter(async (request) => {
        const c = await claim(request)
        expect(checkPermission(getRuntimeStore(), "partner_a", "list_matters").allow).toBe(true)
        await setDoc(ref, { n: 1 })
        c.complete({ ok: true })
      })
      expect(out).toEqual({ status: 200, entries: 1 })
    })

    it("a write, an action row and a 2xx, but the claim never completed: kept", async () => {
      const ref = probeRef()
      const out = await keptAfter(async (request) => {
        await claim(request)
        await setDoc(ref, { n: 1 })
        pushRow("f11_action")
      })
      expect(out).toEqual({ status: 200, entries: 1 })
    })

    it("a POST that took no claim, wrote, and recorded only decision rows (2xx): kept", async () => {
      const ref = probeRef()
      const out = await keptAfter(async () => {
        expect(checkPermission(getRuntimeStore(), "partner_a", "list_matters").allow).toBe(true)
        await setDoc(ref, { n: 1 })
      })
      expect(out).toEqual({ status: 200, entries: 1 })
    })

    it("a read whose derived write is followed by a refusal (404): kept", async () => {
      const ref = probeRef()
      const out = await keptAfter(async () => {
        await setDoc(ref, { n: 1 })
        return Response.json({ error: "unknown matter" }, { status: 404 })
      }, "GET")
      expect(out).toEqual({ status: 404, entries: 1 })
    })

    it("controls: a completed action (its row pushed after its writes), a claimless action with its row, and a read's derived write, are released", async () => {
      const [a, b, c, d] = [probeRef(), probeRef(), probeRef(), probeRef()]
      const action = await keptAfter(async (request) => {
        const held = await claim(request)
        await setDoc(a, { n: 1 })
        await setDoc(b, { n: 1 })
        pushRow("f11_action")
        held.complete({ ok: true })
      })
      const unclaimed = await keptAfter(async () => {
        await setDoc(d, { n: 1 })
        pushRow("f11_action")
      })
      const read = await keptAfter(async () => {
        await setDoc(c, { n: 1 })
      }, "GET")
      expect([action, unclaimed, read]).toEqual([
        { status: 200, entries: 0 },
        { status: 200, entries: 0 },
        { status: 200, entries: 0 },
      ])
    })

    it("a kept entry is published by the reconciler: the committed write gets its recovered row", async () => {
      const reconcile = await reconciler()
      const ref = probeRef()
      const { route } = await inRequest(async (request) => {
        await claim(request)
        await setDoc(ref, { n: 1 })
        return Response.json({ error: "a later step refused", code: "REQUEST_FAILED" }, { status: 400 })
      })
      const [entry] = await entriesOf(route)
      expect(entry).toBeDefined()
      created.push({ collection: "audit_log", id: `aud_outbox_${entry!.id}` })
      await reconcile({ db: db(), now: PAST_GRACE, log: recordingLog() })
      const recovered = await docsWhere("audit_log", "requestId", entry!.requestId)
      expect(recovered.map((r) => [r.action, r.target])).toEqual([["request_effect_recovered", ref.path]])
    })
  })

  describe("the reconciler", () => {
    it("publishes a crashed request's staged rows and one recovered row, exactly once, however many runs race", async () => {
      const reconcile = await reconciler()
      const ref = probeRef()
      let staged: AuditEntry | undefined
      const { route } = await inRequest(
        async () => {
          staged = pushRow("f11_staged")
          await setDoc(ref, { n: 1 })
        },
        { flushFails: true }
      )
      const [entry] = await entriesOf(route)
      expect(entry).toBeDefined()
      created.push({ collection: "audit_log", id: staged!.id! }, { collection: "audit_log", id: `aud_outbox_${entry!.id}` })

      // Within the grace, a live request may still publish it: untouched.
      await reconcile({ db: db(), now: () => Date.now(), log: recordingLog() })
      expect(await entriesOf(route)).toHaveLength(1)

      await Promise.all([reconcile({ db: db(), now: PAST_GRACE, log: recordingLog() }), reconcile({ db: db(), now: PAST_GRACE, log: recordingLog() })])
      await reconcile({ db: db(), now: PAST_GRACE, log: recordingLog() })
      expect(await entriesOf(route)).toEqual([])
      const published = (await db().collection("audit_log").doc(staged!.id!).get()).data()
      expect(published).toMatchObject({ action: "f11_staged", firmId: "firmA", actorId: "partner_a", at: staged!.at })
      const recovered = await docsWhere("audit_log", "requestId", entry!.requestId)
      expect(recovered).toHaveLength(1)
      expect(recovered[0]).toMatchObject({
        id: `aud_outbox_${entry!.id}`,
        firmId: "firmA",
        action: "request_effect_recovered",
        actorId: "system",
        onBehalfOf: "partner_a",
        target: ref.path,
        effectPaths: [ref.path],
        route,
        requestAction: "probe",
        classification: "privileged-restricted",
        reason: "audit_unconfirmed",
        stagedRowIds: [staged!.id],
      })
    })

    it("never overwrites an audit row that exists (insert-only): the request's own copy wins", async () => {
      const reconcile = await reconciler()
      const firmId = newFirm()
      const row = auditRow(firmId)
      await db().collection("audit_log").doc(row.id).set({ ...row, reason: "the request's own enriched copy" })
      const entryId = await stageEntry(firmId, [row])
      const result = await reconcile({ db: db(), now: PAST_GRACE, log: recordingLog() })
      expect(result.published).toContain(entryId)
      expect((await db().collection("audit_log").doc(row.id).get()).data()?.reason).toBe("the request's own enriched copy")
      expect((await auditLogOf(firmId)).map((r) => r.id).sort()).toEqual([row.id, `aud_outbox_${entryId}`].sort())
    })

    it("a poisoned row goes to the dead letter under the entry's firm; the entry's other rows are published", async () => {
      const reconcile = await reconciler()
      const firmId = newFirm()
      const good = auditRow(firmId)
      const poisoned = { ...auditRow(firmId), action: "" }
      const entryId = await stageEntry(firmId, [good, poisoned])
      const log = recordingLog()
      await reconcile({ db: db(), now: PAST_GRACE, log })
      expect((await auditLogOf(firmId)).map((r) => r.id).sort()).toEqual([good.id, `aud_outbox_${entryId}`].sort())
      const letters = await docsWhere("audit_dead_letter", "firmId", firmId)
      expect(letters.map((l) => [l.reason, (l.row as Row).id, l.outboxId])).toEqual([["row_malformed", poisoned.id, entryId]])
      expect(log.lines.some((l) => l.level === "error" && l.message === "audit.outbox_row_dead_lettered")).toBe(true)
      expect(await docsWhere("audit_outbox", "firmId", firmId)).toEqual([])
    })

    it("a row of another firm is never published into that firm's log: it is dead-lettered under the entry's firm", async () => {
      const reconcile = await reconciler()
      const [firmA, firmB] = [newFirm(), newFirm()]
      const smuggled = auditRow(firmB)
      const entryId = await stageEntry(firmA, [smuggled])
      await reconcile({ db: db(), now: PAST_GRACE, log: recordingLog() })
      expect(await auditLogOf(firmB)).toEqual([])
      expect((await auditLogOf(firmA)).map((r) => r.id)).toEqual([`aud_outbox_${entryId}`])
      const repos = createFirestoreRepositories(db() as never)
      expect((await repos.auditDeadLetter.listByFirm(firmA)).map((l) => [l.reason, l.row.id])).toEqual([["cross_firm_row", smuggled.id]])
      expect(await repos.auditDeadLetter.listByFirm(firmB)).toEqual([])
    })

    it("a malformed entry, or one with no firm, is dead-lettered whole", async () => {
      const reconcile = await reconciler()
      const firmId = newFirm()
      const malformed = await stageEntry(firmId, "not rows")
      const noFirm = await stageEntry(null, [auditRow(firmId)], { actorId: `f11-nofirm-${randomUUID()}` })
      const log = recordingLog()
      const result = await reconcile({ db: db(), now: PAST_GRACE, log })
      expect(result.deadLettered).toEqual(expect.arrayContaining([malformed, noFirm]))
      const letters = [...(await docsWhere("audit_dead_letter", "outboxId", malformed)), ...(await docsWhere("audit_dead_letter", "outboxId", noFirm))]
      for (const letter of letters) created.push({ collection: "audit_dead_letter", id: letter.id })
      expect(letters.map((l) => l.reason).sort()).toEqual(["entry_malformed", "entry_no_firm"])
      expect(await auditLogOf(firmId)).toEqual([])
      expect(log.lines.filter((l) => l.level === "error" && l.message === "audit.outbox_dead_lettered")).toHaveLength(2)
    })

    it("non-retryable failures are counted and the third dead-letters the entry; retryable ones never count", async () => {
      const reconcile = await reconciler()
      const firmId = newFirm()
      const transientEntry = await stageEntry(firmId, [auditRow(firmId)])
      const transient = auditLogRefusing(db(), () => Object.assign(new Error("unavailable"), { code: 14 }))
      for (let i = 0; i < 3; i += 1) await reconcile({ db: transient, now: PAST_GRACE, log: recordingLog() })
      expect((await db().collection("audit_outbox").doc(transientEntry).get()).data()?.attempts).toBe(0)
      await db().collection("audit_outbox").doc(transientEntry).delete()

      const failingEntry = await stageEntry(firmId, [auditRow(firmId)])
      const failing = auditLogRefusing(db(), () => Object.assign(new Error("row refused"), { code: 3 }))
      const attempts: unknown[] = []
      for (let i = 0; i < 3; i += 1) {
        await reconcile({ db: failing, now: PAST_GRACE, log: recordingLog() })
        attempts.push((await db().collection("audit_outbox").doc(failingEntry).get()).data()?.attempts ?? "gone")
      }
      expect(attempts).toEqual([1, 2, "gone"])
      expect(await auditLogOf(firmId)).toEqual([])
      expect((await docsWhere("audit_dead_letter", "outboxId", failingEntry)).map((l) => l.reason)).toEqual(["publish_failed"])
    })

    // Review round 1 (Codex P2): an entry whose stagedAt is missing or not a timestamp is invisible to the stagedAt range
    // query and to the backlog queries, so it was never dead-lettered and never counted (spec ruling 19).
    it("review round 1 (P2): an entry whose stagedAt is missing, not a Timestamp (text, number, map, null), or a year ahead, is dead-lettered by the sweep", async () => {
      const reconcile = await reconciler()
      const firmId = newFirm()
      const missing = await stageEntry(firmId, [auditRow(firmId)])
      await db().collection("audit_outbox").doc(missing).update({ stagedAt: FieldValue.delete() })
      const text = await stageEntry(firmId, [auditRow(firmId)], { stagedAt: "yesterday" })
      const ahead = await stageEntry(firmId, [auditRow(firmId)], { stagedAt: new Date(Date.now() + 365 * 24 * 3_600_000) })
      // A number of milliseconds, and a map shaped like a Timestamp: neither is in the stagedAt range the pass reads.
      const millis = await stageEntry(firmId, [auditRow(firmId)], { stagedAt: Date.now() - GRACE_MS - 60_000 })
      const shaped = await stageEntry(firmId, [auditRow(firmId)], { stagedAt: { seconds: 1_700_000_000, nanoseconds: 0 } })
      const absent = await stageEntry(firmId, [auditRow(firmId)], { stagedAt: null })
      const ids = [missing, text, ahead, millis, shaped, absent]
      const present = async () =>
        (await Promise.all(ids.map(async (id) => (await db().collection("audit_outbox").doc(id).get()).exists))).filter(Boolean).length
      // The sweep reads a bounded page per run from a cursor that wraps; leftovers of other files may come first.
      let runs = 0
      while ((await present()) > 0 && runs < 25) {
        await reconcile({ db: db(), log: recordingLog() })
        runs += 1
      }
      expect(await present()).toBe(0)
      const letters = (await Promise.all(ids.map((id) => docsWhere("audit_dead_letter", "outboxId", id)))).flat()
      expect(letters.map((l) => [l.reason, l.firmId])).toEqual(ids.map(() => ["entry_malformed", firmId]))
      expect(await auditLogOf(firmId)).toEqual([])
    })

    it("review round 1 (P2): such an entry that cannot be dead-lettered counts toward the backlog alert", async () => {
      const reconcile = await reconciler()
      await drainAll(reconcile)
      const firmId = newFirm()
      const entryId = await stageEntry(firmId, [auditRow(firmId)])
      await db().collection("audit_outbox").doc(entryId).update({ stagedAt: FieldValue.delete() })
      // The cursor may sit anywhere: run until the sweep reaches the entry (the outbox holds only it after the drain).
      let fired: ReconcileResult | undefined
      const log = recordingLog()
      for (let i = 0; i < 3 && !fired?.backlog.firing; i += 1) fired = await reconcile({ db: transactionsDown(db()), log })
      expect([fired?.backlog.firing, fired?.backlog.unreadable]).toEqual([true, 1])
      expect(log.lines.some((l) => l.level === "error" && l.message === "audit.outbox_backlog_stale")).toBe(true)
      const cleared = await reconcile({ db: db(), log: recordingLog() })
      expect(cleared.deadLettered).toContain(entryId)
      expect([cleared.backlog.firing, cleared.backlog.unreadable]).toEqual([false, 0])
    })

    it("review round 1 (P2): the sweep reads one bounded page a run, by document id, from a cursor that wraps", async () => {
      const reconcile = await reconciler()
      await drainAll(reconcile)
      await sweepCursorRef().delete()
      const firmId = newFirm()
      const tag = `f11sweep-${randomUUID().slice(0, 8)}`
      // Five entries in document-id order: three fresh ones (inside the grace: the pass leaves them), then two unreadable.
      const ids = ["a", "b", "c", "d", "e"].map((s) => `${tag}-${s}`)
      for (const [i, id] of ids.entries()) await stageEntry(firmId, [auditRow(firmId)], { stagedAt: i < 3 ? new Date() : "unreadable" }, id)
      const exists = outboxHas
      const cursor = async () => (await sweepCursor()).after
      const run = () => reconcile({ db: db(), log: recordingLog(), sweepPageSize: 2 })
      const first = await run()
      expect([first.deadLettered, await cursor(), await exists(ids[3]!), await exists(ids[4]!)]).toEqual([[], ids[1], true, true])
      const second = await run()
      expect([second.deadLettered, await cursor(), await exists(ids[3]!), await exists(ids[4]!)]).toEqual([[ids[3]], ids[3], false, true])
      const third = await run()
      expect([third.deadLettered, await cursor(), await exists(ids[4]!)]).toEqual([[ids[4]], "", false])
      expect(await Promise.all(ids.slice(0, 3).map(exists))).toEqual([true, true, true])
      await drainAll(reconcile)
    })

    it("review round 1 (P2): a full page, then an empty one, wraps the cursor to the start", async () => {
      const reconcile = await reconciler()
      await drainAll(reconcile)
      await sweepCursorRef().delete()
      const firmId = newFirm()
      const tag = `f11sweep-${randomUUID().slice(0, 8)}`
      const [a, b, first] = [`${tag}-a`, `${tag}-b`, `${tag}-0`]
      for (const id of [a, b]) await stageEntry(firmId, [auditRow(firmId)], { stagedAt: new Date() }, id)
      const run = () => reconcile({ db: db(), log: recordingLog(), sweepPageSize: 2 })
      await run()
      expect((await sweepCursor()).after).toBe(b)
      // An unreadable entry that sorts before the cursor: only a wrap reaches it.
      await stageEntry(firmId, [auditRow(firmId)], { stagedAt: "unreadable" }, first)
      const empty = await run()
      expect([empty.deadLettered, (await sweepCursor()).after, await outboxHas(first)]).toEqual([[], "", true])
      const wrapped = await run()
      expect([wrapped.deadLettered, (await sweepCursor()).after, await outboxHas(first)]).toEqual([[first], a, false])
      await drainAll(reconcile)
    })

    it("review round 1 (P2): a run the budget stops mid-page keeps the cursor on the last entry it handled; the next run sweeps the rest", async () => {
      const reconcile = await reconciler()
      await drainAll(reconcile)
      await sweepCursorRef().delete()
      const firmId = newFirm()
      const tag = `f11sweep-${randomUUID().slice(0, 8)}`
      const ids = ["a", "b", "c"].map((s) => `${tag}-${s}`)
      for (const id of ids) await stageEntry(firmId, [auditRow(firmId)], { stagedAt: "unreadable" }, id)
      // The budget is spent once the run has handled one entry (a dead-letter is one transaction).
      const counted = countingTransactions(db())
      const stopped = await reconcile({ db: counted.db, log: recordingLog(), sweepPageSize: 10, clock: () => (counted.count() > 0 ? 3_600_000 : 0) })
      expect([stopped.deadLettered, (await sweepCursor()).after, await outboxHas(ids[1]!), await outboxHas(ids[2]!)]).toEqual([[ids[0]], ids[0], true, true])
      const next = await reconcile({ db: db(), log: recordingLog(), sweepPageSize: 10 })
      expect([next.deadLettered, (await sweepCursor()).after, await outboxHas(ids[1]!), await outboxHas(ids[2]!)]).toEqual([[ids[1], ids[2]], "", false, false])
    })

    it("review round 1 (P2): an entry the sweep cannot dead-letter stays pending and counted; a full pending list stops the cursor before the next", async () => {
      const reconcile = await reconciler()
      await drainAll(reconcile)
      await sweepCursorRef().delete()
      const firmId = newFirm()
      const tag = `f11sweep-${randomUUID().slice(0, 8)}`
      const ids = ["a", "b", "c"].map((s) => `${tag}-${s}`)
      for (const id of ids) await stageEntry(firmId, [auditRow(firmId)], { stagedAt: "unreadable" }, id)
      const limits = { sweepPageSize: 10, sweepPendingMax: 1 }
      for (let run = 0; run < 2; run += 1) {
        const down = await reconcile({ db: transactionsDown(db()), log: recordingLog(), ...limits })
        const state = await sweepCursor()
        expect([down.backlog.unreadable, down.backlog.firing, state.after, state.pending]).toEqual([2, true, ids[0], [ids[0]]])
      }
      const up = await reconcile({ db: db(), log: recordingLog(), ...limits })
      const state = await sweepCursor()
      expect([up.deadLettered, up.backlog.unreadable, state.after, state.pending]).toEqual([ids, 0, "", []])
    })

    it("review round 1 (P2): a null stagedAt (it sorts first) does not hide the oldest entry's age from the alert", async () => {
      const reconcile = await reconciler()
      await drainAll(reconcile)
      const firmId = newFirm()
      await stageEntry(firmId, [auditRow(firmId)], { stagedAt: new Date(Date.now() - ALERT_AGE_MS - 5 * 60_000) })
      await stageEntry(firmId, [auditRow(firmId)], { stagedAt: null })
      const fired = await reconcile({ db: transactionsDown(db()), log: recordingLog() })
      expect(fired.backlog.firing).toBe(true)
      expect(fired.backlog.oldestAgeMs).toBeGreaterThanOrEqual(ALERT_AGE_MS)
      await drainAll(reconcile)
    })

    it("the backlog alert fires while the oldest entry is older than 20 minutes and clears when the outbox drains", async () => {
      const reconcile = await reconciler()
      await drainAll(reconcile)
      const firmId = newFirm()
      await stageEntry(firmId, [auditRow(firmId)], { stagedAt: new Date(Date.now() - ALERT_AGE_MS - 5 * 60_000) })
      const down = auditLogRefusing(db(), () => Object.assign(new Error("unavailable"), { code: 14 }))

      const first = recordingLog()
      const fired = await reconcile({ db: down, log: first })
      expect([fired.backlog.firing, fired.backlog.transition]).toEqual([true, "fired"])
      expect(fired.backlog.oldestAgeMs).toBeGreaterThanOrEqual(ALERT_AGE_MS)
      expect(first.lines.some((l) => l.level === "error" && l.message === "audit.outbox_backlog_stale")).toBe(true)
      expect((await db().collection("platform").doc("auditOutboxBacklog").get()).data()?.firing).toBe(true)

      const second = recordingLog()
      const still = await reconcile({ db: down, log: second })
      expect([still.backlog.firing, still.backlog.transition]).toEqual([true, null])
      expect(second.lines.some((l) => l.level === "error" && l.message === "audit.outbox_backlog_stale")).toBe(true)

      const third = recordingLog()
      const cleared = await reconcile({ db: db(), log: third })
      expect([cleared.backlog.firing, cleared.backlog.transition, cleared.backlog.oldestAgeMs]).toEqual([false, "cleared", null])
      expect(third.lines.some((l) => l.level === "info" && l.message === "audit.outbox_backlog_cleared")).toBe(true)
      expect(third.lines.some((l) => l.message === "audit.outbox_backlog_stale")).toBe(false)
      expect((await db().collection("platform").doc("auditOutboxBacklog").get()).data()?.firing).toBe(false)
    })
  })

  describe("the dead letter lists by firm (F12 re-audit LOW-2)", () => {
    it("listByFirm returns the firm's letters, including ones stored before the fix, and no other firm's", async () => {
      const [firmA, firmB] = [newFirm(), newFirm()]
      const repos = createFirestoreRepositories(db() as never)
      const at = Date.now()
      await repos.auditDeadLetter.append({ row: auditRow(firmA) as AuditEntry, reason: "a", deadLetteredAt: at })
      await repos.auditDeadLetter.append({ row: auditRow(firmB) as AuditEntry, reason: "b", deadLetteredAt: at })
      // The shape main stored: the firm only inside the row.
      const legacyId = `legacy_${randomUUID()}`
      await db().collection("audit_dead_letter").doc(legacyId).set({ row: auditRow(firmA), reason: "legacy", deadLetteredAt: at - 1 })
      created.push({ collection: "audit_dead_letter", id: legacyId })

      const listedA = await repos.auditDeadLetter.listByFirm(firmA)
      const listedB = await repos.auditDeadLetter.listByFirm(firmB)
      expect(listedA.map((l) => [l.reason, l.row.firmId]).sort()).toEqual([["a", firmA], ["legacy", firmA]])
      expect(listedB.map((l) => [l.reason, l.row.firmId])).toEqual([["b", firmB]])
    })
  })
})
