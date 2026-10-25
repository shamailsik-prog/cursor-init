import { FieldPath, Timestamp, type DocumentData, type QueryDocumentSnapshot } from "firebase-admin/firestore"
import { adminDb } from "../admin"
import { JobError } from "../p2/errors"
import type { JobContext, JobHandler, JobResult } from "../p2/registry"
import type { ScheduledJobSpec } from "../p2/scheduled"
import { sha256 } from "./acks"
import { RetentionConfigError, activePolicy, ageable, inventory, retentionClassOf, retentionTestSeam, storeKey, type InventoryStore, type RetentionPolicy } from "./config"
import { RETENTION_RUNS_COLLECTION, holdsRef } from "./model"

/**
 * Audit F42 (spec R11): retention execution. `retention.apply` is a scheduled P2 job, one run per firm per PKT day
 * (`retentionApplyTick`, 01:00 Asia/Karachi, the architecture's `autoPurgeExpired` slot). For each retention class with
 * `periodDays` and a deleting `periodicAction` (`purge` or `anonymise`) and no class-wide legal hold, and each of the
 * class's Firestore stores with an `ageField`, it deletes or anonymises the firm's rows older than the period, in
 * fenced chunks, sparing every row whose matter has an active legal hold (re-checked in the chunk's transaction). It
 * ends by writing `retention_runs/{firmId}_{period}`: counts per store, the rows spared, the policy version.
 *
 * With the shipped policy (no class has a period) it deletes nothing. Each run reads at most `MAX_PAGES` pages of a
 * store; the rest waits for the next day's run.
 *
 * FA-F42-R1-011 (spec R31): a policy that fails validation (a deleting period aged from matter closure, not built, or
 * one on a class with a store this job cannot age) fails the run permanently, `retention_policy_invalid`, before any
 * row is read: the job is dead-lettered on its first attempt and the operator sees it, instead of a run that deletes
 * part of a class.
 */

export const RETENTION_APPLY_SPEC: ScheduledJobSpec = { jobType: "retention.apply", cron: "0 1 * * *", period: "day" }

const DAY_MS = 86_400_000
const CHUNK = 200
const MAX_PAGES = 20
/** Chunk steps per run; one more is the summary. */
const CHUNK_BUDGET = 45

type Payload = { period: string }

function parse(payload: unknown): Payload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new JobError("invalid_payload", { permanent: true })
  const { period, ...rest } = payload as Record<string, unknown>
  if (Object.keys(rest).length > 0 || typeof period !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(period)) throw new JobError("invalid_payload", { permanent: true })
  return { period }
}

type Target = { store: InventoryStore; key: string; action: "purge" | "anonymise"; cutoffMs: number }

/** The stores the policy ages out, with their cutoff at `nowMs`. A class under legal hold ages nothing out. */
export function retentionTargets(policy: RetentionPolicy, nowMs: number): Target[] {
  const out: Target[] = []
  for (const store of inventory().stores) {
    if (!ageable(store)) continue
    const cls = policy.classes[retentionClassOf(store)]
    if (!cls || cls.legalHold || cls.periodDays === null || cls.periodicAction === "retain") continue
    out.push({ store, key: storeKey(store.id), action: cls.periodicAction, cutoffMs: nowMs - cls.periodDays * DAY_MS })
  }
  return out
}

const matterOf = (t: Target, data: DocumentData, id: string): string | null => {
  if (t.store.key.kind === "docId") return id
  const v = t.store.key.kind === "field" ? data[t.store.key.field] : undefined
  return typeof v === "string" && v !== "" ? v : null
}

const alreadyAnonymised = (t: Target, data: DocumentData): boolean =>
  Object.entries(t.store.anonymise ?? {}).every(([field, value]) => data[field] === value)

/** The active policy; an invalid one is a permanent failure of the run (FA-F42-R1-011). */
function policyForRun(): RetentionPolicy {
  try {
    return activePolicy()
  } catch (err) {
    if (err instanceof RetentionConfigError) throw new JobError("retention_policy_invalid", { permanent: true })
    throw err
  }
}

async function run(ctx: JobContext<Payload>): Promise<JobResult> {
  const { firmId } = ctx.job
  const policy = policyForRun()
  const nowMs = ctx.now()
  const deleted: Record<string, number> = {}
  const anonymised: Record<string, number> = {}
  let skippedHeld = 0
  let chunks = 0
  for (const t of retentionTargets(policy, nowMs)) {
    const age = t.store.ageField!
    const cutoff = age.type === "timestamp" ? Timestamp.fromMillis(t.cutoffMs) : t.cutoffMs
    let after: QueryDocumentSnapshot | null = null
    for (let page = 0; page < MAX_PAGES && chunks < CHUNK_BUDGET; page += 1) {
      let q = adminDb().collection(t.store.name).where("firmId", "==", firmId).where(age.field, "<", cutoff).orderBy(age.field).orderBy(FieldPath.documentId()).limit(CHUNK)
      if (after) q = q.startAfter(after)
      const snap = await q.get()
      if (snap.empty) break
      after = snap.docs[snap.docs.length - 1]
      const candidates = snap.docs.filter((d) => t.action === "purge" || !alreadyAnonymised(t, d.data()))
      const matters = [...new Set(candidates.map((d) => matterOf(t, d.data(), d.id)).filter((m): m is string => m !== null))]
      const held = new Set<string>()
      if (matters.length > 0) {
        const holds = await adminDb().getAll(...matters.map((m) => holdsRef().doc(m)))
        holds.forEach((h, i) => {
          if (h.get("firmId") === firmId && h.get("active") === true) held.add(matters[i])
        })
      }
      const rows = candidates.filter((d) => {
        const m = matterOf(t, d.data(), d.id)
        return m === null || !held.has(m)
      })
      skippedHeld += candidates.length - rows.length
      if (rows.length > 0) {
        const ids = rows.map((d) => d.id).sort()
        if (process.env.NODE_ENV !== "production") await retentionTestSeam.beforeApplyChunk?.(t.key)
        const n = await ctx.runFenced(`apply-${t.key.slice(0, 40)}-${sha256(ids).slice(0, 24)}`, async (tx) => {
          const heldNow = matters.length > 0 ? await tx.getAll(...matters.map((m) => holdsRef().doc(m))) : []
          const heldIds = new Set(heldNow.filter((h) => h.get("firmId") === firmId && h.get("active") === true).map((h) => h.id))
          const current = await tx.getAll(...rows.map((d) => d.ref))
          let count = 0
          for (const s of current) {
            const data = s.data()
            if (!data || data.firmId !== firmId) continue
            const m = matterOf(t, data, s.id)
            if (m !== null && heldIds.has(m)) continue
            if (t.action === "purge") tx.delete(s.ref)
            else tx.update(s.ref, { ...(t.store.anonymise ?? {}), anonymisedBy: `retention.apply:${ctx.payload.period}` })
            count += 1
          }
          return count
        })
        chunks += 1
        if (process.env.NODE_ENV !== "production") await retentionTestSeam.afterStep?.(`apply-${t.key}`)
        if (typeof n === "number") {
          const bucket = t.action === "purge" ? deleted : anonymised
          bucket[t.key] = (bucket[t.key] ?? 0) + n
        }
      }
      if (snap.size < CHUNK) break
    }
  }
  await ctx.runFenced("summary", async (tx) => {
    tx.set(adminDb().collection(RETENTION_RUNS_COLLECTION).doc(`${firmId}_${ctx.payload.period}`), {
      firmId,
      period: ctx.payload.period,
      policyVersion: policy.policyVersion,
      deleted,
      anonymised,
      skippedHeld,
      jobId: ctx.job.id,
      at: Timestamp.fromMillis(nowMs),
    })
  })
  return {}
}

export const retentionApplyHandler: JobHandler<Payload> = {
  jobType: RETENTION_APPLY_SPEC.jobType,
  saga: false,
  errorCodes: {
    retention_policy_invalid: "The retention policy failed validation; no row was aged out.",
  },
  parse,
  run,
}
