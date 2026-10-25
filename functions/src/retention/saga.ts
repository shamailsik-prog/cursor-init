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
import { instructionsIn, moveInstructions } from "./instructions"
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
 * expiry), records the trace processor's deletion request (every exported trace id, in bounded parts, before any usage
 * row is anonymised), then enqueues `retention.store.purge` jobs, at most `storesPerPurgeJob` stores each; the
 * documents stores and the vault share the first.
 *
 * `retention.store.purge` ({ requestId, storeKeys, part }): for each store, deletes or anonymises the matter's rows in
 * fenced chunks (writing a vault tombstone for each purged row that names an object), re-checking the legal hold in
 * each chunk's transaction; then, in one fenced step, re-queries every store (rows that landed since are purged first,
 * by failing retryably) and acknowledges them all. A job that would pass `CHUNK_STEP_BUDGET` chunks (counting the
 * steps its earlier attempts recorded) acknowledges the stores it finished, then enqueues a continuation for the rest.
 *
 * The treatment of each store is the request's `plan`, fixed at approval, so a policy change mid-saga changes nothing.
 * Every effect is a `runFenced` step: a crash resumes after its last committed step and never repeats one.
 */

const CHUNK = 200
/**
 * Steps a purge job may record before it hands the rest to a continuation, counting every attempt's (P2 keeps them
 * all, 50 at most per job); the rest are the acknowledgements, the continuation and a possible halt.
 */
export const CHUNK_STEP_BUDGET = 45
const MAX_STORES_PER_JOB = 20
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
/** The purge job size when a request carries none (the shipped policy's `storesPerPurgeJob`). */
const DEFAULT_GROUP_SIZE = 12

const invalid = () => new JobError("invalid_payload", { permanent: true })
const errorCodes = {
  deletion_request_invalid: "The deletion request is missing, of another firm or not in progress.",
  external_ids_over_limit: "The processor's trace ids exceed one deletion request; nothing of the matter is anonymised.",
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

/**
 * The processor's copies of the matter: every id, across the store's sources, whose row is in an exported state (for
 * Opik: the usage row's call-time export, and F34's decision record, which its reconciler may still export). Read in
 * the prepare job, before any purge job anonymises the rows that hold the ids.
 */
async function exportedTraceIds(firmId: string, matterId: string, store: InventoryStore): Promise<string[]> {
  const k = store.key
  if (k.kind !== "traceExport") return []
  const ids = new Set<string>()
  for (const src of k.sources) {
    const source = storeByKey(storeKey(src.source))
    if (!source || source.key.kind !== "field") throw new JobError("store_unknown", { permanent: true })
    const snap = await adminDb().collection(source.name).where("firmId", "==", firmId).where(source.key.field, "==", matterId).get()
    for (const d of snap.docs) {
      const id = d.get(src.idField)
      if (typeof id === "string" && id !== "" && src.exportedValues.includes(d.get(src.statusField))) ids.add(id)
    }
  }
  return [...ids].sort()
}

/**
 * A processor's deletion request is a summary document `{requestId}_{processor}` and parts `{requestId}_{processor}_p{n}`,
 * each at most `TRACE_IDS_PER_PART` ids and `TRACE_PART_BYTES` bytes (far under Firestore's 1 MiB document), all
 * written in the one step that acknowledges the store: at most `MAX_TRACE_PARTS` parts (about 6 MiB, within one
 * commit's 10 MiB). One step, so a retry never re-splits ids an earlier attempt recorded. Codex P2 (PR #128): the
 * request once kept the first 10,000 ids only, and the purge then nulled the rows that held the rest.
 */
const TRACE_IDS_PER_PART = 5_000
const TRACE_PART_BYTES = 256 * 1024
const MAX_TRACE_PARTS = 24

const overLimit = () => new JobError("external_ids_over_limit", { permanent: true })

/** The ids in order, in parts within both bounds; more than `MAX_TRACE_PARTS` parts is refused, never cut short. */
function traceIdParts(ids: readonly string[]): string[][] {
  const parts: string[][] = []
  let part: string[] = []
  let bytes = 0
  for (const id of ids) {
    const size = Buffer.byteLength(id, "utf8") + 1
    if (size > TRACE_PART_BYTES) throw overLimit()
    if (part.length === TRACE_IDS_PER_PART || bytes + size > TRACE_PART_BYTES) {
      parts.push(part)
      part = []
      bytes = 0
    }
    part.push(id)
    bytes += size
  }
  if (part.length > 0) parts.push(part)
  if (parts.length > MAX_TRACE_PARTS) throw overLimit()
  return parts
}

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
  const { firmId } = ctx.job
  const { requestId } = ctx.payload
  const req = await loadRequest(firmId, requestId)
  if (!req) return {}
  try {
    await prepareSteps(ctx, req)
  } catch (err) {
    if (err instanceof JobError && err.code === "legal_hold_active") await halt(ctx, req)
    throw err
  }
  return {}
}

/**
 * The prepare job's steps. FA-F42-R1-004 (spec R24): each one re-reads the matter's hold in its own transaction, as the
 * purge job's do, so a hold placed between the approval and prepare stops the processor instruction and the enqueue
 * too, not only the purge.
 */
async function prepareSteps(ctx: JobContext<PreparePayload>, req: Request): Promise<void> {
  const { firmId, id: jobId } = ctx.job
  const { requestId } = ctx.payload
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
      await assertNoHold(tx, firmId, req.matterId)
      await stageAcks(tx, requestId, slice, { jobId, nowMs: nowMs(ctx as JobContext<unknown>) })
    })
  }

  // Every id is recorded here, before the enqueue step below creates the first purge job (the only anonymiser).
  for (const key of req.expected.filter((k) => req.plan[k] === "external")) {
    const store = plannedStore(key)
    const ids = await exportedTraceIds(firmId, req.matterId, store)
    await step(ctx as JobContext<unknown>, `external-${sha256([key]).slice(0, 16)}`, async (tx) => {
      await assertNoHold(tx, firmId, req.matterId)
      const parts = traceIdParts(ids)
      await stageAcks(tx, requestId, [{
        key,
        storeId: store.id,
        outcome: ids.length > 0 ? "external_requested" : "not_applicable",
        count: ids.length,
        idsSha256: ids.length > 0 ? sha256(ids) : null,
        detail: { processor: store.name, reason: ids.length > 0 ? "pending_operator" : "nothing_exported", parts: parts.length },
      }], { jobId, nowMs: nowMs(ctx as JobContext<unknown>) })
      if (ids.length === 0) return
      const col = adminDb().collection(DELETION_EXTERNAL_REQUESTS_COLLECTION)
      const base = { firmId, requestId, matterId: req.matterId, processor: store.name, at: Timestamp.fromMillis(nowMs(ctx as JobContext<unknown>)) }
      parts.forEach((traceIds, n) => tx.set(col.doc(`${requestId}_${store.name}_p${n}`), { ...base, part: n, of: parts.length, traceIds }))
      tx.set(col.doc(`${requestId}_${store.name}`), { ...base, count: ids.length, parts: parts.length, idsSha256: sha256(ids), status: "pending_operator" })
    })
  }

  const groups = purgeGroups(req.plan, req.expected, typeof req.groupSize === "number" ? req.groupSize : DEFAULT_GROUP_SIZE)
  if (groups.length > 0) {
    await step(ctx as JobContext<unknown>, "enqueue", async (tx) => {
      await assertNoHold(tx, firmId, req.matterId)
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
}

/**
 * A hold halted the saga (spec R9, R24): in one step, the request records `halted`, and every processor instruction of
 * the matter still `pending_operator` moves to `held`, so the operator never acts on one while the hold stands. The
 * release moves them back and clears `halted`; a partner then retries the dead-lettered job (P3-12).
 */
async function halt(ctx: JobContext<unknown>, req: Request): Promise<void> {
  const { firmId } = ctx.job
  const { requestId } = ctx.payload as { requestId: string }
  await step(ctx, `halt-${ctx.job.attempt}`, async (tx) => {
    const pending = await instructionsIn(tx, firmId, req.matterId, "pending_operator")
    const at = Timestamp.fromMillis(nowMs(ctx))
    tx.update(requestRefOf(requestId), { halted: { code: "legal_hold_active", at } })
    moveInstructions(tx, pending, "held", at)
  })
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
const pending = (store: InventoryStore, treatment: Treatment, data: DocumentData | undefined, firmId: string): data is DocumentData =>
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

/** The vault's own object key (platform/documents/documentObjectStore.ts buildDocumentStoragePath): scheme, firm, document, version. */
const VAULT_PATH = /^(?:fs|s3):\/\/([A-Za-z0-9_-]{1,128})\/documents\/([A-Za-z0-9_-]{1,128})\/v[1-9][0-9]{0,8}$/
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

/** The document a purged row's object belongs to: the row's own id for `documents`, else its `documentId` (id-shaped only). */
function documentIdOf(snap: { id: string; ref: { parent: { id: string } } }, data: DocumentData): string | null {
  const id: unknown = snap.ref.parent.id === "documents" ? snap.id : data.documentId
  return typeof id === "string" && SAFE_ID.test(id) ? id : null
}

/**
 * The storage path a vault tombstone may keep (spec R25, FA-F42-R1-005): only the vault's own shape for this row, with
 * the row's firm and document. Anything else (a legacy path carrying a title, another firm's, a version suffix with
 * text) is not copied into the permanent trail; the tombstone keeps its SHA-256 instead (its document id).
 */
export function vaultPathOf(path: string, firmId: string, documentId: string | null): string | null {
  const m = VAULT_PATH.exec(path)
  return m !== null && documentId !== null && m[1] === firmId && m[2] === documentId ? path : null
}

type Progress = { count: number; chunks: string[]; refusedPaths: number }

function progressOf(data: DocumentData | undefined): Progress {
  return {
    count: typeof data?.count === "number" ? data.count : 0,
    chunks: Array.isArray(data?.chunks) ? (data.chunks as string[]) : [],
    refusedPaths: typeof data?.refusedPaths === "number" ? data.refusedPaths : 0,
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
    let refused = 0
    snaps.forEach((snap) => {
      const data = snap.data()
      if (!pending(store, treatment, data, firmId)) return
      if (treatment === "anonymise") {
        tx.update(snap.ref, { ...(store.anonymise ?? {}), anonymisedBy: ctx.payload.requestId })
      } else {
        const path = data.storagePath
        if (writeVault && typeof path === "string" && path !== "") {
          const documentId = documentIdOf(snap, data)
          const kept = vaultPathOf(path, firmId, documentId)
          const tombId = vaultTombId(path)
          tx.set(adminDb().collection(VAULT_OBJECT_TOMBSTONES_COLLECTION).doc(tombId), {
            firmId,
            requestId: ctx.payload.requestId,
            documentId,
            storagePath: kept,
            ...(kept === null ? { storagePathSha256: tombId, pathShape: "refused" } : {}),
            lockUntil,
            at: Timestamp.fromMillis(nowMs(ctx as JobContext<unknown>)),
          })
          objects += 1
          if (kept === null) refused += 1
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
      tx.set(vaultRef, { ...base, storeId: "objects:documents", storeKey: vaultKey, count: vault.count + objects, chunks: vault.chunks, refusedPaths: vault.refusedPaths + refused, lockUntil }, { merge: true })
    }
  })
}

async function runPurge(ctx: JobContext<PurgePayload>): Promise<JobResult> {
  const { firmId, id: jobId } = ctx.job
  const { requestId, storeKeys, part } = ctx.payload
  const req = await loadRequest(firmId, requestId)
  if (!req) return {}
  const stores = storeKeys.map((key) => ({ key, store: plannedStore(key) }))
  // Counted from the steps earlier attempts recorded: a retry after a crash hands over sooner, never passing P2's limit
  // (the permanent `fenced_step_limit` would leave the request unfinished).
  let chunks = await recordedSteps(jobId)
  try {
    for (let i = 0; i < stores.length; i += 1) {
      const { key, store } = stores[i]
      if (req.plan[key] !== "purge" && req.plan[key] !== "anonymise") continue
      // An acknowledged store is purged again if rows reappeared (its first acknowledgement stands).
      for (let round = 0; ; round += 1) {
        const rows = await matterRows(store, req.plan[key], firmId, req.matterId, CHUNK)
        if (rows.length === 0) break
        if (chunks >= CHUNK_STEP_BUDGET) return await continueWith(ctx, req, stores, i, jobId)
        const ids = rows.map((r) => r.id).sort()
        // A step id from the chunk's own ids; `round` keeps it new if the same ids come back (re-written since).
        const stepId = `chunk-${i}-${sha256(ids).slice(0, 24)}-${round}`
        await purgeChunk(ctx, req, store, key, rows, stepId)
        chunks += 1
      }
    }
    await acknowledge(ctx, req, stores, jobId, `ack-${part}`)
  } catch (err) {
    if (err instanceof JobError && err.code === "legal_hold_active") await halt(ctx as JobContext<unknown>, req)
    throw err
  }
  return {}
}

/** The distinct step ids the job has recorded, every attempt's (the worker's `fencedSteps`). */
async function recordedSteps(jobId: string): Promise<number> {
  const steps = (await (await enqueue()).jobsRef().doc(jobId).get()).get("fencedSteps")
  return steps !== null && typeof steps === "object" ? Object.keys(steps).length : 0
}

/** A continuation's part: `g0` → `g0c1` → `g0c2`, a counter (so every continuation is a new job), within `PART_RE`. */
function nextPart(part: string): string {
  const m = /^(.*c)(\d+)$/.exec(part)
  return m ? `${m[1]}${Number(m[2]) + 1}` : `${part}c1`
}

/**
 * The job passed its chunk budget at store `i`. The purge and anonymise stores before `i` are finished (no rows left):
 * acknowledge them now, in a step of their own, then enqueue a continuation for the rest: store `i` on, and the vault
 * lock (its count grows with every document the rest purges). Codex P2 (PR #128): the finished stores were once left
 * to no job, so the request stayed in progress for good. The step id names `i`: a retry that passes the budget at a
 * later store acknowledges the stores between too (an acknowledgement already made stands).
 */
async function continueWith(
  ctx: JobContext<PurgePayload>,
  req: Request,
  stores: Array<{ key: string; store: InventoryStore }>,
  i: number,
  jobId: string
): Promise<JobResult> {
  const purged = (key: string) => req.plan[key] === "purge" || req.plan[key] === "anonymise"
  const finished = stores.slice(0, i).filter((s) => purged(s.key))
  const rest = stores.filter((s, j) => j >= i || !purged(s.key)).map((s) => s.key)
  if (finished.length > 0) await acknowledge(ctx, req, finished, jobId, `ack-${ctx.payload.part}-p${i}`)
  const next = nextPart(ctx.payload.part)
  await step(ctx as JobContext<unknown>, "continue", async (tx) => {
    await (await enqueue()).enqueueJobs(tx, [{
      firmId: ctx.job.firmId,
      jobType: PURGE_JOB_TYPE,
      classification: ctx.job.classification,
      matterId: null,
      payload: { requestId: ctx.payload.requestId, storeKeys: rest, part: next },
      idempotencyKey: `${ctx.payload.requestId}:purge:${next}`,
      createdBy: "system",
    }], { now: nowMs(ctx as JobContext<unknown>) })
  })
  return {}
}

/**
 * The acknowledgement step `stepId`: re-query every purged store in the transaction (a row written since fails the step
 * retryably, so the retry purges it), then acknowledge every store given, the vault last from what the chunks counted.
 */
async function acknowledge(
  ctx: JobContext<PurgePayload>,
  req: Request,
  stores: Array<{ key: string; store: InventoryStore }>,
  jobId: string,
  stepId: string
): Promise<void> {
  const { firmId } = ctx.job
  const { requestId, part } = ctx.payload
  if (process.env.NODE_ENV !== "production") await retentionTestSeam.beforeAck?.(part)
  await step(ctx as JobContext<unknown>, stepId, async (tx) => {
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
          detail: { lockUntilMax: lockUntil instanceof Timestamp ? lockUntil.toDate().toISOString() : null, lifecycle: "not_demonstrated", refusedPaths: p.refusedPaths },
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
export const sagaInternals = { staticAck, parsePurge, parsePrepare, nextPart, traceIdParts, vaultPathOf }
