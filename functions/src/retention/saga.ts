import { createHash } from "node:crypto"
import { Timestamp, type DocumentData, type QueryDocumentSnapshot, type Transaction } from "firebase-admin/firestore"
import vaultConfig from "@/infra/backup/document-vault.json"
import { adminDb } from "../admin"
import { REGISTRY_SCOPE, bumpRegistryVersion } from "../d1/registryVersion"
import { isSafeDocId } from "../p5/common"
import type { JobSpec } from "../p2/enqueue"
import { JobError } from "../p2/errors"
import type { JobContext, JobHandler, JobResult } from "../p2/registry"
import { type AckDetail, type AckInput, ackRefOf, requestRefOf, sha256, stageAcks } from "./acks"
import { retentionTestSeam, storeByKey, storeKey, type InventoryStore } from "./config"
import {
  DELETION_EXTERNAL_REQUESTS_COLLECTION,
  PREPARE_JOB_TYPE,
  PURGE_JOB_TYPE,
  VAULT_OBJECT_TOMBSTONES_COLLECTION,
  holdsRef,
  type Treatment,
} from "./model"

/**
 * Audit F42: the deletion saga (spec R7, R8, R9), two P2 saga job types, both firm-level (`matterId: null`, so the
 * purge of `jobs` never removes them and the worker's tombstone refusal never applies to them).
 *
 * `retention.matter.prepare` ({ requestId }): acknowledges the stores that need no purge (retained, not applicable,
 * expiry), records the trace processor's deletion request (the exported trace ids, before any usage row is
 * anonymised), then enqueues `retention.store.purge` jobs, at most `storesPerPurgeJob` stores each; the documents
 * stores and the vault share the first.
 *
 * `retention.store.purge` ({ requestId, storeKeys, part }): for each store, deletes or anonymises the matter's rows in
 * fenced chunks (writing a vault tombstone for each purged row that names an object), re-checking the legal hold in
 * each chunk's transaction; then, in one fenced step, re-queries every store (rows that landed since are purged first,
 * by failing retryably) and acknowledges them all. A job that would pass `CHUNK_STEP_BUDGET` chunks enqueues a
 * continuation for the stores it has not acknowledged.
 *
 * The treatment of each store is the request's `plan`, fixed at approval, so a policy change mid-saga changes nothing.
 * Every effect is a `runFenced` step: a crash resumes after its last committed step and never repeats one.
 */

const CHUNK = 200
/** Chunk steps per job; the rest of the 50 fenced steps are the acknowledgement and a possible halt. */
export const CHUNK_STEP_BUDGET = 45
const MAX_STORES_PER_JOB = 20
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
/** The purge job size when a request carries none (the shipped policy's `storesPerPurgeJob`). */
const DEFAULT_GROUP_SIZE = 12

const invalid = () => new JobError("invalid_payload", { permanent: true })
const errorCodes = {
  deletion_request_invalid: "The deletion request is missing, of another firm or not in progress.",
  legal_hold_active: "A legal hold is active on the matter; the deletion is halted.",
  purge_incomplete: "Rows of the matter remain in a store; the purge is retried.",
  store_unknown: "A store of the deletion plan is not in the inventory.",
} as const

type PreparePayload = { requestId: string }
type PurgePayload = { requestId: string; storeKeys: string[]; part: string }

function parsePrepare(payload: unknown): PreparePayload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw invalid()
  const { requestId, ...rest } = payload as Record<string, unknown>
  if (Object.keys(rest).length > 0 || !isSafeDocId(requestId)) throw invalid()
  return { requestId }
}

const KEY_RE = /^[A-Za-z0-9_]{1,80}$/
const PART_RE = /^[a-z0-9]{1,20}$/

function parsePurge(payload: unknown): PurgePayload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw invalid()
  const { requestId, storeKeys, part, ...rest } = payload as Record<string, unknown>
  if (Object.keys(rest).length > 0 || !isSafeDocId(requestId) || typeof part !== "string" || !PART_RE.test(part)) throw invalid()
  if (!Array.isArray(storeKeys) || storeKeys.length < 1 || storeKeys.length > MAX_STORES_PER_JOB || !storeKeys.every((k) => typeof k === "string" && KEY_RE.test(k))) {
    throw invalid()
  }
  return { requestId, storeKeys: [...(storeKeys as string[])], part }
}

type Request = {
  firmId: string
  matterId: string
  status: string
  plan: Record<string, Treatment>
  approvedAt: Timestamp
  expected: string[]
  acked: Record<string, string>
  groupSize?: number
}

/** The request this job serves: of the job's firm and approved. A finished request returns null (nothing to do). */
async function loadRequest(firmId: string, requestId: string): Promise<Request | null> {
  const data = (await requestRefOf(requestId).get()).data()
  if (!data || data.firmId !== firmId || typeof data.matterId !== "string" || !(data.approvedAt instanceof Timestamp)) {
    throw new JobError("deletion_request_invalid", { permanent: true })
  }
  if (data.status === "completed") return null
  if (data.status !== "in_progress" || typeof data.plan !== "object" || data.plan === null) throw new JobError("deletion_request_invalid", { permanent: true })
  return data as Request
}

function plannedStore(key: string): InventoryStore {
  const store = storeByKey(key)
  if (!store) throw new JobError("store_unknown", { permanent: true })
  return store
}

const iso = (ms: number) => new Date(ms).toISOString()

/** The acknowledgement of a store that needs no purge (spec R8). */
function staticAck(key: string, store: InventoryStore, treatment: Treatment, approvedAtMs: number): AckInput | null {
  const base = { key, storeId: store.id, count: null, idsSha256: null }
  switch (treatment) {
    case "retained":
      return { ...base, outcome: "retained", detail: { reason: "policy_retain" } }
    case "not_applicable":
      return { ...base, outcome: "not_applicable", detail: { reason: "no_matter_key" } }
    case "expiry": {
      const k = store.key
      const windowMs = k.kind === "backup" ? k.windowDays * DAY_MS : k.kind === "ttl" ? k.windowHours * HOUR_MS : 0
      const detail: AckDetail = { windowEndsAt: iso(approvedAtMs + windowMs), source: k.kind === "backup" ? k.config : k.kind === "ttl" ? "firestore_ttl" : "none" }
      return { ...base, outcome: "expiry", detail }
    }
    default:
      return null
  }
}

/** Runs a fenced step, then the crash seam; returns whether the step ran now (false: committed by an earlier attempt). */
async function step(ctx: JobContext<unknown>, stepId: string, fn: (tx: Transaction) => Promise<void>): Promise<boolean> {
  const ran = await ctx.runFenced(stepId, async (tx) => {
    await fn(tx)
    return true
  })
  if (process.env.NODE_ENV !== "production") await retentionTestSeam.afterStep?.(stepId)
  return ran === true
}

const nowMs = (ctx: JobContext<unknown>) => ctx.now()

/** The enqueue module, loaded on first use: it imports the registry, which imports this module (as auto-confirm does). */
const enqueue = () => import("../p2/enqueue")

// ---------------------------------------------------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------------------------------------------------

async function exportedTraceIds(firmId: string, matterId: string, store: InventoryStore): Promise<string[]> {
  const k = store.key
  if (k.kind !== "traceExport") return []
  const source = storeByKey(storeKey(k.source))
  if (!source || source.key.kind !== "field") return []
  const snap = await adminDb().collection(source.name).where("firmId", "==", firmId).where(source.key.field, "==", matterId).get()
  const ids = new Set<string>()
  for (const d of snap.docs) {
    const id = d.get(k.idField)
    if (typeof id === "string" && id !== "" && d.get(k.statusField) === k.exportedValue) ids.add(id)
  }
  return [...ids].sort()
}

/** At most this many trace ids in one external request (Firestore's 1 MiB document limit); the count is always whole. */
const MAX_TRACE_IDS = 10_000

const DOCUMENT_FIRST = ["firestore:documents", "firestore:document_versions", "objects:documents"]

/** The purge jobs' store groups: the documents stores and the vault first, then the rest in plan order. */
export function purgeGroups(plan: Record<string, Treatment>, order: readonly string[], perJob: number): string[][] {
  const size = Math.max(1, Math.min(perJob, MAX_STORES_PER_JOB))
  const purge = order.filter((k) => ["purge", "anonymise", "lock"].includes(plan[k]))
  const first = DOCUMENT_FIRST.map(storeKey).filter((k) => purge.includes(k))
  const rest = purge.filter((k) => !first.includes(k))
  const groups: string[][] = []
  if (first.length > 0) groups.push(first)
  for (let i = 0; i < rest.length; i += size) groups.push(rest.slice(i, i + size))
  return groups
}

async function runPrepare(ctx: JobContext<PreparePayload>): Promise<JobResult> {
  const { firmId, id: jobId } = ctx.job
  const { requestId } = ctx.payload
  const req = await loadRequest(firmId, requestId)
  if (!req) return {}
  const approvedAtMs = req.approvedAt.toMillis()
  const statics: AckInput[] = []
  for (const key of req.expected) {
    const treatment = req.plan[key]
    if (!["retained", "not_applicable", "expiry"].includes(treatment)) continue
    const ack = staticAck(key, plannedStore(key), treatment, approvedAtMs)
    if (ack) statics.push(ack)
  }
  // One transaction can hold 500 writes: acknowledge in slices of 200 (each slice its own step).
  for (let i = 0; i < statics.length; i += 200) {
    const slice = statics.slice(i, i + 200)
    await step(ctx as JobContext<unknown>, `static-${i / 200}`, async (tx) => {
      await stageAcks(tx, requestId, slice, { jobId, nowMs: nowMs(ctx as JobContext<unknown>) })
    })
  }

  for (const key of req.expected.filter((k) => req.plan[k] === "external")) {
    const store = plannedStore(key)
    const ids = await exportedTraceIds(firmId, req.matterId, store)
    await step(ctx as JobContext<unknown>, `external-${sha256([key]).slice(0, 16)}`, async (tx) => {
      await stageAcks(tx, requestId, [{
        key,
        storeId: store.id,
        outcome: ids.length > 0 ? "external_requested" : "not_applicable",
        count: ids.length,
        idsSha256: ids.length > 0 ? sha256(ids) : null,
        detail: { processor: store.name, reason: ids.length > 0 ? "pending_operator" : "nothing_exported" },
      }], { jobId, nowMs: nowMs(ctx as JobContext<unknown>) })
      if (ids.length > 0) {
        tx.set(adminDb().collection(DELETION_EXTERNAL_REQUESTS_COLLECTION).doc(`${requestId}_${store.name}`), {
          firmId,
          requestId,
          matterId: req.matterId,
          processor: store.name,
          traceIds: ids.slice(0, MAX_TRACE_IDS),
          count: ids.length,
          truncated: ids.length > MAX_TRACE_IDS,
          status: "pending_operator",
          at: Timestamp.fromMillis(nowMs(ctx as JobContext<unknown>)),
        })
      }
    })
  }

  const groups = purgeGroups(req.plan, req.expected, typeof req.groupSize === "number" ? req.groupSize : DEFAULT_GROUP_SIZE)
  if (groups.length > 0) {
    await step(ctx as JobContext<unknown>, "enqueue", async (tx) => {
      const specs: JobSpec[] = groups.map((storeKeys, i) => ({
        firmId,
        jobType: PURGE_JOB_TYPE,
        classification: ctx.job.classification,
        matterId: null,
        payload: { requestId, storeKeys, part: `g${i}` },
        idempotencyKey: `${requestId}:purge:g${i}`,
        createdBy: "system",
      }))
      await (await enqueue()).enqueueJobs(tx, specs, { now: nowMs(ctx as JobContext<unknown>) })
    })
  }
  return {}
}

// ---------------------------------------------------------------------------------------------------------------------
// purge
// ---------------------------------------------------------------------------------------------------------------------

/** The Firestore query for the matter's rows of a store (firm first, then the store's key). */
function rowsQuery(store: InventoryStore, firmId: string, matterId: string) {
  const col = adminDb().collection(store.name)
  if (store.key.kind === "field") return col.where("firmId", "==", firmId).where(store.key.field, "==", matterId)
  return null
}

/** Whether a row already carries the store's anonymised values (an anonymised row is done, never re-written). */
const isAnonymised = (store: InventoryStore, data: DocumentData | undefined): boolean =>
  data !== undefined && Object.entries(store.anonymise ?? {}).every(([field, value]) => data[field] === value)

/** Whether a stored row of the matter still needs the treatment (exists in the firm, and is not yet anonymised). */
const pending = (store: InventoryStore, treatment: Treatment, data: DocumentData | undefined, firmId: string): boolean =>
  data !== undefined && data.firmId === firmId && (treatment !== "anonymise" || !isAnonymised(store, data))

/**
 * The matter's rows of a store that still need the treatment, up to `limit`. A field-keyed store's anonymisation nulls
 * the key field (config validation), so anonymised rows leave the query; a document-keyed row is checked directly.
 */
async function matterRows(store: InventoryStore, treatment: Treatment, firmId: string, matterId: string, limit: number): Promise<QueryDocumentSnapshot[]> {
  if (store.key.kind === "docId") {
    const snap = await adminDb().collection(store.name).doc(matterId).get()
    return pending(store, treatment, snap.data(), firmId) ? [snap as QueryDocumentSnapshot] : []
  }
  const q = rowsQuery(store, firmId, matterId)
  return q ? (await q.limit(limit).get()).docs : []
}

/** A hold read in `tx` (a read: call before the transaction's writes). */
async function assertNoHold(tx: Transaction, firmId: string, matterId: string): Promise<void> {
  const hold = (await tx.get(holdsRef().doc(matterId))).data()
  if (hold && hold.firmId === firmId && hold.active === true) throw new JobError("legal_hold_active", { permanent: true })
}

const vaultKey = storeKey("objects:documents")
const vaultTombId = (storagePath: string) => createHash("sha256").update(storagePath).digest("hex")

type Progress = { count: number; chunks: string[] }

function progressOf(data: DocumentData | undefined): Progress {
  return {
    count: typeof data?.count === "number" ? data.count : 0,
    chunks: Array.isArray(data?.chunks) ? (data.chunks as string[]) : [],
  }
}

/** One chunk of a store: delete or anonymise the rows (re-read in the transaction), count them on the store's progress. */
async function purgeChunk(
  ctx: JobContext<PurgePayload>,
  req: Request,
  store: InventoryStore,
  key: string,
  rows: QueryDocumentSnapshot[],
  stepId: string
): Promise<boolean> {
  const { firmId } = ctx.job
  const treatment = req.plan[key]
  const writeVault = req.plan[vaultKey] === "lock"
  const lockUntil = Timestamp.fromMillis(req.approvedAt.toMillis() + vaultConfig.objectLockDays * DAY_MS)
  const chunkHash = sha256(rows.map((r) => r.id).sort())
  return step(ctx as JobContext<unknown>, stepId, async (tx) => {
    await assertNoHold(tx, firmId, req.matterId)
    const progressRef = ackRefOf(ctx.payload.requestId, key)
    const vaultRef = ackRefOf(ctx.payload.requestId, vaultKey)
    const [progressSnap, vaultSnap, ...snaps] = await tx.getAll(progressRef, vaultRef, ...rows.map((r) => r.ref))
    const progress = progressOf(progressSnap.data())
    let n = 0
    let objects = 0
    snaps.forEach((snap) => {
      const data = snap.data()
      if (!pending(store, treatment, data, firmId)) return
      if (treatment === "anonymise") {
        tx.update(snap.ref, { ...(store.anonymise ?? {}), anonymisedBy: ctx.payload.requestId })
      } else {
        const path = data.storagePath
        if (writeVault && typeof path === "string" && path !== "") {
          tx.set(adminDb().collection(VAULT_OBJECT_TOMBSTONES_COLLECTION).doc(vaultTombId(path)), {
            firmId,
            requestId: ctx.payload.requestId,
            documentId: snap.ref.parent.id === "documents" ? snap.id : (typeof data.documentId === "string" ? data.documentId : null),
            storagePath: path,
            lockUntil,
            at: Timestamp.fromMillis(nowMs(ctx as JobContext<unknown>)),
          })
          objects += 1
        }
        tx.delete(snap.ref)
      }
      n += 1
    })
    // A write to a collection the conflict screen reads (the matter row) moves the firm's registry version with it.
    if (n > 0 && Object.hasOwn(REGISTRY_SCOPE, store.name)) bumpRegistryVersion(tx, firmId)
    const base = { firmId, requestId: ctx.payload.requestId, matterId: req.matterId, acknowledged: false }
    tx.set(progressRef, { ...base, storeId: store.id, storeKey: key, count: progress.count + n, chunks: [...progress.chunks, chunkHash] }, { merge: true })
    if (objects > 0) {
      const vault = progressOf(vaultSnap.data())
      tx.set(vaultRef, { ...base, storeId: "objects:documents", storeKey: vaultKey, count: vault.count + objects, chunks: vault.chunks, lockUntil }, { merge: true })
    }
  })
}

async function runPurge(ctx: JobContext<PurgePayload>): Promise<JobResult> {
  const { firmId, id: jobId } = ctx.job
  const { requestId, storeKeys, part } = ctx.payload
  const req = await loadRequest(firmId, requestId)
  if (!req) return {}
  const stores = storeKeys.map((key) => ({ key, store: plannedStore(key) }))
  let chunks = 0
  try {
    for (let i = 0; i < stores.length; i += 1) {
      const { key, store } = stores[i]
      if (req.plan[key] !== "purge" && req.plan[key] !== "anonymise") continue
      // An acknowledged store is purged again if rows reappeared (its first acknowledgement stands).
      for (let round = 0; ; round += 1) {
        const rows = await matterRows(store, req.plan[key], firmId, req.matterId, CHUNK)
        if (rows.length === 0) break
        if (chunks >= CHUNK_STEP_BUDGET) return await continueWith(ctx, req, stores.slice(i).map((s) => s.key), part)
        const ids = rows.map((r) => r.id).sort()
        // A step id from the chunk's own ids; `round` keeps it new if the same ids come back (re-written since).
        const stepId = `chunk-${i}-${sha256(ids).slice(0, 24)}-${round}`
        await purgeChunk(ctx, req, store, key, rows, stepId)
        chunks += 1
      }
    }
    await acknowledge(ctx, req, stores, jobId)
  } catch (err) {
    if (err instanceof JobError && err.code === "legal_hold_active") {
      await step(ctx as JobContext<unknown>, `halt-${ctx.job.attempt}`, async (tx) => {
        tx.update(requestRefOf(requestId), { halted: { code: "legal_hold_active", at: Timestamp.fromMillis(nowMs(ctx as JobContext<unknown>)) } })
      })
    }
    throw err
  }
  return {}
}

/** Enqueues the rest of this job's stores as a continuation (its own fenced step, once). */
async function continueWith(ctx: JobContext<PurgePayload>, req: Request, storeKeys: string[], part: string): Promise<JobResult> {
  const next = `${part}c`.slice(0, 20)
  await step(ctx as JobContext<unknown>, "continue", async (tx) => {
    await (await enqueue()).enqueueJobs(tx, [{
      firmId: ctx.job.firmId,
      jobType: PURGE_JOB_TYPE,
      classification: ctx.job.classification,
      matterId: null,
      payload: { requestId: ctx.payload.requestId, storeKeys, part: next },
      idempotencyKey: `${ctx.payload.requestId}:purge:${next}`,
      createdBy: "system",
    }], { now: nowMs(ctx as JobContext<unknown>) })
  })
  return {}
}

/**
 * The final step: re-query every purged store in the transaction (a row written since fails the step retryably, so
 * the retry purges it), then acknowledge every store of the job, the vault last from what the chunks counted.
 */
async function acknowledge(ctx: JobContext<PurgePayload>, req: Request, stores: Array<{ key: string; store: InventoryStore }>, jobId: string): Promise<void> {
  const { firmId } = ctx.job
  const { requestId, part } = ctx.payload
  await step(ctx as JobContext<unknown>, `ack-${part}`, async (tx) => {
    await assertNoHold(tx, firmId, req.matterId)
    const acks: AckInput[] = []
    const progressRefs = stores.map((s) => ackRefOf(requestId, s.key))
    const progress = await tx.getAll(...progressRefs)
    for (const [i, { key, store }] of stores.entries()) {
      const treatment = req.plan[key]
      const p = progressOf(progress[i].data())
      if (treatment === "purge" || treatment === "anonymise") {
        const left =
          store.key.kind === "docId"
            ? pending(store, treatment, (await tx.get(adminDb().collection(store.name).doc(req.matterId))).data(), firmId)
            : !(await tx.get(rowsQuery(store, firmId, req.matterId)!.limit(1))).empty
        if (left) throw new JobError("purge_incomplete")
        acks.push({
          key,
          storeId: store.id,
          outcome: treatment === "purge" ? "purged" : "anonymised",
          count: p.count,
          idsSha256: p.count > 0 ? sha256(p.chunks) : null,
          detail: { chunks: p.chunks.length },
        })
      } else if (treatment === "lock") {
        const lockUntil = progress[i].get("lockUntil")
        acks.push({
          key,
          storeId: store.id,
          outcome: "lock_pending",
          count: p.count,
          idsSha256: null,
          detail: { lockUntilMax: lockUntil instanceof Timestamp ? lockUntil.toDate().toISOString() : null, lifecycle: "not_demonstrated" },
        })
      }
    }
    await stageAcks(tx, requestId, acks, { jobId, nowMs: nowMs(ctx as JobContext<unknown>) })
  })
}

export const retentionPrepareHandler: JobHandler<PreparePayload> = {
  jobType: PREPARE_JOB_TYPE,
  saga: true,
  errorCodes,
  parse: parsePrepare,
  run: runPrepare,
}

export const retentionPurgeHandler: JobHandler<PurgePayload> = {
  jobType: PURGE_JOB_TYPE,
  saga: true,
  errorCodes,
  parse: parsePurge,
  run: runPurge,
}

/** Exposed for the unit tests. */
export const sagaInternals = { staticAck, parsePurge, parsePrepare }
