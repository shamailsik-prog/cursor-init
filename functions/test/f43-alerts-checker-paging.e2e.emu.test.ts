import { FieldValue, Timestamp, type DocumentData, type DocumentReference } from "firebase-admin/firestore"
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
    const row = (firmId: string) => ({ firmId, state: "reconcile_failed", leaseUntil: Timestamp.fromMillis(T), reservedMicroUsd: 1, monthKey: "2001-05", createdAt: Timestamp.fromMillis(T) })
    const ref = (id: string) => adminDb().collection("ai_reservations").doc(id)
    // Ids order the quarantined query: firm A's backlog first ("000000…"), firm B's after every other id ("zzzzzz…").
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
})
