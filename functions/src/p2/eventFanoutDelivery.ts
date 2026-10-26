import { createHash } from "node:crypto"
import { Timestamp, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../admin"
import { fanOutKey } from "./fanout"
import type { EnqueueResult } from "./enqueue"

/**
 * Durable fan-out ledger (audit F36, O-37): one row per (event, production subscriber) whose job was
 * enqueued. The reconciler scans events that lack a row and calls `fanOutEvent` again; a redelivery
 * reuses the job idempotency key and backfills the missing row.
 */

export const EVENT_FANOUT_DELIVERIES = "event_fanout_deliveries"

/** Document id: SHA-256 of the fan-out idempotency key (safe length, no raw event id). */
export function deliveryDocId(eventId: string, subscriberId: string): string {
  return createHash("sha256").update(fanOutKey(eventId, subscriberId), "utf8").digest("hex")
}

export function deliveryRef(eventId: string, subscriberId: string) {
  return adminDb().collection(EVENT_FANOUT_DELIVERIES).doc(deliveryDocId(eventId, subscriberId))
}

export type FanoutDeliveryRow = {
  schemaVersion: 1
  eventId: string
  subscriberId: string
  firmId: string
  eventName: string
  jobId: string
  deliveredAt: Timestamp
}

export type FanoutDeliveryTarget = {
  subscriberId: string
  eventName: string
  jobId: string
}

/** Reads delivery docs that must be fetched before any write in the same transaction. */
export async function readFanoutDeliverySnaps(
  tx: Transaction,
  eventId: string,
  targets: readonly { subscriberId: string }[]
): Promise<DocumentSnapshot[]> {
  if (targets.length === 0) return []
  const refs = targets.map((t) => deliveryRef(eventId, t.subscriberId))
  return tx.getAll(...refs)
}

/**
 * Creates missing delivery rows in `tx` using snapshots read earlier in the same transaction.
 * Existing rows are left unchanged so a reused job id still records the first delivery time.
 */
export function stageFanoutDeliveries(
  tx: Transaction,
  firmId: string,
  eventId: string,
  targets: readonly FanoutDeliveryTarget[],
  existingSnaps: readonly DocumentSnapshot[],
  now: Timestamp
): void {
  if (targets.length === 0) return
  existingSnaps.forEach((snap, i) => {
    if (snap.exists) return
    const t = targets[i]
    const row: FanoutDeliveryRow = {
      schemaVersion: 1,
      eventId,
      subscriberId: t.subscriberId,
      firmId,
      eventName: t.eventName,
      jobId: t.jobId,
      deliveredAt: now,
    }
    tx.create(snap.ref, row)
  })
}

/** Whether every target already has a delivery row (read outside a transaction). */
export async function fanoutDeliveriesComplete(
  eventId: string,
  targets: readonly { subscriberId: string }[]
): Promise<boolean> {
  if (targets.length === 0) return true
  const snaps = await adminDb().getAll(...targets.map((t) => deliveryRef(eventId, t.subscriberId)))
  return snaps.every((s) => s.exists)
}

/** Maps enqueue results to delivery targets when specs and subscriber ids align by index. */
export function deliveryTargetsFromEnqueue(
  eventName: string,
  subscriberIds: readonly string[],
  results: readonly EnqueueResult[]
): FanoutDeliveryTarget[] {
  return results.map((r, i) => ({
    subscriberId: subscriberIds[i],
    eventName,
    jobId: r.jobId,
  }))
}
