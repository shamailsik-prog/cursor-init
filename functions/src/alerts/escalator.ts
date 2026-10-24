import { Timestamp, type DocumentReference, type Transaction } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { adminDb } from "../admin"
import { errorCode } from "../log"
import { ACK_WINDOW_MS, LAST_LEVEL, OWNER_LADDER, opsAlertsRef, raiseSeverity, type AlertRow, type OwnerRole } from "./model"
import { deliverPending, logAlertNotifier, stagePage, type AlertNotifier, type PageTarget } from "./notifier"

/**
 * The escalator (audit F43, spec R5, R7, R10), run every minute by `alertEscalator`. Two passes, each caught on its own:
 *
 * 1. Escalate: every `open` alert whose acknowledgment deadline (`escalateAt`) has passed, oldest first, moves one
 *    level up the owner ladder (operator → partner → firm administrator), one severity step higher, with a new
 *    deadline from now and a page for the new owner. At the last level there is no step: the alert is re-paged (the
 *    firm administrator and the on-call channel) once per critical window until someone acknowledges or resolves it
 *    (spec R21, re-audit FA-F43-R1-005). Each step or re-page is one transaction that re-reads the alert and acts
 *    only if it is still open, still at the level the query saw and still past its deadline: a rerun, a concurrent run
 *    or a run long after the deadline takes exactly one. An alert without a deadline (a kill switch's, spec R23, or
 *    one the checker cleared, spec R22) is never returned by the query.
 * 2. Deliver: every pending page (`deliverPending`) to the notifier.
 *
 * A wall-clock budget (`ESCALATOR_BUDGET_MS`, 30 s, inside the function's 45 s timeout) ends a run between alerts.
 */

export const ESCALATOR_BUDGET_MS = 30_000
const ESCALATE_PAGE_SIZE = 100
const ESCALATE_MAX_QUERIES = 5

const millisOf = (t: unknown): number | null => (t instanceof Timestamp ? t.toMillis() : null)

/** The firm's active partners, by uid (sorted). */
async function activePartners(tx: Transaction, firmId: string): Promise<string[]> {
  const snap = await tx.get(adminDb().collection("users").where("firmId", "==", firmId).where("role", "==", "partner").where("active", "==", true).limit(50))
  return snap.docs.map((d) => d.id).sort()
}

/**
 * The firm administrator (spec R4): the founding partner `onboardFirm` recorded in `platform_onboarding/{uid}` (FN-1),
 * while that user is an active partner of the firm. Otherwise the firm's active partners, marked as a fallback.
 */
async function firmAdmins(tx: Transaction, firmId: string): Promise<{ uids: string[]; fallback: "partners" | null }> {
  const marks = await tx.get(adminDb().collection("platform_onboarding").where("firmId", "==", firmId).limit(5))
  const candidates = marks.docs.map((d) => d.id)
  const users = candidates.length === 0 ? [] : await tx.getAll(...candidates.map((uid) => adminDb().collection("users").doc(uid)))
  const admins = users.filter((u) => u.exists && u.get("firmId") === firmId && u.get("role") === "partner" && u.get("active") === true).map((u) => u.id)
  if (admins.length > 0) return { uids: admins.sort(), fallback: null }
  return { uids: await activePartners(tx, firmId), fallback: "partners" }
}

async function ownersOf(tx: Transaction, firmId: string, role: OwnerRole): Promise<{ uids: string[]; fallback: "partners" | null }> {
  if (role === "partner") return { uids: await activePartners(tx, firmId), fallback: null }
  if (role === "firm_admin") return firmAdmins(tx, firmId)
  return { uids: [], fallback: null }
}

/**
 * One fenced step of the alert at `ref`, seen by the query at `seenLevel`: "stepped" (one level up the ladder),
 * "repaged" (the last level paged again, spec R21), or null (nothing to do: no longer open, another run acted, or not
 * yet due).
 */
async function escalateOne(ref: DocumentReference, seenLevel: number, nowMs: number): Promise<"stepped" | "repaged" | null> {
  return adminDb().runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data() as AlertRow | undefined
    if (!row || row.state !== "open" || row.level !== seenLevel) return null
    const due = millisOf(row.escalateAt)
    if (due === null || due > nowMs) return null
    const at = Timestamp.fromMillis(nowMs)
    if (!(row.level < LAST_LEVEL)) {
      // Spec R21 (re-audit FA-F43-R1-005): nobody is left to escalate to, so the last level's owners and the on-call
      // channel are paged again, once per critical window, until someone acknowledges or resolves the alert. The next
      // deadline is computed from now, so a run long after the deadline re-pages once, not once per missed window.
      const level = Math.min(row.level, LAST_LEVEL)
      const ownerRole = OWNER_LADDER[level]
      const repage = (typeof row.repages === "number" ? row.repages : 0) + 1
      const owners = await ownersOf(tx, row.firmId, ownerRole)
      tx.update(ref, { repages: repage, escalateAt: Timestamp.fromMillis(nowMs + ACK_WINDOW_MS.critical), updatedAt: at })
      const targets: PageTarget[] = [{ kind: "oncall" }, ...owners.uids.map((uid) => ({ kind: "user" as const, uid }))]
      stagePage(tx, ref.id, { firmId: row.firmId, condition: row.condition, severity: row.severity, episode: row.episode }, level, ownerRole, targets, nowMs, owners.fallback, repage)
      return "repaged"
    }
    const level = row.level + 1
    const ownerRole = OWNER_LADDER[level]
    const severity = raiseSeverity(row.severity)
    const owners = await ownersOf(tx, row.firmId, ownerRole)
    // The last level keeps a deadline too: one window, after which it is re-paged (spec R21).
    const escalateAt = Timestamp.fromMillis(nowMs + ACK_WINDOW_MS[severity])
    tx.update(ref, {
      level,
      ownerRole,
      severity,
      escalateAt,
      escalations: [...(Array.isArray(row.escalations) ? row.escalations : []), { level, ownerRole, severity, at }],
      updatedAt: at,
    })
    const targets: PageTarget[] = [{ kind: "oncall" }, ...owners.uids.map((uid) => ({ kind: "user" as const, uid }))]
    stagePage(tx, ref.id, { firmId: row.firmId, condition: row.condition, severity, episode: row.episode }, level, ownerRole, targets, nowMs, owners.fallback)
    return "stepped"
  })
}

/** Steps every open alert past its deadline once (or re-pages it at the last level); returns the ids of each. */
async function escalateDue(now: () => number, spent: () => boolean, out: { escalated: string[]; repaged: string[] }): Promise<void> {
  const seen = new Set<string>()
  for (let q = 0; q < ESCALATE_MAX_QUERIES && !spent(); q++) {
    const docs = (await opsAlertsRef().where("state", "==", "open").where("escalateAt", "<=", Timestamp.fromMillis(now())).orderBy("escalateAt").limit(ESCALATE_PAGE_SIZE).get()).docs
    let acted = 0
    for (const doc of docs) {
      if (spent()) break
      if (seen.has(doc.id)) continue
      seen.add(doc.id)
      acted += 1
      try {
        const step = await escalateOne(doc.ref, doc.get("level") as number, now())
        if (step === "stepped") out.escalated.push(doc.id)
        else if (step === "repaged") out.repaged.push(doc.id)
      } catch (err) {
        logger.error("ops_alert.pass_failed", { pass: "escalate", alertId: doc.id, code: errorCode(err), event: "ops_alert.pass_failed" })
      }
    }
    // A stepped or re-paged alert's deadline moved past now, so the query is re-run (not cursored); stop on a short or
    // idle page.
    if (docs.length < ESCALATE_PAGE_SIZE || acted === 0) break
  }
}

export type EscalatorOptions = { now?: () => number; notifier?: AlertNotifier; wallClock?: () => number }

/** One escalator run: escalate (and re-page the last level), then deliver. */
export async function runAlertEscalator(opts: EscalatorOptions = {}): Promise<{ escalated: string[]; repaged: string[]; delivered: string[] }> {
  const now = opts.now ?? Date.now
  const wall = opts.wallClock ?? Date.now
  const started = wall()
  const spent = () => wall() - started >= ESCALATOR_BUDGET_MS
  const out = { escalated: [] as string[], repaged: [] as string[], delivered: [] as string[] }
  try {
    await escalateDue(now, spent, out)
  } catch (err) {
    logger.error("ops_alert.pass_failed", { pass: "escalate", code: errorCode(err), event: "ops_alert.pass_failed" })
  }
  try {
    out.delivered = await deliverPending({ now, notifier: opts.notifier ?? logAlertNotifier, spent })
  } catch (err) {
    logger.error("ops_alert.pass_failed", { pass: "deliver", code: errorCode(err), event: "ops_alert.pass_failed" })
  }
  return out
}
