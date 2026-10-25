import { Timestamp } from "firebase-admin/firestore"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import shippedPolicy from "@/infra/retention/policy.json"
import { adminDb } from "../src/admin"
import { alertIdFor } from "../src/alerts/model"
import { RETENTION_APPLY_SPEC } from "../src/retention/apply"
import { retentionTestSeam, type RetentionPolicy } from "../src/retention/config"
import { runRetentionWatch } from "../src/retention/watch"
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

function periodPolicy(): RetentionPolicy {
  const p = structuredClone(shippedPolicy) as unknown as RetentionPolicy
  p.policyVersion = "test-f42-period"
  p.classes.matter_content = { ...p.classes.matter_content, periodDays: 30, periodicAction: "purge", legalHold: false }
  p.classes.ai_record = { ...p.classes.ai_record, periodDays: 30, periodicAction: "anonymise", legalHold: false }
  return p
}

async function seed(firmId: string, matterId: string, heldMatterId: string): Promise<Record<string, string>> {
  const db = adminDb()
  const now = Date.now()
  const ids: Record<string, string> = {}
  const put = async (key: string, collection: string, data: Record<string, unknown>) => {
    const id = uniq(key)
    await db.collection(collection).doc(id).set({ firmId, ...data })
    ids[key] = id
  }
  await put("oldOutput", "committee_outputs", { matterId, text: "old", createdAt: now - 40 * DAY })
  await put("youngOutput", "committee_outputs", { matterId, text: "young", createdAt: now - 5 * DAY })
  await put("heldOutput", "committee_outputs", { matterId: heldMatterId, text: "held", createdAt: now - 40 * DAY })
  await put("oldUsage", "ai_usage_logs", { matterId, costMicroUsd: 7, createdAt: Timestamp.fromMillis(now - 40 * DAY) })
  await put("youngUsage", "ai_usage_logs", { matterId, costMicroUsd: 8, createdAt: Timestamp.fromMillis(now - 2 * DAY) })
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
})

describe.skipIf(!EMULATORS)("F42: retention execution and the unacknowledged-deletion watch", () => {
  it("is a scheduled P2 job, daily at 01:00 PKT", () => {
    expect(SCHEDULED_JOBS).toContainEqual({ jobType: "retention.apply", cron: "0 1 * * *", period: "day" })
  })

  it("the shipped policy deletes nothing", async () => {
    const firmId = firmFor("f42ret")
    const ids = await seed(firmId, uniq("m"), uniq("held"))
    expect(await runApply(firmId, "2026-10-24")).toBe("done")
    for (const key of Object.keys(ids)) expect(await exists(key.includes("Output") ? "committee_outputs" : "ai_usage_logs", ids[key]), key).toBe(true)
    const usage = (await adminDb().collection("ai_usage_logs").doc(ids.oldUsage).get()).data()
    expect(typeof usage?.matterId).toBe("string")
    const run = (await adminDb().collection("retention_runs").doc(`${firmId}_2026-10-24`).get()).data()
    expect(run).toMatchObject({ firmId, period: "2026-10-24", policyVersion: shippedPolicy.policyVersion, deleted: {}, anonymised: {} })
    // Periods set but the classes under legal hold (the shipped default for matter content): still nothing.
    const held = periodPolicy()
    held.classes.matter_content.legalHold = true
    held.classes.ai_record.legalHold = true
    retentionTestSeam.policy = held
    expect(await runApply(firmId, "2026-10-23")).toBe("done")
    for (const key of Object.keys(ids)) expect(await exists(key.includes("Output") ? "committee_outputs" : "ai_usage_logs", ids[key]), key).toBe(true)
    expect((await adminDb().collection("retention_runs").doc(`${firmId}_2026-10-23`).get()).data()).toMatchObject({ deleted: {}, anonymised: {} })
  })

  it("a test policy deletes and anonymises rows older than the period, keeps younger rows and spares a held matter", async () => {
    retentionTestSeam.policy = periodPolicy()
    const firmId = firmFor("f42ret")
    const matterId = uniq("m")
    const ids = await seed(firmId, matterId, uniq("held"))
    // F34's decision records age with the AI records, by `settledAt`.
    const oldDecision = uniq("oldDecision")
    const youngDecision = uniq("youngDecision")
    await adminDb().collection("p1_decisions").doc(oldDecision).set({ firmId, matterId, traceId: "trace-old", settledAt: Timestamp.fromMillis(Date.now() - 40 * DAY) })
    await adminDb().collection("p1_decisions").doc(youngDecision).set({ firmId, matterId, traceId: "trace-young", settledAt: Timestamp.fromMillis(Date.now() - 2 * DAY) })
    expect(await runApply(firmId, "2026-10-25")).toBe("done")
    expect(await exists("committee_outputs", ids.oldOutput)).toBe(false)
    expect(await exists("committee_outputs", ids.youngOutput)).toBe(true)
    expect(await exists("committee_outputs", ids.heldOutput)).toBe(true)
    expect((await adminDb().collection("ai_usage_logs").doc(ids.oldUsage).get()).data()).toMatchObject({ matterId: null, costMicroUsd: 7 })
    expect((await adminDb().collection("ai_usage_logs").doc(ids.youngUsage).get()).data()).toMatchObject({ matterId })
    expect((await adminDb().collection("p1_decisions").doc(oldDecision).get()).data()).toMatchObject({ matterId: null, traceId: "trace-old" })
    expect((await adminDb().collection("p1_decisions").doc(youngDecision).get()).data()).toMatchObject({ matterId })
    const run = (await adminDb().collection("retention_runs").doc(`${firmId}_2026-10-25`).get()).data()
    expect(run).toMatchObject({ deleted: { firestore_committee_outputs: 1 }, anonymised: { firestore_ai_usage_logs: 1, firestore_p1_decisions: 1 }, skippedHeld: 1 })
    // Another firm's old rows are never touched by this firm's run.
    const other = firmFor("f42ret")
    const otherIds = await seed(other, uniq("m"), uniq("held"))
    expect(await runApply(firmId, "2026-10-26")).toBe("done")
    expect(await exists("committee_outputs", otherIds.oldOutput)).toBe(true)
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
