import { createHash } from "node:crypto"
import { FieldValue, Timestamp, type DocumentData, type DocumentReference, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../../admin"
import { isSafeDocId } from "../../p5/common"
import { JobError } from "../../p2/errors"
import type { JobContext, JobHandler, JobResult } from "../../p2/registry"
import { bumpRegistryVersion } from "../registryVersion"
import { DETERMINISTIC_KEY_SCORE, isUnmergeInProgress } from "./linkState"

/**
 * The un-merge saga's two job types (spec P3-24..P3-30; L18 §7.5): one job per collection that
 * references an entity link today, with idempotencyKey `${mergeEventId}:${collection}`.
 *
 * - `d1.unmerge.links` (`entity_links`): reopens every confirmed row of the pair as a disputed
 *   candidate, so a partner must decide it again.
 * - `d1.unmerge.checks` (`conflict_checks`): marks every check whose hits relied on the pair's
 *   link rows stale (P2-21), in fenced chunks.
 *
 * Each job ends by recording itself done on the merge event; the job that completes the set also
 * finishes the saga in the same transaction (event `unmerge.status: "completed"`, rows
 * `unmerge.status: "completed"`, `entity.unmerged`). Both are saga jobs: a dead letter is retried
 * by a partner only and cannot be cancelled (P3-12, P3-13).
 */

export const UNMERGE_COLLECTIONS = ["entity_links", "conflict_checks"] as const
export type UnmergeCollection = (typeof UNMERGE_COLLECTIONS)[number]
export const UNMERGE_JOB_TYPES: Readonly<Record<UnmergeCollection, string>> = {
  entity_links: "d1.unmerge.links",
  conflict_checks: "d1.unmerge.checks",
}

/** Checks marked stale per fenced step (one transaction). */
export const STALE_CHUNK = 200
/** Fenced steps one job may record is 50 (MAX_FENCED_STEPS); one is the completion step. */
export const MAX_STALE_CHUNKS = 48

export type UnmergePayload = { mergeEventId: string; pairId: string; leftId: string; rightId: string; linkIds: string[] }

const invalid = () => new JobError("invalid_payload", { permanent: true })
const PAYLOAD_KEYS: ReadonlySet<string> = new Set(["mergeEventId", "pairId", "leftId", "rightId", "linkIds"])

function parse(payload: unknown): UnmergePayload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw invalid()
  const raw = payload as Record<string, unknown>
  for (const key of Object.keys(raw)) if (!PAYLOAD_KEYS.has(key)) throw invalid()
  const { mergeEventId, pairId, leftId, rightId, linkIds } = raw
  if (!isSafeDocId(mergeEventId) || !isSafeDocId(pairId) || !isSafeDocId(leftId) || !isSafeDocId(rightId)) throw invalid()
  if (!Array.isArray(linkIds) || linkIds.length < 1 || linkIds.length > 8 || !linkIds.every((id): id is string => isSafeDocId(id))) throw invalid()
  return { mergeEventId, pairId, leftId, rightId, linkIds: [...linkIds] }
}

type Loaded = {
  eventRef: DocumentReference
  event: DocumentData
  rows: Array<{ ref: DocumentReference; data: DocumentData }>
}

/** Reads the merge event and the pair's rows in `tx`. The event must be this firm's, reverted and in progress, else the permanent `unmerge_event_invalid`. */
async function load(tx: Transaction, firmId: string, p: UnmergePayload): Promise<Loaded | null> {
  const db = adminDb()
  const eventRef = db.collection("merge_events").doc(p.mergeEventId)
  const refs = p.linkIds.map((id) => db.collection("entity_links").doc(id))
  const [eventSnap, ...rowSnaps] = await tx.getAll(eventRef, ...refs)
  const event = eventSnap.data()
  if (!event || event.firmId !== firmId || event.kind !== "link_confirmed" || event.reverted !== true || event.pairId !== p.pairId) {
    throw new JobError("unmerge_event_invalid", { permanent: true })
  }
  // A saga that is already finished has nothing left to do (a replay after completion).
  if (event.unmerge?.status !== "in_progress") return null
  const rows = rowSnaps.map((s) => ({ ref: s.ref, data: s.data() ?? {} }))
  if (rows.some((r) => r.data.firmId !== firmId)) throw new JobError("unmerge_event_invalid", { permanent: true })
  return { eventRef, event, rows }
}

/**
 * Stages "this collection is done" on the event; when it completes the set, stages the finish.
 * `rowPatches` are the caller's own row writes, merged so each row is written once.
 */
function completeCollection(tx: Transaction, firmId: string, loaded: Loaded, collection: UnmergeCollection, p: UnmergePayload, rowPatches: Map<string, Record<string, unknown>>): void {
  const jobs: Record<string, unknown> = { ...(loaded.event.unmerge?.jobs as Record<string, unknown> | undefined), [collection]: "done" }
  const all = UNMERGE_COLLECTIONS.every((c) => jobs[c] === "done")
  const eventPatch: Record<string, unknown> = { [`unmerge.jobs.${collection}`]: "done" }
  if (all) {
    eventPatch["unmerge.status"] = "completed"
    eventPatch["unmerge.completedAt"] = Timestamp.now()
    for (const r of loaded.rows) {
      if (isUnmergeInProgress(r.data)) rowPatches.set(r.ref.id, { ...rowPatches.get(r.ref.id), "unmerge.status": "completed" })
    }
    tx.create(adminDb().collection("events").doc(`${p.mergeEventId}_unmerged`), {
      name: "entity.unmerged",
      firmId,
      payload: { entityIds: [p.leftId, p.rightId], mergeEventId: p.mergeEventId, score: DETERMINISTIC_KEY_SCORE },
      classification: loaded.event.classification,
      occurredAt: FieldValue.serverTimestamp(),
      idempotencyKey: `${p.mergeEventId}:unmerged`,
    })
  }
  tx.update(loaded.eventRef, eventPatch)
  for (const r of loaded.rows) {
    const patch = rowPatches.get(r.ref.id)
    if (patch) tx.update(r.ref, patch)
  }
  // The pair's effective state moved (confirmed → unresolved), which the conflict screen reads.
  bumpRegistryVersion(tx, firmId)
}

async function runLinks(ctx: JobContext<UnmergePayload>): Promise<JobResult> {
  const { firmId } = ctx.job
  const p = ctx.payload
  await ctx.runFenced("reopen-links", async (tx) => {
    const loaded = await load(tx, firmId, p)
    if (!loaded) return
    const patches = new Map<string, Record<string, unknown>>()
    for (const r of loaded.rows) {
      const owned = r.data.state === "confirmed" && isUnmergeInProgress(r.data) && r.data.confirmation?.mergeEventId === p.mergeEventId
      if (owned) patches.set(r.ref.id, { state: "candidate", disputed: true })
    }
    completeCollection(tx, firmId, loaded, "entity_links", p, patches)
  })
  return { outputRefs: [`merge_events/${p.mergeEventId}`] }
}

/** Whether a stored check's hits relied on any of `linkIds` (P2-21: `hits[].reliedOnLinkIds`). */
export function checkReliesOn(check: DocumentData, linkIds: ReadonlySet<string>): boolean {
  if (!Array.isArray(check.hits)) return false
  return check.hits.some((h: unknown) => {
    const relied = (h as { reliedOnLinkIds?: unknown } | null)?.reliedOnLinkIds
    return Array.isArray(relied) && relied.some((id) => typeof id === "string" && linkIds.has(id))
  })
}

/** A step id from the chunk's own check ids, so a retry that finds fewer checks never skips a different chunk. */
const chunkStepId = (ids: readonly string[]): string => `stale-${createHash("sha256").update(ids.join("\0")).digest("hex").slice(0, 24)}`

async function runChecks(ctx: JobContext<UnmergePayload>): Promise<JobResult> {
  const { firmId } = ctx.job
  const p = ctx.payload
  const linkIds = new Set(p.linkIds)
  const snap = await adminDb().collection("conflict_checks").where("firmId", "==", firmId).get()
  const targets = snap.docs.filter((d) => d.data().stale !== true && checkReliesOn(d.data(), linkIds)).sort((x, y) => (x.id < y.id ? -1 : 1))
  if (targets.length > STALE_CHUNK * MAX_STALE_CHUNKS) throw new JobError("too_many_checks", { permanent: true })
  for (let i = 0; i < targets.length; i += STALE_CHUNK) {
    const chunk = targets.slice(i, i + STALE_CHUNK)
    await ctx.runFenced(chunkStepId(chunk.map((d) => d.id)), async (tx) => {
      for (const d of chunk) tx.update(d.ref, { stale: true, staleReason: { kind: "unmerge", mergeEventId: p.mergeEventId } })
    })
  }
  await ctx.runFenced("complete-checks", async (tx) => {
    const loaded = await load(tx, firmId, p)
    if (loaded) completeCollection(tx, firmId, loaded, "conflict_checks", p, new Map())
  })
  return { outputRefs: [`merge_events/${p.mergeEventId}`] }
}

const errorCodes = {
  unmerge_event_invalid: "The un-merge event is missing or does not match the job.",
  too_many_checks: "Too many conflict checks rely on the reverted link.",
} as const

export const unmergeLinksHandler: JobHandler<UnmergePayload> = { jobType: UNMERGE_JOB_TYPES.entity_links, saga: true, errorCodes, parse, run: runLinks }
export const unmergeChecksHandler: JobHandler<UnmergePayload> = { jobType: UNMERGE_JOB_TYPES.conflict_checks, saga: true, errorCodes, parse, run: runChecks }
