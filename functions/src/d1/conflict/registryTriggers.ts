import { createHash } from "node:crypto"
import { FieldValue, Timestamp, type DocumentData } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { onDocumentWritten } from "firebase-functions/v2/firestore"
import { INTERNAL_ONLY, RUNTIME_DEFAULTS } from "../../runtimeOptions"
import { adminDb } from "../../admin"
import { nameIndexGenOf, nextNameIndexGen, registryStateOf, registryVersionRef } from "../registryVersion"
import { sameKey, screenedKeyOf, stampOf } from "./screenedName"
import { enqueueReindexTx } from "./screening"

/**
 * The conflict name index's guard against writes made outside functions/src (audit F37 re-audit FA-D1C-002 and
 * FA-D1C-004; spec 2026-10-18-f37 ruling 16).
 *
 * The index's invariant holds for every writer in functions/src: each one that sets a screened name stages it in the
 * index in the same transaction (`stageRegistryWrite`) and stamps the row with `nameIndexed = { firmId, name, gen }`,
 * `gen` being the index generation it read there (`nameIndexGen`, moved by every reset and every break). A
 * client renamed, a client or opposing party inserted, a party flipped to opposing, or a row moved between firms by the
 * Admin SDK, a console edit or an import does neither, and a name removed from a chunk out of band takes a name away.
 * These Firestore triggers notice both and break the index's mirror: the registry version moves while
 * `nameIndex.version` does not, so every screen refuses (503 `screening_unavailable`) and the reindex job enqueued here
 * rebuilds the index from the registry within seconds. A reconciliation already in flight cannot mark the index
 * current over such a write: its mark requires every registry write since its start to have kept the mirror.
 *
 * Triggers are asynchronous: between an out-of-band write and its trigger the index still reads current, and a screen
 * in that window does not see the new name (residual; measured in `f37-fu-trigger-pipeline.emu.test.ts`).
 */

export { nameIndexStamp, screenedKeyOf, stampOf, type NameStamp, type ScreenedKey } from "./screenedName"

/**
 * What a client or party write means for the index (pure; `gen` is the firm's current index generation, null when
 * unknown or malformed). `unchanged`: after it the row has no screened name, or the same one as before (closeMatter's
 * status update, any edit of other fields; a deletion leaves a name the index may keep, which finds no row and so no
 * hit). `indexed`: a new screened name stamped by a writer that staged it in the current generation. `unindexed`: a new
 * screened name nobody staged (written outside functions/src), or one whose stamp is older than the last reset or break
 * (a row restored from a backup, or renamed back to its stamped name, after a rebuild dropped that name): the index
 * must be rebuilt.
 */
export function rowWriteVerdict(
  collection: string,
  before: DocumentData | undefined,
  after: DocumentData | undefined,
  gen: number | null
): "unchanged" | "indexed" | "unindexed" {
  const key = screenedKeyOf(collection, after)
  if (key === null || sameKey(key, screenedKeyOf(collection, before))) return "unchanged"
  const stamp = stampOf(after)
  return sameKey(key, stamp) && stamp !== null && gen !== null && stamp.gen === gen ? "indexed" : "unindexed"
}

/** Whether the verdict of this write depends on the firm's current generation (a new screened name, stamped with it). */
function needsGen(collection: string, before: DocumentData | undefined, after: DocumentData | undefined): string | null {
  const key = screenedKeyOf(collection, after)
  if (key === null || sameKey(key, screenedKeyOf(collection, before))) return null
  return sameKey(key, stampOf(after)) ? key.firmId : null
}

/** The names a chunk body holds (strings only). */
const namesIn = (data: DocumentData | undefined): Set<string> => new Set(Array.isArray(data?.names) ? (data.names as unknown[]).filter((x): x is string => typeof x === "string") : [])

/**
 * What a write to a name index chunk means (pure). Writers in functions/src only append to a chunk (arrayUnion), create
 * one, or delete chunks in a reset that also resets the state. `names_removed`: an existing chunk lost a name it held
 * (FA-D1C-004), which no writer does. A create or a delete is `ok` here: a chunk beyond the pointer, or a missing or
 * malformed one, already makes every screen refuse (`indexedNamesOf`).
 */
export function chunkWriteVerdict(before: DocumentData | undefined, after: DocumentData | undefined): "ok" | "names_removed" {
  if (before === undefined || after === undefined) return "ok"
  const kept = namesIn(after)
  if (!Array.isArray(after.names)) return namesIn(before).size > 0 ? "names_removed" : "ok"
  for (const name of namesIn(before)) if (!kept.has(name)) return "names_removed"
  return "ok"
}

/** The collection of break markers: one per trigger event that broke an index, kept past the platform's 7-day retries. */
export const BREAK_MARKERS_COLLECTION = "conflict_index_breaks"
/** How long a break marker is kept (`expiresAt`, Firestore TTL): longer than the 7 days a failed event is redelivered. */
export const BREAK_MARKER_TTL_MS = 8 * 24 * 3_600_000

/** The marker of one trigger event (its CloudEvent id, hashed into a safe document id). */
export const breakMarkerRef = (eventId: string) =>
  adminDb().collection(BREAK_MARKERS_COLLECTION).doc(createHash("sha256").update(eventId).digest("hex"))

/**
 * Breaks the firm's index mirror, once per trigger event, in one transaction that reads the counter (and the event's
 * marker) and then:
 *
 * - moves the registry version while `nameIndex.version` stays, so every screen refuses until a reconciliation marks
 *   a rebuilt index current (a write to `counters`, which no trigger watches: no loop);
 * - writes the generation absolutely (`nextNameIndexGen`), so no stamp written before the break is trusted again and a
 *   malformed stored value is replaced, never incremented into one that can equal an older stamp (PR #89 review,
 *   Bugbot 4307596177);
 * - stages the reindex run keyed by the counter's confirmation count read here (`enqueueReindexTx`), so the break and
 *   a run that confirms after it commit together (PR #89 review, Codex 4307586920);
 * - creates the event's marker. A redelivered event (at-least-once delivery, or a retry after a failure) finds its
 *   marker and changes nothing: its break and its run committed with the marker.
 *
 * The transaction contends with registry writes on the counter document; a failed attempt throws, and the platform
 * redelivers the event (`retry: true`). Returns whether this call broke the index. Without an event id (a direct call)
 * there is no marker and every call breaks.
 */
export async function breakNameIndex(firmId: string, nowMs: number, cause: Record<string, string>, eventId?: string): Promise<boolean> {
  const counterRef = registryVersionRef(firmId)
  const marker = eventId === undefined ? null : breakMarkerRef(eventId)
  const broke = await adminDb().runTransaction(async (tx) => {
    if (marker !== null && (await tx.get(marker)).exists) return false
    const counter = await tx.get(counterRef)
    const state = registryStateOf(counter.exists, counter.data())
    await enqueueReindexTx(tx, firmId, nowMs, state)
    tx.set(
      counterRef,
      { firmId, kind: "registry", classification: "internal", version: FieldValue.increment(1), nameIndexGen: nextNameIndexGen(state) },
      { merge: true }
    )
    if (marker !== null) {
      tx.create(marker, {
        firmId,
        kind: "conflict_index_break",
        classification: "internal",
        ...cause,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(nowMs + BREAK_MARKER_TTL_MS),
      })
    }
    return true
  })
  if (broke) logger.warn("conflict.name_index_broken", { firmId, ...cause })
  else logger.info("conflict.name_index_break_repeated", { firmId, ...cause })
  return broke
}

/**
 * The handler of a client or opposing-party write (the event's before and after data, its time and its id). Returns
 * the verdict. A new, stamped screened name costs one read: the firm's counter, for its current generation.
 */
export async function registryRowWritten(
  collection: string,
  docId: string,
  before: DocumentData | undefined,
  after: DocumentData | undefined,
  nowMs: number,
  eventId?: string
): Promise<"unchanged" | "indexed" | "unindexed"> {
  const firmOfStamp = needsGen(collection, before, after)
  const gen = firmOfStamp === null ? null : nameIndexGenOf((await registryVersionRef(firmOfStamp).get()).data())
  const verdict = rowWriteVerdict(collection, before, after, gen)
  const key = screenedKeyOf(collection, after)
  if (verdict === "unindexed" && key !== null) await breakNameIndex(key.firmId, nowMs, { collection, docId, reason: "unindexed_name" }, eventId)
  return verdict
}

/** The handler of a name index chunk write (the event's data, time and id). Returns the verdict. */
export async function nameIndexChunkWritten(
  chunkId: string,
  before: DocumentData | undefined,
  after: DocumentData | undefined,
  nowMs: number,
  eventId?: string
): Promise<"ok" | "names_removed"> {
  const verdict = chunkWriteVerdict(before, after)
  if (verdict === "names_removed") {
    const firmId = typeof before?.firmId === "string" ? before.firmId : chunkId.replace(/_\d+$/, "")
    await breakNameIndex(firmId, nowMs, { collection: "conflict_name_index", docId: chunkId, reason: "names_removed" }, eventId)
  }
  return verdict
}

// O-33: a Firestore trigger runs in the database's region (asia-south1, as onJobCreated). `retry: true`: a thrown
// (transient store) error is redelivered by the platform for up to 7 days; the handlers are safe to repeat.
export const d1ConflictClientWritten = onDocumentWritten(
  { ...RUNTIME_DEFAULTS, document: "clients/{clientId}", maxInstances: 10, timeoutSeconds: 60, ingressSettings: INTERNAL_ONLY, retry: true },
  (event) =>
  registryRowWritten("clients", event.params.clientId, event.data?.before.data(), event.data?.after.data(), Date.now(), event.id)
)

export const d1ConflictPartyWritten = onDocumentWritten(
  { ...RUNTIME_DEFAULTS, document: "matter_parties/{partyId}", maxInstances: 10, timeoutSeconds: 60, ingressSettings: INTERNAL_ONLY, retry: true },
  (event) =>
  registryRowWritten("matter_parties", event.params.partyId, event.data?.before.data(), event.data?.after.data(), Date.now(), event.id)
)

export const d1ConflictIndexChunkWritten = onDocumentWritten(
  { ...RUNTIME_DEFAULTS, document: "conflict_name_index/{chunkId}", maxInstances: 10, timeoutSeconds: 60, ingressSettings: INTERNAL_ONLY, retry: true },
  (event) =>
  nameIndexChunkWritten(event.params.chunkId, event.data?.before.data(), event.data?.after.data(), Date.now(), event.id)
)
