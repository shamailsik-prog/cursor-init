import { FieldValue, Timestamp, type DocumentData, type DocumentReference } from "firebase-admin/firestore"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { adminDb } from "../src/admin"
import { budgetSpentAfterFirstPage } from "./checkerClock"
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
 * Firm A's backlog (520 rows) sorts before firm B's three rows. The window is 500 rows per query per run (5 pages of
 * 100). On the code before the fix every run reads the same first 500 rows, all firm A's, and firm B is never alerted.
 */

const WINDOW = 500
const BACKLOG = 520
const CLEANUP_TIMEOUT_MS = 120_000
const SEED_TIMEOUT_MS = 120_000
const E2E_TIMEOUT_MS = 120_000

const CHECKER = ["..", "src", "alerts", "checker"].join("/")
type CheckerModule = { runAlertChecker: (o: { now: () => number; passes?: string[] }) => Promise<{ raised: string[] }>; CHECK_PAGE_SIZE?: number; CHECK_MAX_PAGES?: number }
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

describe.skipIf(!EMULATORS)("PR #120 review: the checker pages through a persistent backlog across runs (e2e)", () => {
  let firmA: string
  let firmB: string

  beforeEach(async () => {
    firmA = uniq("firm")
    firmB = uniq("firm")
    await stateRef().delete()
  }, SEED_TIMEOUT_MS)

  afterEach(async () => {
    await deleteWhereFirm("jobs", [firmA, firmB])
    await deleteWhereFirm("ai_reservations", [firmA, firmB])
    await stateRef().delete()
    await deleteFirmData([firmA, firmB])
  }, CLEANUP_TIMEOUT_MS)

  it("quarantined reservations: firm B's rows behind 520 of firm A's raise firm B's alert within the bounded runs; the cursor then wraps to firm A", { timeout: E2E_TIMEOUT_MS }, async () => {
    const T = Date.parse("2001-05-01T10:00:00.000Z")
    const tag = uniq("p").slice(2)
    // The reconciler stamps `quarantinedAt` when it quarantines (FA-F43-R1-004: the query is ordered by it, then the id).
    const row = (firmId: string, quarantinedMs: number) => ({ firmId, state: "reconcile_failed", leaseUntil: Timestamp.fromMillis(T), quarantinedAt: Timestamp.fromMillis(quarantinedMs), reservedMicroUsd: 1, monthKey: "2001-05", createdAt: Timestamp.fromMillis(T) })
    const ref = (id: string) => adminDb().collection("ai_reservations").doc(id)
    // Firm A's backlog was quarantined first, firm B's three rows after it.
    await writeAll([
      ...Array.from({ length: BACKLOG }, (_, i) => [ref(`000000f43-${tag}-${String(i).padStart(4, "0")}`), row(firmA, T + i)] as [DocumentReference, DocumentData]),
      ...Array.from({ length: 3 }, (_, i) => [ref(`zzzzzzf43-${tag}-${i}`), row(firmB, T + 10_000 + i)] as [DocumentReference, DocumentData]),
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

  it("waiting jobs: firm B's jobs behind 520 of firm A's raise firm B's job.queue_age within the bounded runs; the cursor then wraps to firm A", { timeout: E2E_TIMEOUT_MS }, async () => {
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
    // Nothing older than these rows exists in the emulator (sweepOrigins(1100)), so the backlog is exactly 523 rows: 2 runs.
    expect(reached).toBe(2)
    expect((await alertOf(firmB, "job.queue_age"))?.detail).toMatchObject({ waiting: 3 })

    const before = (await alertOf(firmA, "job.queue_age"))!.count as number
    const again = await runUntil(["jobs"], (run) => at(2 + run), 2, async () => ((await alertOf(firmA, "job.queue_age"))!.count as number) > before)
    expect(again).not.toBeNull()
  })

  it("the window is bounded: 5 pages of 100 rows per query per run", async () => {
    const m = await checker()
    expect([m.CHECK_PAGE_SIZE, m.CHECK_MAX_PAGES]).toEqual([100, 5])
  }, SEED_TIMEOUT_MS)

  // FA-F43-R1-003 and R1-004 (re-audit of #120). Origins 1,900 years back: older than every other suite's rows, so
  // these rows are the first pages of their queries.

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
  const jobRef = (id: string) => adminDb().collection("jobs").doc(id)
  const cursorOf = async (q: string) => ((await stateRef().get()).get(`cursors.${q}`) as { id: string } | null | undefined)?.id ?? null
  const oldest = sweepOrigins(1900)

  it("C2: rows that share one timestamp across a page edge are all read (the cursor carries the id tiebreak)", { timeout: E2E_TIMEOUT_MS }, async () => {
    const T0 = oldest()
    const tag = uniq("c").slice(2)
    // 150 of firm A's rows and firm B's one row all due at the same instant; B's id sorts after A's.
    await writeAll([
      ...Array.from({ length: 150 }, (_, i) => [jobRef(`jc2a${tag}${String(i).padStart(3, "0")}`), job(firmA, T0)] as [DocumentReference, DocumentData]),
      [jobRef(`jc2b${tag}0`), job(firmB, T0)] as [DocumentReference, DocumentData],
    ])
    const { runAlertChecker } = await checker()
    await runAlertChecker({ now: () => T0 + 60 * 60_000, passes: ["jobs"] })
    expect((await alertOf(firmA, "job.queue_age"))?.detail).toMatchObject({ waiting: 150 })
    expect((await alertOf(firmB, "job.queue_age"))?.detail).toMatchObject({ waiting: 1 })
  })

  it("C4: a run whose budget runs out mid-scan keeps its place (the next run resumes after the last row read), and still raises what it read", { timeout: E2E_TIMEOUT_MS }, async () => {
    const T0 = oldest()
    const tag = uniq("c").slice(2)
    await writeAll([
      ...Array.from({ length: 250 }, (_, i) => [jobRef(`jc4a${tag}${String(i).padStart(3, "0")}`), job(firmA, T0 + i)] as [DocumentReference, DocumentData]),
      ...Array.from({ length: 2 }, (_, i) => [jobRef(`jc4b${tag}${i}`), job(firmB, T0 + 10_000 + i)] as [DocumentReference, DocumentData]),
    ])
    const { runAlertChecker } = await checker()
    const run = async (k: number) => {
      const budget = budgetSpentAfterFirstPage()
      try {
        await runAlertChecker({ now: () => T0 + 60 * 60_000 + k * 5 * 60_000, passes: ["jobs"], wallClock: budget.wallClock } as never)
      } finally {
        budget.restore()
      }
    }
    // Run 1 reads one page (firm A's first 100 rows), then its budget is spent: the cursor stays on the 100th row,
    // and the group it read is raised (inside the raises' grace).
    await run(1)
    expect(await cursorOf("jobsWaiting")).toBe(`jc4a${tag}099`)
    expect((await alertOf(firmA, "job.queue_age"))?.detail).toMatchObject({ waiting: 100 })
    expect(await alertOf(firmB, "job.queue_age")).toBeUndefined()
    // Runs 2 and 3 continue from there; run 3 reaches firm B (on a wrap at each budget stop it never would).
    await run(2)
    expect(await cursorOf("jobsWaiting")).toBe(`jc4a${tag}199`)
    expect(await alertOf(firmB, "job.queue_age")).toBeUndefined()
    await run(3)
    expect((await alertOf(firmB, "job.queue_age"))?.detail).toMatchObject({ waiting: 2 })
  })

  it("R1-004: quarantined reservations are read in quarantine order, so one quarantined after the cursor passed is read in the same cycle, not after the wrap", { timeout: E2E_TIMEOUT_MS }, async () => {
    const T = Date.parse("2001-06-01T10:00:00.000Z")
    const tag = uniq("q").slice(2)
    const row = (firmId: string, quarantinedMs: number) => ({ firmId, state: "reconcile_failed", leaseUntil: Timestamp.fromMillis(T), quarantinedAt: Timestamp.fromMillis(quarantinedMs), reservedMicroUsd: 1, monthKey: "2001-06", createdAt: Timestamp.fromMillis(T) })
    const ref = (id: string) => adminDb().collection("ai_reservations").doc(id)
    await writeAll(Array.from({ length: BACKLOG }, (_, i) => [ref(`000000q-${tag}-${String(i).padStart(4, "0")}`), row(firmA, T + i)] as [DocumentReference, DocumentData]))
    const at = (run: number) => T + 60 * 60_000 + run * 5 * 60_000
    const { runAlertChecker } = await checker()
    await runAlertChecker({ now: () => at(1), passes: ["reservations"] })
    expect(await cursorOf("reservationsQuarantined")).toBe(`000000q-${tag}-0499`)
    // Firm B's reservation is quarantined now: its id sorts before the cursor (a random id can), its time after.
    await ref(`000000q-${tag}-0000b`).set(row(firmB, T + 60 * 60_000))
    await runAlertChecker({ now: () => at(2), passes: ["reservations"] })
    expect((await alertOf(firmB, "ai.reservation_unresolved"))?.detail).toMatchObject({ quarantined: 1 })
  })

  it("R1-004: the starting pass rotates, so a pass the budget would starve still runs first in its turn", { timeout: E2E_TIMEOUT_MS }, async () => {
    const T0 = oldest()
    await jobRef(`jrot${uniq("r").slice(2)}`).set(job(firmA, T0))
    await adminDb().collection("merge_events").doc(`${firmA}_rot`).set({ firmId: firmA, unmerge: { status: "in_progress", startedAt: Timestamp.fromMillis(T0) } })
    await adminDb().collection("ai_reservations").doc(`000000r-${uniq("r").slice(2)}`).set({ firmId: firmA, state: "reserved", leaseUntil: Timestamp.fromMillis(T0), reservedMicroUsd: 1, monthKey: "0001-01", createdAt: Timestamp.fromMillis(T0) })
    const { runAlertChecker } = await checker()
    const conditions = async () => (await adminDb().collection("ops_alerts").where("firmId", "==", firmA).get()).docs.map((d) => d.get("condition") as string).sort()
    const seen: string[][] = []
    for (let run = 1; run <= 3; run++) {
      // Each run's budget is spent after its first page: only the run's first pass gets to read.
      const budget = budgetSpentAfterFirstPage()
      try {
        await runAlertChecker({ now: () => T0 + 2 * 60 * 60_000 + run * 5 * 60_000, wallClock: budget.wallClock } as never)
      } finally {
        budget.restore()
      }
      seen.push(await conditions())
    }
    expect(seen).toEqual([["job.queue_age"], ["job.queue_age", "saga.age"], ["ai.reservation_unresolved", "job.queue_age", "saga.age"]])
    await deleteWhereFirm("merge_events", [firmA])
  })
})
