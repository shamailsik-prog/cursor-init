import { FieldValue, Timestamp, type DocumentReference, type QueryDocumentSnapshot, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../admin"
import { errorCode, logRegisteredError } from "../log"
import { USER_NOTIFICATIONS, alertOutboxRef, pageIdFor, type AlertCondition, type OwnerRole, type Severity } from "./model"

/**
 * The one notifier interface (audit F43, spec R7). Every owner change of an alert (the raise at level 0, each
 * escalation) stages one page in the outbox `ops_alert_notifications/{alertId}_e{episode}_l{level}`, in the
 * transaction that changes the owner, and for each user target a `notifications/{pageId}_{uid}` document (the
 * existing per-user notification surface: its user reads it and marks it read under firestore.rules). The escalator's
 * delivery pass hands each pending page to the notifier. The production notifier is a structured ERROR line that the
 * F32 manifest's log-based policy matches and routes to the on-call channel (`infra/terraform/alerts.tf`).
 */

export type PageTarget = { kind: "oncall" } | { kind: "user"; uid: string }

export type PageRow = {
  alertId: string
  firmId: string
  condition: AlertCondition
  severity: Severity
  level: number
  ownerRole: OwnerRole
  episode: number
  targets: PageTarget[]
  /** Set when the level's own owner could not be found and the firm's partners were paged instead (spec R4). */
  fallback: "partners" | null
  status: "pending" | "sending" | "delivered"
  claimedUntil: Timestamp | null
  deliveryAttempts: number
  createdAt: Timestamp
  deliveredAt: Timestamp | null
}

export type Page = PageRow & { id: string }

export interface AlertNotifier {
  /** Delivers one page to its targets outside Firestore. Throws when it could not. */
  deliver(page: Page): Promise<void>
}

/** The production notifier: one structured ERROR line per page, matched by the manifest policy `ops_alert.notified`. */
export const logAlertNotifier: AlertNotifier = {
  async deliver(page) {
    logRegisteredError("ops_alert.notified", {
      pageId: page.id,
      alertId: page.alertId,
      firmId: page.firmId,
      condition: page.condition,
      severity: page.severity,
      level: page.level,
      ownerRole: page.ownerRole,
      episode: page.episode,
      users: page.targets.filter((t) => t.kind === "user").length,
      fallback: page.fallback,
    })
  },
}

type PageSubject = { firmId: string; condition: AlertCondition; severity: Severity; episode: number }

/**
 * Stages the page for `level` of `alertId` and its user notifications in `tx` (writes only). The id is deterministic,
 * so a transaction retry rewrites the same documents.
 */
export function stagePage(tx: Transaction, alertId: string, subject: PageSubject, level: number, ownerRole: OwnerRole, targets: PageTarget[], nowMs: number, fallback: "partners" | null = null): string {
  const id = pageIdFor(alertId, subject.episode, level)
  const at = Timestamp.fromMillis(nowMs)
  const row: PageRow = {
    alertId,
    firmId: subject.firmId,
    condition: subject.condition,
    severity: subject.severity,
    level,
    ownerRole,
    episode: subject.episode,
    targets,
    fallback,
    status: "pending",
    claimedUntil: null,
    deliveryAttempts: 0,
    createdAt: at,
    deliveredAt: null,
  }
  tx.set(alertOutboxRef().doc(id), row)
  for (const t of targets) {
    if (t.kind !== "user") continue
    tx.set(adminDb().collection(USER_NOTIFICATIONS).doc(`${id}_${t.uid}`), {
      firmId: subject.firmId,
      userId: t.uid,
      kind: "ops_alert",
      alertId,
      condition: subject.condition,
      severity: subject.severity,
      level,
      episode: subject.episode,
      read: false,
      readAt: null,
      createdAt: at,
    })
  }
  return id
}

/** How long a delivery may hold its claim on a page; a run that died after claiming is retried once this passes. */
export const PAGE_CLAIM_MS = 2 * 60_000
/** Pages per delivery query, and the queries one run may make. */
const DELIVERY_PAGE_SIZE = 100
const DELIVERY_MAX_QUERIES = 5

const millisOf = (t: unknown): number | null => (t instanceof Timestamp ? t.toMillis() : null)

/**
 * Claims a page for one delivery (a transaction that re-reads it): pending, or claimed by a run whose claim has lapsed.
 * Concurrent runs therefore hand a page to the notifier once; a run that dies after its claim leaves the page to the
 * next run after `PAGE_CLAIM_MS` (at least once: a duplicate page is safe, a lost one is the finding).
 */
async function claim(ref: DocumentReference, nowMs: number): Promise<Page | null> {
  return adminDb().runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data() as PageRow | undefined
    if (!row) return null
    const lapsed = row.status === "sending" && (millisOf(row.claimedUntil) ?? 0) <= nowMs
    if (row.status !== "pending" && !lapsed) return null
    tx.update(ref, { status: "sending", claimedUntil: Timestamp.fromMillis(nowMs + PAGE_CLAIM_MS), deliveryAttempts: FieldValue.increment(1) })
    return { id: ref.id, ...row }
  })
}

/**
 * The delivery pass: every page created by `now` that is pending (or whose claim lapsed), oldest first, is claimed,
 * handed to `notifier` and marked delivered; a page the notifier refuses goes back to pending for the next run.
 * Returns the ids it delivered.
 */
export async function deliverPending(opts: { now: () => number; notifier: AlertNotifier; spent: () => boolean }): Promise<string[]> {
  const delivered: string[] = []
  const tried = new Set<string>()
  let after: QueryDocumentSnapshot | undefined
  for (let q = 0; q < DELIVERY_MAX_QUERIES && !opts.spent(); q++) {
    const base = alertOutboxRef()
      .where("status", "in", ["pending", "sending"])
      .where("createdAt", "<=", Timestamp.fromMillis(opts.now()))
      .orderBy("createdAt")
      .limit(DELIVERY_PAGE_SIZE)
    const docs = (await (after === undefined ? base : base.startAfter(after)).get()).docs
    for (const doc of docs) {
      if (opts.spent()) break
      if (tried.has(doc.id)) continue
      tried.add(doc.id)
      const nowMs = opts.now()
      const page = await claim(doc.ref, nowMs)
      if (page === null) continue
      try {
        await opts.notifier.deliver(page)
      } catch (err) {
        logRegisteredError("ops_alert.pass_failed", { pass: "deliver", pageId: doc.id, code: errorCode(err) })
        await doc.ref.update({ status: "pending", claimedUntil: null })
        continue
      }
      await doc.ref.update({ status: "delivered", claimedUntil: null, deliveredAt: Timestamp.fromMillis(nowMs) })
      delivered.push(doc.id)
    }
    if (docs.length < DELIVERY_PAGE_SIZE) break
    after = docs[docs.length - 1]
  }
  return delivered
}
