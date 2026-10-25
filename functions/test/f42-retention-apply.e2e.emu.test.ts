import { Timestamp } from "firebase-admin/firestore"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import shippedPolicy from "@/infra/retention/policy.json"
import { adminDb } from "../src/admin"
import { alertIdFor } from "../src/alerts/model"
import { RETENTION_APPLY_SPEC } from "../src/retention/apply"
import { retentionTestSeam, type RetentionPolicy } from "../src/retention/config"
import { retentionWatchTestSeam, runRetentionWatch } from "../src/retention/watch"
import { SCHEDULED_JOBS } from "../src/p2/scheduled"
import { runJobTask } from "../src/p2/worker"
import { EMULATORS, uniq } from "./emu"
import { deleteFirmScopedData } from "./firmCleanup"
import { FakeClock, enqueueAt, testDeps } from "./jobs"

/**
 * Audit F42: retention execution (the scheduled, fenced `retention.apply` job) and the unacknowledged-deletion watch,
 * over the Firestore emulator. The shipped policy deletes nothing; a test policy deletes rows older than its period and
 * spares a matter under legal hold. The watch raises one alert per overdue request.
 */

const DAY = 86_400_000

// Every firm this file creates, deleted in afterAll so its rows do not stay in the shared emulator.
const firms: string[] = []
const firmFor = (prefix: string): string => {
  const firmId = uniq(prefix)
  firms.push(firmId)
  return firmId
}

afterAll(async () => {
  if (EMULATORS) await deleteFirmScopedData(firms)
}, 120_000)

/**
 * A test policy with a deleting period on the AI records, aged by row (FA-F42-R1-011, spec R31: the one class whose
 * every store has an ageField, so the only kind of period validation lets a policy adopt).
 */
function periodPolicy(action: "anonymise" | "purge" = "anonymise"): RetentionPolicy {
  const p = structuredClone(shippedPolicy) as unknown as RetentionPolicy
  p.policyVersion = "test-f42-period"
  p.classes.ai_record = { ...p.classes.ai_record, periodDays: 30, periodicAction: action, legalHold: false, periodBasis: "row_age" }
  return p
}

/** Where each seeded key lives. */
const COLLECTION_OF: Record<string, string> = {
  oldOutput: "committee_outputs",
  oldUsage: "ai_usage_logs",
  youngUsage: "ai_usage_logs",
  heldUsage: "ai_usage_logs",
  oldReservation: "ai_reservations",
  oldDecision: "p1_decisions",
  youngDecision: "p1_decisions",
}

async function seed(firmId: string, matterId: string, heldMatterId: string): Promise<Record<string, string>> {
  const db = adminDb()
  const now = Date.now()
  const ids: Record<string, string> = {}
  const put = async (key: string, data: Record<string, unknown>) => {
    const id = uniq(key)
    await db.collection(COLLECTION_OF[key]).doc(id).set({ firmId, ...data })
    ids[key] = id
  }
  const ago = (days: number) => Timestamp.fromMillis(now - days * DAY)
  // A matter-content row, old enough for any period: no class it belongs to may take a deleting period (R31).
  await put("oldOutput", { matterId, text: "old", createdAt: now - 40 * DAY })
  await put("oldUsage", { matterId, costMicroUsd: 7, createdAt: ago(40) })
  await put("youngUsage", { matterId, costMicroUsd: 8, createdAt: ago(2) })
  await put("heldUsage", { matterId: heldMatterId, costMicroUsd: 9, createdAt: ago(40) })
  await put("oldReservation", { matterId, costMicroUsd: 3, createdAt: ago(40) })
  // F34's decision records age with the AI records, by `settledAt`.
  await put("oldDecision", { matterId, traceId: "trace-old", settledAt: ago(40) })
  await put("youngDecision", { matterId, traceId: "trace-young", settledAt: ago(2) })
  await db.collection("legal_holds").doc(heldMatterId).set({ firmId, matterId: heldMatterId, active: true, reasonCode: "litigation_anticipated", placedBy: "p", placedAt: Timestamp.now() })
  return ids
}

async function runApply(firmId: string, period: string): Promise<string> {
  const now = Date.now()
  const { jobId } = await enqueueAt(
    { firmId, jobType: RETENTION_APPLY_SPEC.jobType, classification: "internal", matterId: null, payload: { period }, idempotencyKey: `${RETENTION_APPLY_SPEC.jobType}:${period}`, runKey: `${RETENTION_APPLY_SPEC.jobType}:${period}`, createdBy: "system" },
    now
  )
  return runJobTask({ jobId, seq: 0 }, testDeps(new FakeClock(now)))
}

const exists = async (c: string, id: string) => (await adminDb().collection(c).doc(id).get()).exists

afterEach(() => {
  delete retentionTestSeam.policy
  delete retentionTestSeam.beforeApplyChunk
  delete retentionWatchTestSeam.afterQuery
})

describe.skipIf(!EMULATORS)("F42: retention execution and the unacknowledged-deletion watch", () => {
  it("is a scheduled P2 job, daily at 01:00 PKT", () => {
    expect(SCHEDULED_JOBS).toContainEqual({ jobType: "retention.apply", cron: "0 1 * * *", period: "day" })
  })

  it("the shipped policy deletes nothing", async () => {
    const firmId = firmFor("f42ret")
    const ids = await seed(firmId, uniq("m"), uniq("held"))
    expect(await runApply(firmId, "2026-10-24")).toBe("done")
    for (const key of Object.keys(ids)) expect(await exists(COLLECTION_OF[key], ids[key]), key).toBe(true)
    const usage = (await adminDb().collection("ai_usage_logs").doc(ids.oldUsage).get()).data()
    expect(typeof usage?.matterId).toBe("string")
    const run = (await adminDb().collection("retention_runs").doc(`${firmId}_2026-10-24`).get()).data()
    expect(run).toMatchObject({ firmId, period: "2026-10-24", policyVersion: shippedPolicy.policyVersion, deleted: {}, anonymised: {} })
    // A period set but the class under legal hold: still nothing.
    const held = periodPolicy()
    held.classes.ai_record.legalHold = true
    retentionTestSeam.policy = held
    expect(await runApply(firmId, "2026-10-23")).toBe("done")
    for (const key of Object.keys(ids)) expect(await exists(COLLECTION_OF[key], ids[key]), key).toBe(true)
    expect((await adminDb().collection("retention_runs").doc(`${firmId}_2026-10-23`).get()).data()).toMatchObject({ deleted: {}, anonymised: {} })
  })

  it("a test policy anonymises rows older than the period, keeps younger rows and spares a held matter", async () => {
    retentionTestSeam.policy = periodPolicy("anonymise")
    const firmId = firmFor("f42ret")
    const matterId = uniq("m")
    const ids = await seed(firmId, matterId, uniq("held"))
    expect(await runApply(firmId, "2026-10-25")).toBe("done")
    const data = async (key: string) => (await adminDb().collection(COLLECTION_OF[key]).doc(ids[key]).get()).data()
    expect(await data("oldUsage")).toMatchObject({ matterId: null, costMicroUsd: 7 })
    expect(await data("oldReservation")).toMatchObject({ matterId: null, costMicroUsd: 3 })
    expect(await data("oldDecision")).toMatchObject({ matterId: null, traceId: "trace-old" })
    expect(await data("youngUsage")).toMatchObject({ matterId })
    expect(await data("youngDecision")).toMatchObject({ matterId })
    expect((await data("heldUsage"))?.matterId).toBeTypeOf("string")
    // The matter-content row is untouched: its class has no period.
    expect(await data("oldOutput")).toMatchObject({ matterId, text: "old" })
    const run = (await adminDb().collection("retention_runs").doc(`${firmId}_2026-10-25`).get()).data()
    expect(run).toMatchObject({ deleted: {}, anonymised: { firestore_ai_usage_logs: 1, firestore_ai_reservations: 1, firestore_p1_decisions: 1 }, skippedHeld: 1 })
    // Another firm's old rows are never touched by this firm's run.
    const other = firmFor("f42ret")
    const otherIds = await seed(other, uniq("m"), uniq("held"))
    expect(await runApply(firmId, "2026-10-26")).toBe("done")
    expect((await adminDb().collection("ai_usage_logs").doc(otherIds.oldUsage).get()).get("matterId")).toBeTypeOf("string")
  })

  it("a test policy that purges deletes rows older than the period, keeps younger rows and spares a held matter", async () => {
    retentionTestSeam.policy = periodPolicy("purge")
    const firmId = firmFor("f42ret")
    const ids = await seed(firmId, uniq("m"), uniq("held"))
    expect(await runApply(firmId, "2026-10-25")).toBe("done")
    for (const key of ["oldUsage", "oldReservation", "oldDecision"]) expect(await exists(COLLECTION_OF[key], ids[key]), key).toBe(false)
    for (const key of ["youngUsage", "youngDecision", "heldUsage", "oldOutput"]) expect(await exists(COLLECTION_OF[key], ids[key]), key).toBe(true)
    const run = (await adminDb().collection("retention_runs").doc(`${firmId}_2026-10-25`).get()).data()
    expect(run).toMatchObject({ deleted: { firestore_ai_usage_logs: 1, firestore_ai_reservations: 1, firestore_p1_decisions: 1 }, anonymised: {}, skippedHeld: 1 })
  })

  it("FA-F42-R1-011: a policy with a period it cannot apply coherently is refused for good; the run deletes nothing", async () => {
    const firmId = firmFor("f42ret")
    const ids = await seed(firmId, uniq("m"), uniq("held"))
    // A matter-content period aged from matter closure (not built, FU-8), and one aged by row on a class with stores
    // that have no ageField: each would delete some of the class's stores and not others.
    const closure = periodPolicy()
    closure.classes.matter_content = { ...closure.classes.matter_content, periodDays: 30, periodicAction: "purge", legalHold: false }
    const partial = periodPolicy()
    partial.classes.matter_content = { ...partial.classes.matter_content, periodDays: 30, periodicAction: "purge", legalHold: false, periodBasis: "row_age" }
    for (const [period, policy] of [["2026-10-21", closure], ["2026-10-22", partial]] as const) {
      retentionTestSeam.policy = policy
      const now = Date.now()
      const { jobId } = await enqueueAt(
        { firmId, jobType: RETENTION_APPLY_SPEC.jobType, classification: "internal", matterId: null, payload: { period }, idempotencyKey: `${RETENTION_APPLY_SPEC.jobType}:${period}`, runKey: `${RETENTION_APPLY_SPEC.jobType}:${period}`, createdBy: "system" },
        now
      )
      // Permanent: dead-lettered on the first attempt, not retried into the same refusal.
      expect(await runJobTask({ jobId, seq: 0 }, testDeps(new FakeClock(now)))).toBe("dead_lettered")
      const job = (await adminDb().collection("jobs").doc(jobId).get()).data()
      expect(job?.lastError?.code).toBe("retention_policy_invalid")
      expect(job?.attempts).toBe(1)
      expect((await adminDb().collection("retention_runs").doc(`${firmId}_${period}`).get()).exists).toBe(false)
    }
    for (const key of Object.keys(ids)) expect(await exists(COLLECTION_OF[key], ids[key]), key).toBe(true)
    expect((await adminDb().collection("ai_usage_logs").doc(ids.oldUsage).get()).get("matterId")).toBeTypeOf("string")
  })

  it("the watch raises one F43 durable alert per overdue in-progress request, with ids and counts only", async () => {
    const firmId = firmFor("f42watch")
    const db = adminDb()
    const now = Date.now()
    const overdue = uniq("req")
    const notDue = uniq("req")
    const done = uniq("req")
    const base = { firmId, matterId: uniq("m"), expected: ["a", "b", "c"], acked: { a: "purged" }, alertedAt: null }
    await db.collection("deletion_requests").doc(overdue).set({ ...base, status: "in_progress", ackDeadlineAt: Timestamp.fromMillis(now - 1000) })
    await db.collection("deletion_requests").doc(notDue).set({ ...base, status: "in_progress", ackDeadlineAt: Timestamp.fromMillis(now + DAY) })
    await db.collection("deletion_requests").doc(done).set({ ...base, status: "completed", ackDeadlineAt: Timestamp.fromMillis(now - 1000) })
    await runRetentionWatch(now)
    // One F43 alert (ops_alerts, open at level 0, paged once) per overdue request; its subject is the request, never the
    // matter, and its detail is counts only, so the alert record stays out of matter-deletion scope.
    const alerts = await db.collection("ops_alerts").where("firmId", "==", firmId).get()
    expect(alerts.docs.map((d) => d.id)).toEqual([alertIdFor("retention.deletion_unacknowledged", firmId, `deletionRequest:${overdue}`)])
    expect(alerts.docs[0].data()).toMatchObject({
      condition: "retention.deletion_unacknowledged",
      firmId,
      subjectKey: `deletionRequest:${overdue}`,
      ref: `deletion_requests/${overdue}`,
      severity: "high",
      state: "open",
      level: 0,
      count: 1,
      detail: { expected: 3, acked: 1, missing: 2 },
    })
    expect(JSON.stringify(alerts.docs[0].data())).not.toContain(base.matterId)
    const pages = await db.collection("ops_alert_notifications").where("alertId", "==", alerts.docs[0].id).get()
    expect(pages.size).toBe(1)
    // The request's stamp commits with the alert.
    expect((await db.collection("deletion_requests").doc(overdue).get()).get("alertedAt")).toBeInstanceOf(Timestamp)
    await runRetentionWatch(now + 60_000)
    const again = await db.collection("ops_alerts").where("firmId", "==", firmId).get()
    expect(again.size).toBe(1)
    expect(again.docs[0].get("count")).toBe(1)
  })

  it("FA-F42-R1-012 (R09): a hold placed after a page is read and before its chunk commits spares the matter's rows", async () => {
    retentionTestSeam.policy = periodPolicy("anonymise")
    const firmId = firmFor("f42ret")
    const matterId = uniq("m")
    const ids = await seed(firmId, matterId, uniq("held"))
    let placed = false
    retentionTestSeam.beforeApplyChunk = async () => {
      if (placed) return
      placed = true
      await adminDb().collection("legal_holds").doc(matterId).set({ firmId, matterId, active: true, reasonCode: "litigation_anticipated", placedBy: "p", placedAt: Timestamp.now() })
    }
    expect(await runApply(firmId, "2026-10-27")).toBe("done")
    expect(placed).toBe(true)
    // The chunk's transaction re-reads the hold: nothing of the matter is anonymised, in the first store or after it.
    for (const key of ["oldUsage", "oldReservation", "oldDecision"]) {
      expect((await adminDb().collection(COLLECTION_OF[key]).doc(ids[key]).get()).get("matterId"), key).toBe(matterId)
    }
  })

  it("FA-F42-R1-012 (R14): a run whose query read a request before another run alerted it does not alert it again", async () => {
    const firmId = firmFor("f42watchrace")
    const db = adminDb()
    const now = Date.now()
    const req = uniq("req")
    await db.collection("deletion_requests").doc(req).set({ firmId, matterId: uniq("m"), expected: ["a", "b"], acked: {}, status: "in_progress", ackDeadlineAt: Timestamp.fromMillis(now - 1000), alertedAt: null })
    const inner: { result: { scanned: number; alerted: number } | null } = { result: null }
    // Between the outer run's query and its transactions, a second run raises the alert and stamps the request.
    retentionWatchTestSeam.afterQuery = async () => {
      delete retentionWatchTestSeam.afterQuery
      inner.result = await runRetentionWatch(now)
    }
    const outer = await runRetentionWatch(now)
    expect(inner.result?.alerted).toBeGreaterThanOrEqual(1)
    expect(outer.alerted).toBe(0)
    const alert = await db.collection("ops_alerts").doc(alertIdFor("retention.deletion_unacknowledged", firmId, `deletionRequest:${req}`)).get()
    expect(alert.get("count")).toBe(1)
    expect((await db.collection("ops_alert_notifications").where("alertId", "==", alert.id).get()).size).toBe(1)
  })

  it("a request that falls overdue behind a full page of already-alerted ones is still alerted", async () => {
    const firmId = firmFor("f42watchpage")
    const db = adminDb()
    const now = Date.now()
    // 201 halted requests, overdue for years and alerted long ago: they stay in_progress (a hold halted them).
    const base = { firmId, matterId: uniq("m"), expected: ["a"], acked: {}, status: "in_progress" }
    for (let start = 0; start < 201; start += 100) {
      const batch = db.batch()
      for (let i = start; i < Math.min(start + 100, 201); i += 1) {
        batch.set(db.collection("deletion_requests").doc(uniq("old")), { ...base, ackDeadlineAt: Timestamp.fromMillis(now - 1000 * DAY + i), alertedAt: Timestamp.fromMillis(now - 900 * DAY) })
      }
      await batch.commit()
    }
    const fresh = uniq("req")
    await db.collection("deletion_requests").doc(fresh).set({ ...base, ackDeadlineAt: Timestamp.fromMillis(now - 1000), alertedAt: null })
    await runRetentionWatch(now)
    expect((await db.collection("ops_alerts").doc(alertIdFor("retention.deletion_unacknowledged", firmId, `deletionRequest:${fresh}`)).get()).exists).toBe(true)
  })
})
