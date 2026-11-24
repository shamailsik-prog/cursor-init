import { FieldPath, FieldValue, Query, Timestamp, type DocumentData, type DocumentReference } from "firebase-admin/firestore"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { adminDb } from "../src/admin"
import { EMULATORS, uniq } from "./emu"
import { deleteFirmData } from "./firmCleanup"
import { sweepOrigins } from "./jobs"

/**
 * PR #120 review (Codex P2, thread 4367607820): each checker query read a fixed first 500 rows and kept no cursor, so
 * during a persistent backlog the same prefix came back every run and anything behind it (another firm's incident
 * among them) was never reported. The correction: each query pages from a cursor persisted in a checker-state document
 * (`platform/opsAlertChecker`, server-only like all of `platform/*`), at most a bounded number of rows per run, and wraps
 * to the start after its last page, so every row of a backlog is reached within ceil(backlog / window) runs.
 *
 * Firm A's backlog (501 rows, the first row past a 500-row window) sorts before firm B's three rows. The window is
 * 500 rows per query per run (5 pages of 100). On the code before the fix every run reads the same first 500 rows,
 * all firm A's, and firm B is never alerted. Typed-cursor cases stop after one full page (100 rows) instead of seeding
 * another 500: the 501-row backlogs still prove the five-page window.
 */

const WINDOW = 500
const BACKLOG = 501
/** Held query, then the first quarantined page. The next page sees the scan budget and the cursor is kept. */
const STOP_AFTER_HELD_AND_ONE_QUARANTINE_PAGE = 2
const CLEANUP_TIMEOUT_MS = 120_000
const SEED_TIMEOUT_MS = 120_000
const E2E_TIMEOUT_MS = 120_000

const CHECKER = ["..", "src", "alerts", "checker"].join("/")
type CheckerModule = {
  runAlertChecker: (o: { now: () => number; passes?: string[]; wallClock?: () => number }) => Promise<{ raised: string[] }>
  CHECK_PAGE_SIZE?: number
  CHECK_MAX_PAGES?: number
  CHECKER_BUDGET_MS?: number
}
const checker = async (): Promise<CheckerModule> => (await import(/* @vite-ignore */ CHECKER)) as CheckerModule

const stateRef = () => adminDb().collection("platform").doc("opsAlertChecker")
const alertOf = async (firmId: string, condition: string): Promise<DocumentData | undefined> =>
  (await adminDb().collection("ops_alerts").where("firmId", "==", firmId).get()).docs.map((d) => d.data()).find((a) => a.condition === condition)

async function writeAll(rows: Array<[DocumentReference, DocumentData]>): Promise<void> {
  for (let i = 0; i < rows.length; i += 400) {
    const batch = adminDb().batch()
    for (const [ref, data] of rows.slice(i, i + 400)) batch.set(ref, data)
    await batch.commit()
  }
}

/** Counts this test's own ids. Other suites may leave `reconcile_failed` rows; those are not this test's precondition. */
async function countOwnIds(prefix: string): Promise<number> {
  return (await adminDb().collection("ai_reservations").orderBy(FieldPath.documentId()).startAt(prefix).endAt(`${prefix}\uf8ff`).select().get()).size
}

async function deleteWhereFirm(collection: string, firmIds: string[]): Promise<void> {
  for (const firmId of firmIds) {
    const snap = await adminDb().collection(collection).where("firmId", "==", firmId).select().get()
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = adminDb().batch()
      for (const d of snap.docs.slice(i, i + 400)) batch.delete(d.ref)
      await batch.commit()
    }
  }
}

/**
 * Runs the checker until `done()` holds or `maxRuns` runs have passed; returns the run (1-based) at which it held, or
 * null. `now(run)` is each run's clock.
 */
async function runUntil(passes: string[], now: (run: number) => number, maxRuns: number, done: () => Promise<boolean>): Promise<number | null> {
  const { runAlertChecker } = await checker()
  for (let run = 1; run <= maxRuns; run++) {
    await runAlertChecker({ now: () => now(run), passes })
    if (await done()) return run
  }
  return null
}

/**
 * One checker run whose wall clock reaches the scan budget after `queryGetsBeforeStop` query reads. The page that
 * just completed is kept as the cursor; the next page is not read. Restores `Query.prototype.get` before returning.
 */
async function runStoppingAfterQueries(passes: string[], now: () => number, queryGetsBeforeStop: number): Promise<{ raised: string[] }> {
  const { runAlertChecker, CHECKER_BUDGET_MS } = await checker()
  const budget = CHECKER_BUDGET_MS ?? 40_000
  const original = Query.prototype.get
  let gets = 0
  Query.prototype.get = async function (this: Query) {
    const snap = await original.call(this)
    gets += 1
    return snap
  }
  try {
    return await runAlertChecker({ now, passes, wallClock: () => (gets >= queryGetsBeforeStop ? budget : 0) })
  } finally {
    Query.prototype.get = original
  }
}

describe.skipIf(!EMULATORS)("PR #120 review: the checker pages through a persistent backlog across runs (e2e)", () => {
  let firmA: string
  let firmB: string

  beforeEach(async () => {
    firmA = uniq("firm")
    firmB = uniq("firm")
    await stateRef().delete()
  }, SEED_TIMEOUT_MS)

  const extraFirms: string[] = []

  afterEach(async () => {
    await deleteWhereFirm("jobs", [firmA, firmB])
    await deleteWhereFirm("ai_reservations", [firmA, firmB, ...extraFirms])
    await stateRef().delete()
    await deleteFirmData([firmA, firmB, ...extraFirms])
    extraFirms.length = 0
  }, CLEANUP_TIMEOUT_MS)

  it("quarantined reservations: firm B's rows behind 501 of firm A's raise firm B's alert within the bounded runs; the cursor then wraps to firm A", { timeout: E2E_TIMEOUT_MS }, async () => {
    const T = Date.parse("2001-05-01T10:00:00.000Z")
    const tag = uniq("p").slice(2)
    const row = (firmId: string) => ({ firmId, state: "reconcile_failed", leaseUntil: Timestamp.fromMillis(T), reservedMicroUsd: 1, monthKey: "2001-05", createdAt: Timestamp.fromMillis(T) })
    const ref = (id: string) => adminDb().collection("ai_reservations").doc(id)
    // Equal `leaseUntil`, so the document id is the tie-break: firm A's backlog first ("000000…"), firm B's after every other id ("zzzzzz…").
    await writeAll([
      ...Array.from({ length: BACKLOG }, (_, i) => [ref(`000000f43-${tag}-${String(i).padStart(4, "0")}`), row(firmA)] as [DocumentReference, DocumentData]),
      ...Array.from({ length: 3 }, (_, i) => [ref(`zzzzzzf43-${tag}-${i}`), row(firmB)] as [DocumentReference, DocumentData]),
    ])
    // Other suites' quarantined rows share the collection; the bound counts them too.
    const total = (await adminDb().collection("ai_reservations").where("state", "==", "reconcile_failed").count().get()).data().count
    const maxRuns = Math.ceil(total / WINDOW)
    expect(maxRuns).toBeGreaterThanOrEqual(2)

    const at = (run: number) => T + 60 * 60_000 + run * 5 * 60_000
    const reached = await runUntil(["reservations"], at, maxRuns + 2, async () => (await alertOf(firmB, "ai.reservation_unresolved")) !== undefined)
    // Never in the first run (a window holds at most 500 rows, all firm A's), always within ceil(total / 500) runs.
    expect(reached).not.toBeNull()
    expect(reached!).toBeGreaterThanOrEqual(2)
    expect(reached!).toBeLessThanOrEqual(maxRuns)
    expect((await alertOf(firmB, "ai.reservation_unresolved"))?.detail).toMatchObject({ quarantined: 3 })

    // The run that reached firm B read to the end of the backlog, so the cursor wraps: firm A is read again.
    const before = (await alertOf(firmA, "ai.reservation_unresolved"))!.count as number
    const again = await runUntil(["reservations"], (run) => at(reached! + run), 2, async () => ((await alertOf(firmA, "ai.reservation_unresolved"))!.count as number) > before)
    expect(again).not.toBeNull()
  })

  it("waiting jobs: firm B's jobs behind 501 of firm A's raise firm B's job.queue_age within the bounded runs; the cursor then wraps to firm A", { timeout: E2E_TIMEOUT_MS }, async () => {
    const T0 = sweepOrigins(1100)()
    const job = (firmId: string, dueMs: number) => ({
      engine: "p2",
      schemaVersion: 1,
      firmId,
      jobType: "platform.diagnostic",
      status: "queued",
      attempts: 0,
      nextAttemptAt: Timestamp.fromMillis(dueMs),
      sweepAt: Timestamp.fromMillis(dueMs + 30_000),
      dispatchedAt: Timestamp.fromMillis(dueMs),
      redispatches: 0,
      createdAt: FieldValue.serverTimestamp(),
    })
    const ref = (id: string) => adminDb().collection("jobs").doc(id)
    const tag = uniq("j").slice(2)
    await writeAll([
      ...Array.from({ length: BACKLOG }, (_, i) => [ref(`jf43a${tag}${String(i).padStart(4, "0")}`), job(firmA, T0 + i)] as [DocumentReference, DocumentData]),
      ...Array.from({ length: 3 }, (_, i) => [ref(`jf43b${tag}${i}`), job(firmB, T0 + 10_000 + i)] as [DocumentReference, DocumentData]),
    ])
    const at = (run: number) => T0 + 60 * 60_000 + run * 5 * 60_000
    const reached = await runUntil(["jobs"], at, 4, async () => (await alertOf(firmB, "job.queue_age")) !== undefined)
    // Nothing older than these rows exists in the emulator (sweepOrigins(1100)), so the backlog is exactly 504 rows: 2 runs.
    expect(reached).toBe(2)
    expect((await alertOf(firmB, "job.queue_age"))?.detail).toMatchObject({ waiting: 3 })

    const before = (await alertOf(firmA, "job.queue_age"))!.count as number
    const again = await runUntil(["jobs"], (run) => at(2 + run), 2, async () => ((await alertOf(firmA, "job.queue_age"))!.count as number) > before)
    expect(again).not.toBeNull()
  })

  it("FA-F43-R1-004: a late id with the oldest leaseUntil is alerted on the first quarantined page, and the cursor stores that time", { timeout: E2E_TIMEOUT_MS }, async () => {
    const T = Date.parse("1970-01-03T00:00:00.000Z")
    const tag = uniq("q").slice(2)
    const row = (firmId: string, leaseMs: number) => ({ firmId, state: "reconcile_failed", leaseUntil: Timestamp.fromMillis(leaseMs), reservedMicroUsd: 1, monthKey: "1970-01", createdAt: Timestamp.fromMillis(leaseMs) })
    const ref = (id: string) => adminDb().collection("ai_reservations").doc(id)
    // One full page: the three oldest leases carry the late ids, and 97 newer leases fill the page so the saved cursor is a time.
    await writeAll([
      ...Array.from({ length: 97 }, (_, i) => [ref(`000000f43-${tag}-${String(i).padStart(4, "0")}`), row(firmA, T + 10_000 + i)] as [DocumentReference, DocumentData]),
      ...Array.from({ length: 3 }, (_, i) => [ref(`zzzzzzf43-${tag}-${i}`), row(firmB, T + i)] as [DocumentReference, DocumentData]),
    ])
    const older = (await adminDb().collection("ai_reservations").where("state", "==", "reconcile_failed").where("leaseUntil", "<", Timestamp.fromMillis(T)).count().get()).data().count
    expect(older).toBe(0)

    await runStoppingAfterQueries(["reservations"], () => T + 60 * 60_000, STOP_AFTER_HELD_AND_ONE_QUARANTINE_PAGE)

    expect((await alertOf(firmB, "ai.reservation_unresolved"))?.detail).toMatchObject({ quarantined: 3 })
    const cursor = (await stateRef().get()).get("cursors")?.reservationsQuarantined as { at?: { toMillis?: () => number }; id?: string } | undefined
    expect(typeof cursor?.at?.toMillis).toBe("function")
    expect(cursor!.at!.toMillis!()).toBeGreaterThan(T + 2)
  })

  it("FA-260-R3-001: a number leaseUntil at row 100 is carried, and held rows plus the timestamp rows are alerted with no stall", { timeout: E2E_TIMEOUT_MS }, async () => {
    const T = Date.parse("1970-01-08T00:00:00.000Z")
    const tag = uniq("n1").slice(2)
    const firmNum = uniq("firm")
    const firmTs = uniq("firm")
    const heldFirms = Array.from({ length: 12 }, () => uniq("firm"))
    extraFirms.push(firmNum, firmTs, ...heldFirms)
    expect(await countOwnIds(`n1num-${tag}-`)).toBe(0)
    const ref = (id: string) => adminDb().collection("ai_reservations").doc(id)
    const quarantined = (firmId: string, leaseUntil: number | Timestamp) => ({ firmId, state: "reconcile_failed", leaseUntil, reservedMicroUsd: 1, monthKey: "1970-01", createdAt: Timestamp.fromMillis(T) })
    await writeAll([
      ...Array.from({ length: 100 }, (_, i) => [ref(`n1num-${tag}-${String(i).padStart(4, "0")}`), quarantined(firmNum, -1_000 + i)] as [DocumentReference, DocumentData]),
      ...Array.from({ length: 20 }, (_, i) => [ref(`n1ts-${tag}-${String(i).padStart(4, "0")}`), quarantined(firmTs, Timestamp.fromMillis(1 + i))] as [DocumentReference, DocumentData]),
      ...heldFirms.map((firmId, i) => [ref(`n1held-${tag}-${String(i).padStart(2, "0")}`), { firmId, state: "reserved", leaseUntil: Timestamp.fromMillis(T), reservedMicroUsd: 1, monthKey: "1970-01", createdAt: Timestamp.fromMillis(T) }] as [DocumentReference, DocumentData]),
    ])

    const { runAlertChecker } = await checker()
    const now = () => T + 60 * 60_000
    await runAlertChecker({ now, passes: ["reservations"] })
    expect(await alertOf(firmNum, "ai.reservation_unresolved")).toBeDefined()
    expect(await alertOf(firmTs, "ai.reservation_unresolved")).toBeDefined()
    for (const firmId of heldFirms) expect(await alertOf(firmId, "ai.reservation_unresolved"), firmId).toBeDefined()
    const before = (await alertOf(firmNum, "ai.reservation_unresolved"))!.count as number
    await runAlertChecker({ now, passes: ["reservations"] })
    expect((await alertOf(firmNum, "ai.reservation_unresolved"))!.count as number).toBeGreaterThan(before)
  })

  it("FA-260-R3-001: a string leaseUntil at the page edge is stored, the tail is read on the next run, and 12 held firms are alerted", { timeout: E2E_TIMEOUT_MS }, async () => {
    const T = Date.parse("1970-01-09T00:00:00.000Z")
    const tag = uniq("n3").slice(2)
    const firmTs = uniq("firm")
    const firmHead = uniq("firm")
    const firmTail = uniq("firm")
    const heldFirms = Array.from({ length: 12 }, () => uniq("firm"))
    extraFirms.push(firmTs, firmHead, firmTail, ...heldFirms)
    expect(await countOwnIds(`n3ts-${tag}-`)).toBe(0)
    const ref = (id: string) => adminDb().collection("ai_reservations").doc(id)
    const quarantined = (firmId: string, leaseUntil: Timestamp | string) => ({ firmId, state: "reconcile_failed", leaseUntil, reservedMicroUsd: 1, monthKey: "1970-01", createdAt: Timestamp.fromMillis(T) })
    await writeAll([
      ...Array.from({ length: 50 }, (_, i) => [ref(`n3ts-${tag}-${String(i).padStart(4, "0")}`), quarantined(firmTs, Timestamp.fromMillis(T + i))] as [DocumentReference, DocumentData]),
      ...Array.from({ length: 50 }, (_, i) => [ref(`n3head-${tag}-${String(i).padStart(4, "0")}`), quarantined(firmHead, `s-${String(i).padStart(4, "0")}`)] as [DocumentReference, DocumentData]),
      [ref(`n3tail-${tag}-0000`), quarantined(firmTail, "s-0050")],
      ...heldFirms.map((firmId, i) => [ref(`n3held-${tag}-${String(i).padStart(2, "0")}`), { firmId, state: "reserved", leaseUntil: Timestamp.fromMillis(T), reservedMicroUsd: 1, monthKey: "1970-01", createdAt: Timestamp.fromMillis(T) }] as [DocumentReference, DocumentData]),
    ])

    const { runAlertChecker } = await checker()
    const now = () => T + 60 * 60_000
    await runStoppingAfterQueries(["reservations"], now, STOP_AFTER_HELD_AND_ONE_QUARANTINE_PAGE)
    for (const firmId of heldFirms) expect(await alertOf(firmId, "ai.reservation_unresolved"), firmId).toBeDefined()
    expect(await alertOf(firmTs, "ai.reservation_unresolved")).toBeDefined()
    expect(await alertOf(firmHead, "ai.reservation_unresolved")).toBeDefined()
    expect(await alertOf(firmTail, "ai.reservation_unresolved")).toBeUndefined()
    const cursor = (await stateRef().get()).get("cursors")?.reservationsQuarantined as { at?: unknown; id?: string } | undefined
    expect(String(cursor?.id)).toContain(tag)
    expect(typeof cursor?.at).toBe("string")
    await runAlertChecker({ now, passes: ["reservations"] })
    expect(await alertOf(firmTail, "ai.reservation_unresolved")).toBeDefined()
  })

  it("FA-260-R3-001: twelve held firms are alerted while a page of number leases is saved and resumed", { timeout: E2E_TIMEOUT_MS }, async () => {
    const T = Date.parse("1970-01-10T00:00:00.000Z")
    const tag = uniq("ncol").slice(2)
    const firmNum = uniq("firm")
    const firmLate = uniq("firm")
    const heldFirms = Array.from({ length: 12 }, () => uniq("firm"))
    extraFirms.push(firmNum, firmLate, ...heldFirms)
    expect(await countOwnIds(`ncol-${tag}-`)).toBe(0)
    const ref = (id: string) => adminDb().collection("ai_reservations").doc(id)
    await writeAll([
      ...Array.from({ length: 100 }, (_, i) => [ref(`ncol-${tag}-${String(i).padStart(4, "0")}`), { firmId: firmNum, state: "reconcile_failed", leaseUntil: i + 1, reservedMicroUsd: 1, monthKey: "1970-01", createdAt: Timestamp.fromMillis(T) }] as [DocumentReference, DocumentData]),
      [ref(`ncol-late-${tag}`), { firmId: firmLate, state: "reconcile_failed", leaseUntil: Timestamp.fromMillis(T), reservedMicroUsd: 1, monthKey: "1970-01", createdAt: Timestamp.fromMillis(T) }],
      ...heldFirms.map((firmId, i) => [ref(`ncol-held-${tag}-${String(i).padStart(2, "0")}`), { firmId, state: "reserved", leaseUntil: Timestamp.fromMillis(T), reservedMicroUsd: 1, monthKey: "1970-01", createdAt: Timestamp.fromMillis(T) }] as [DocumentReference, DocumentData]),
    ])

    const { runAlertChecker } = await checker()
    const now = () => T + 60 * 60_000
    await runStoppingAfterQueries(["reservations"], now, STOP_AFTER_HELD_AND_ONE_QUARANTINE_PAGE)
    const heldAlerts = await Promise.all(heldFirms.map(async (firmId) => [firmId, await alertOf(firmId, "ai.reservation_unresolved")] as const))
    expect(heldAlerts.filter(([, alert]) => alert !== undefined)).toHaveLength(12)
    expect(await alertOf(firmNum, "ai.reservation_unresolved")).toBeDefined()
    expect(await alertOf(firmLate, "ai.reservation_unresolved")).toBeUndefined()
    const cursor = (await stateRef().get()).get("cursors")?.reservationsQuarantined as { at?: unknown; id?: string } | undefined
    expect(String(cursor?.id)).toContain(tag)
    expect(cursor?.at).toEqual((await adminDb().collection("ai_reservations").doc(cursor!.id!).get()).get("leaseUntil"))
    expect(typeof cursor?.at).toBe("number")
    await runAlertChecker({ now, passes: ["reservations"] })
    expect(await alertOf(firmLate, "ai.reservation_unresolved")).toBeDefined()
  })

  it("FA-260-R4-001: a map leaseUntil cursor replaces the stored map", { timeout: E2E_TIMEOUT_MS }, async () => {
    const T = Date.parse("1970-01-13T00:00:00.000Z")
    const tag = uniq("map").slice(2)
    const firm = uniq("firm")
    extraFirms.push(firm)
    await stateRef().set({ cursors: { reservationsQuarantined: { at: { x: 0 }, id: "" } } })
    const ref = (id: string) => adminDb().collection("ai_reservations").doc(id)
    await writeAll(Array.from({ length: 100 }, (_, i) => [ref(`map-${tag}-${String(i).padStart(4, "0")}`), { firmId: firm, state: "reconcile_failed", leaseUntil: { m: i + 1 }, reservedMicroUsd: 1, monthKey: "1970-01", createdAt: Timestamp.fromMillis(T) }] as [DocumentReference, DocumentData]))
    await runStoppingAfterQueries(["reservations"], () => T + 60 * 60_000, STOP_AFTER_HELD_AND_ONE_QUARANTINE_PAGE)
    const saved = (await stateRef().get()).get("cursors")?.reservationsQuarantined as { at?: Record<string, unknown>; id?: string } | undefined
    expect(String(saved?.id)).toContain(tag)
    expect(saved?.at).toEqual((await adminDb().collection("ai_reservations").doc(saved!.id!).get()).get("leaseUntil"))
    expect(saved?.at).not.toHaveProperty("x")
  })

  it("FA-F43-R1-003: a page that ends inside one leaseUntil keeps that id, reads the later id next, and wraps only after the tail", { timeout: E2E_TIMEOUT_MS }, async () => {
    const T = Date.parse("1970-01-16T00:00:00.000Z")
    const tag = uniq("pe").slice(2)
    const firmEdge = uniq("firm")
    const firmTail = uniq("firm")
    extraFirms.push(firmEdge, firmTail)
    const ref = (id: string) => adminDb().collection("ai_reservations").doc(id)
    const row = (firmId: string) => ({ firmId, state: "reconcile_failed", leaseUntil: Timestamp.fromMillis(T), reservedMicroUsd: 1, monthKey: "1970-01", createdAt: Timestamp.fromMillis(T) })
    const idOf = (i: number) => `pe-${tag}-${String(i).padStart(3, "0")}`
    await writeAll([
      ...Array.from({ length: 99 }, (_, i) => [ref(idOf(i)), row(firmA)] as [DocumentReference, DocumentData]),
      [ref(idOf(99)), row(firmEdge)],
      [ref(idOf(100)), row(firmTail)],
    ])

    const now = () => T + 60 * 60_000
    await runStoppingAfterQueries(["reservations"], now, STOP_AFTER_HELD_AND_ONE_QUARANTINE_PAGE)
    expect((await alertOf(firmA, "ai.reservation_unresolved"))?.detail).toMatchObject({ quarantined: 99 })
    expect((await alertOf(firmEdge, "ai.reservation_unresolved"))?.detail).toMatchObject({ quarantined: 1 })
    expect(await alertOf(firmTail, "ai.reservation_unresolved")).toBeUndefined()
    const cursor = (await stateRef().get()).get("cursors")?.reservationsQuarantined as { at?: { toMillis?: () => number }; id?: string } | undefined
    expect(cursor?.id).toBe(idOf(99))
    expect(cursor?.at?.toMillis?.()).toBe(T)

    const { runAlertChecker } = await checker()
    await runAlertChecker({ now, passes: ["reservations"] })
    expect((await alertOf(firmTail, "ai.reservation_unresolved"))?.detail).toMatchObject({ quarantined: 1 })
    // `count` is raises, not rows. The page-edge firm and the 99 ahead of it are not read again.
    expect((await alertOf(firmEdge, "ai.reservation_unresolved"))?.count).toBe(1)
    expect((await alertOf(firmA, "ai.reservation_unresolved"))?.count).toBe(1)
    expect((await alertOf(firmA, "ai.reservation_unresolved"))?.detail).toMatchObject({ quarantined: 99 })
    expect((await stateRef().get()).get("cursors")?.reservationsQuarantined ?? null).toBeNull()

    await runAlertChecker({ now, passes: ["reservations"] })
    expect((await alertOf(firmEdge, "ai.reservation_unresolved"))?.count).toBeGreaterThan(1)
    expect((await alertOf(firmA, "ai.reservation_unresolved"))?.count).toBeGreaterThan(1)
  })

  it("TEST-260-R5-002 N6: a cursor save writes updatedAt, so mergeFields lists it", { timeout: E2E_TIMEOUT_MS }, async () => {
    const T = Date.parse("1970-01-14T00:00:00.000Z")
    const tag = uniq("n6").slice(2)
    const firm = uniq("firm")
    extraFirms.push(firm)
    const old = Timestamp.fromMillis(1)
    await stateRef().set({ cursors: {}, passIndex: 0, updatedAt: old })
    const ref = (id: string) => adminDb().collection("ai_reservations").doc(id)
    await writeAll([[ref(`n6-${tag}`), { firmId: firm, state: "reconcile_failed", leaseUntil: Timestamp.fromMillis(T), reservedMicroUsd: 1, monthKey: "1970-01", createdAt: Timestamp.fromMillis(T) }] as [DocumentReference, DocumentData]])
    const { runAlertChecker } = await checker()
    await runAlertChecker({ now: () => T + 60 * 60_000, passes: ["reservations"] })
    const snap = await stateRef().get()
    expect(snap.get("passIndex") ?? 0).toBe(0)
    expect(snap.get("cursors")?.reservationsQuarantined ?? null).toBeNull()
    expect((snap.get("updatedAt") as Timestamp).toMillis()).toBeGreaterThan(old.toMillis())
  })

  it("the window is bounded: 5 pages of 100 rows per query per run", async () => {
    const m = await checker()
    expect([m.CHECK_PAGE_SIZE, m.CHECK_MAX_PAGES]).toEqual([100, 5])
  }, SEED_TIMEOUT_MS)
})
