import { FieldValue, type DocumentData } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { onDocumentWritten } from "firebase-functions/v2/firestore"
import { REGION } from "../../health"
import { nameIndexGenOf, registryVersionRef } from "../registryVersion"
import { sameKey, screenedKeyOf, stampOf } from "./screenedName"
import { requestReindex } from "./screening"

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

/**
 * Breaks the firm's index mirror: a blind increment of the registry version (no read, so no contention retry, and no
 * write to a watched collection, so no trigger loop), then the on-demand reindex. Every screen refuses until the
 * reconciliation marks a rebuilt index current. The generation moves with it, so no stamp written before the break is
 * trusted again (a name removed from a chunk may be missing, and its row may come back later with an old stamp). A
 * redelivered event bumps again, which only breaks the mirror again.
 */
export async function breakNameIndex(firmId: string, nowMs: number, cause: Record<string, string>): Promise<void> {
  await registryVersionRef(firmId).set(
    { firmId, kind: "registry", classification: "internal", version: FieldValue.increment(1), nameIndexGen: FieldValue.increment(1) },
    { merge: true }
  )
  logger.warn("conflict.name_index_broken", { firmId, ...cause })
  await requestReindex(firmId, nowMs)
}

/**
 * The handler of a client or opposing-party write (the event's before and after data). Returns the verdict. A new,
 * stamped screened name costs one read: the firm's counter, for its current generation.
 */
export async function registryRowWritten(
  collection: string,
  docId: string,
  before: DocumentData | undefined,
  after: DocumentData | undefined,
  nowMs: number
): Promise<"unchanged" | "indexed" | "unindexed"> {
  const firmOfStamp = needsGen(collection, before, after)
  const gen = firmOfStamp === null ? null : nameIndexGenOf((await registryVersionRef(firmOfStamp).get()).data())
  const verdict = rowWriteVerdict(collection, before, after, gen)
  const key = screenedKeyOf(collection, after)
  if (verdict === "unindexed" && key !== null) await breakNameIndex(key.firmId, nowMs, { collection, docId, reason: "unindexed_name" })
  return verdict
}

/** The handler of a name index chunk write. Returns the verdict. */
export async function nameIndexChunkWritten(chunkId: string, before: DocumentData | undefined, after: DocumentData | undefined, nowMs: number): Promise<"ok" | "names_removed"> {
  const verdict = chunkWriteVerdict(before, after)
  if (verdict === "names_removed") {
    const firmId = typeof before?.firmId === "string" ? before.firmId : chunkId.replace(/_\d+$/, "")
    await breakNameIndex(firmId, nowMs, { collection: "conflict_name_index", docId: chunkId, reason: "names_removed" })
  }
  return verdict
}

// O-33: a Firestore trigger runs in the database's region (asia-south1, as onJobCreated). `retry: true`: a thrown
// (transient store) error is redelivered by the platform for up to 7 days; the handlers are safe to repeat.
export const d1ConflictClientWritten = onDocumentWritten({ document: "clients/{clientId}", region: REGION, retry: true }, (event) =>
  registryRowWritten("clients", event.params.clientId, event.data?.before.data(), event.data?.after.data(), Date.now())
)

export const d1ConflictPartyWritten = onDocumentWritten({ document: "matter_parties/{partyId}", region: REGION, retry: true }, (event) =>
  registryRowWritten("matter_parties", event.params.partyId, event.data?.before.data(), event.data?.after.data(), Date.now())
)

export const d1ConflictIndexChunkWritten = onDocumentWritten({ document: "conflict_name_index/{chunkId}", region: REGION, retry: true }, (event) =>
  nameIndexChunkWritten(event.params.chunkId, event.data?.before.data(), event.data?.after.data(), Date.now())
)
