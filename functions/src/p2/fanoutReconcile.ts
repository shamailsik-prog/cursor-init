import { FieldPath, type DocumentData, type Firestore } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { adminDb } from "../admin"
import { isSafeDocId } from "../p5/common"
import type { JobDeps } from "./dispatch"
import { fanoutDeliveriesComplete } from "./eventFanoutDelivery"
import { fanOutEvent, productionSubscribersForEvent, SUBSCRIBERS } from "./fanout"

/**
 * Repairs fan-out gaps beyond the seven-day `onEventCreated` retry window (O-37, audit F36): scans
 * `events` in document-id order and re-runs `fanOutEvent` for any row that lacks a delivery ledger
 * entry for a matching production subscriber.
 */

export const FANOUT_RECONCILE_CURSOR_DOC = "platform/p2EventFanoutReconcile"

/** Events read per reconciler run (bounded wall-clock work; the cursor wraps). */
export const FANOUT_RECONCILE_PAGE_SIZE = 50

export type FanoutReconcileResult = { scanned: number; repaired: number }

function cursorRef(db: Firestore) {
  return db.doc(FANOUT_RECONCILE_CURSOR_DOC)
}

async function readCursor(db: Firestore): Promise<string | null> {
  const snap = await cursorRef(db).get()
  const raw = snap.data()?.cursor
  return typeof raw === "string" && raw.length > 0 ? raw : null
}

async function writeCursor(db: Firestore, cursor: string | null): Promise<void> {
  await cursorRef(db).set({ cursor, updatedAt: Date.now() }, { merge: true })
}

/** Repairs one event when a production subscriber lacks a delivery row; idempotent. */
export async function repairFanoutForEvent(
  eventId: string,
  data: DocumentData,
  deps: Pick<JobDeps, "clock">
): Promise<boolean> {
  const targets = subscribersForEventData(data)
  if (targets.length === 0) return false
  if (await fanoutDeliveriesComplete(eventId, targets)) return false
  const outcome = await fanOutEvent(eventId, data, deps)
  if (outcome.created.length + outcome.reused.length > 0) return true
  logger.warn("event.fanout_reconcile_skipped", { eventId })
  return false
}

function subscribersForEventData(data: DocumentData | undefined): { subscriberId: string }[] {
  const name = data?.name
  if (typeof name !== "string") return []
  return productionSubscribersForEvent(name).map((s) => ({ subscriberId: s.id }))
}

/**
 * One reconciler pass: reads up to `FANOUT_RECONCILE_PAGE_SIZE` event docs after the stored cursor,
 * repairs any missing deliveries, then advances the cursor (wrapping after the last id).
 */
export async function reconcileEventFanout(deps: Pick<JobDeps, "clock">): Promise<FanoutReconcileResult> {
  if (SUBSCRIBERS.length === 0) return { scanned: 0, repaired: 0 }
  const db = adminDb()
  const startAfter = await readCursor(db)
  let q = db.collection("events").orderBy(FieldPath.documentId()).limit(FANOUT_RECONCILE_PAGE_SIZE)
  if (startAfter) q = q.startAfter(startAfter)
  const page = await q.get()
  if (page.empty) {
    await writeCursor(db, null)
    return { scanned: 0, repaired: 0 }
  }

  let repaired = 0
  for (const doc of page.docs) {
    const data = doc.data()
    const firmId: unknown = data.firmId
    if (!isSafeDocId(firmId)) continue
    const targets = subscribersForEventData(data)
    if (targets.length === 0) continue
    if (await repairFanoutForEvent(doc.id, data, deps)) repaired += 1
  }

  const lastId = page.docs[page.docs.length - 1].id
  const wrapped = page.size < FANOUT_RECONCILE_PAGE_SIZE
  await writeCursor(db, wrapped ? null : lastId)
  return { scanned: page.size, repaired }
}
