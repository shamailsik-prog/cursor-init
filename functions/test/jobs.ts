import type { DocumentData, Timestamp } from "firebase-admin/firestore"
import { adminDb } from "../src/admin"
import type { DiagnosticPayload } from "../src/p2/diagnostic"
import { enqueueJob, jobsRef, type EnqueueResult, type JobRow, type JobSpec } from "../src/p2/enqueue"
import { uniq } from "./emu"

/** Shared helpers for the P2 job-engine emulator suites (spec §7). */

/** The suites' fixed clock origin. */
export const T0 = Date.parse("2026-10-08T09:00:00Z")

/** A `platform.diagnostic` spec: a fresh key, label internal, firm-level, created by the system. */
export function diagSpec(firmId: string, payload: DiagnosticPayload, over: Partial<JobSpec> = {}): JobSpec {
  return {
    firmId,
    jobType: "platform.diagnostic",
    classification: "internal",
    matterId: null,
    payload: { ...payload },
    idempotencyKey: uniq("k"),
    createdBy: "system",
    ...over,
  }
}

/** Enqueues one spec in its own transaction at `now`. */
export function enqueueAt(spec: JobSpec, now: number): Promise<EnqueueResult> {
  return adminDb().runTransaction((tx) => enqueueJob(tx, spec, { now }))
}

/** The job row with its document updateTime (to prove a reuse wrote nothing). */
export async function readJob(jobId: string): Promise<JobRow & { updateTime: Timestamp }> {
  const snap = await jobsRef().doc(jobId).get()
  if (!snap.exists) throw new Error(`no job ${jobId}`)
  return { ...(snap.data() as JobRow), updateTime: snap.updateTime! }
}

/** The audit_log rows whose target is the job, oldest first. */
export async function jobAuditRows(jobId: string): Promise<DocumentData[]> {
  const snap = await adminDb().collection("audit_log").where("target", "==", `jobs/${jobId}`).orderBy("occurredAt").get()
  return snap.docs.map((d) => d.data())
}

/** A fresh firm document. */
export async function newFirm(): Promise<string> {
  const firmId = uniq("firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "Jobs Firm", plan: "internal" })
  return firmId
}
