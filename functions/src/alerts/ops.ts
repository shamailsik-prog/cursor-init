import { FieldPath, Timestamp, type DocumentData } from "firebase-admin/firestore"
import { adminDb } from "../admin"
import { decodeCursor, encodeCursor, parsePage, type Page } from "../d1/pagination"
import { HttpError } from "../http/errors"
import type { CallAudit, Data, FirmOperation, FirmlessOperation, Session } from "../p5/common"
import { isSafeDocId } from "../p5/common"
import { requirePermission } from "../p5/permission"
import { ALERT_STATES, MAX_ACTIONS, OWNER_LADDER, opsAlertsRef, type ActorRecord, type AlertActionRecord, type AlertRow, type AlertState } from "./model"

/**
 * The alert routes (audit F43, spec R6), under /api/platform/alerts on the `api` router (U-1: the only entry point to
 * the P5 operations):
 *
 * - GET listAlerts (`alert.read`): the partner worklist, the caller's firm only, newest `lastSeenAt` first, optional
 *   `state`, paginated.
 * - POST acknowledgeAlert, resolveAlert (`alert.ack`): a partner of the alert's firm, once the alert has escalated to
 *   the partners (level 1 or above); at level 0 it is the operator's (403 `alert_not_owner`).
 * - POST operatorAlertAction (firmless, `platformAdmin` claim): the named operator, at any level.
 *
 * `alert.read` and `alert.ack` are rows of the shared P5 table (partner only). Another firm's alert, or none, is 404
 * `not_found`. A transition, its `actions` record and the call's audit row commit in one transaction. No note is
 * taken: an alert carries no text a person wrote (spec R2).
 */

/** An alert as a route answers it: references, codes, counts and times; never the firm id of another firm. */
export type AlertView = {
  alertId: string
  condition: string
  subjectKey: string
  ref: string | null
  detail: Record<string, string | number>
  severity: string
  state: string
  level: number
  ownerRole: string
  episode: number
  count: number
  totalCount: number
  firstSeenAt: string | null
  lastSeenAt: string | null
  escalateAt: string | null
  acknowledgedAt: string | null
  acknowledgedBy: ActorRecord | null
  resolvedAt: string | null
  resolvedBy: ActorRecord | null
  /** Spec R22: when the checker stopped observing this derived condition (it no longer escalates), or null. */
  clearedAt: string | null
}

const iso = (t: unknown): string | null => (t instanceof Timestamp ? t.toDate().toISOString() : null)

export function alertView(id: string, a: DocumentData): AlertView {
  return {
    alertId: id,
    condition: a.condition,
    subjectKey: a.subjectKey,
    ref: a.ref ?? null,
    detail: a.detail ?? {},
    severity: a.severity,
    state: a.state,
    level: a.level,
    ownerRole: a.ownerRole,
    episode: a.episode,
    count: a.count,
    totalCount: a.totalCount,
    firstSeenAt: iso(a.firstSeenAt),
    lastSeenAt: iso(a.lastSeenAt),
    escalateAt: iso(a.escalateAt),
    acknowledgedAt: iso(a.acknowledgedAt),
    acknowledgedBy: a.acknowledgedBy ?? null,
    resolvedAt: iso(a.resolvedAt),
    resolvedBy: a.resolvedBy ?? null,
    clearedAt: iso(a.clearedAt),
  }
}

const badQuery = () => new HttpError(400, "invalid_query")
const notFound = () => new HttpError(404, "not_found")

function parseState(value: unknown): AlertState | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !(ALERT_STATES as readonly string[]).includes(value)) throw badQuery()
  return value as AlertState
}

function parseAfter(cursor: string | null): { lastSeenAt: Timestamp; id: string } | null {
  if (cursor === null) return null
  const { sortKey, id } = decodeCursor(cursor)
  const parts = sortKey.split(".")
  const [seconds, nanos] = parts.map(Number)
  if (parts.length !== 2 || !Number.isInteger(seconds) || !Number.isInteger(nanos) || nanos < 0 || nanos >= 1e9 || !isSafeDocId(id)) {
    throw new HttpError(400, "invalid_cursor")
  }
  try {
    return { lastSeenAt: new Timestamp(seconds, nanos), id }
  } catch {
    throw new HttpError(400, "invalid_cursor")
  }
}

/** listAlerts(?state&limit&cursor) → { items, nextCursor }: the firm's partner worklist. */
export const listAlertsOp: FirmOperation<Page<AlertView>> = {
  auth: "firm",
  kind: "general",
  action: "alert.read",
  target: "ops_alerts",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    await requirePermission(caller, "alert.read")
    const state = parseState(data.state)
    const { limit, cursor } = parsePage(data)
    const after = parseAfter(cursor)
    let q = opsAlertsRef().where("firmId", "==", caller.firmId)
    if (state !== undefined) q = q.where("state", "==", state)
    q = q.orderBy("lastSeenAt", "desc").orderBy(FieldPath.documentId(), "desc")
    const snap = await (after ? q.startAfter(after.lastSeenAt, after.id) : q).limit(limit + 1).get()
    const docs = snap.docs.slice(0, limit)
    const last = docs[docs.length - 1]
    const lastSeen: unknown = last?.get("lastSeenAt")
    await audit.allow()
    return {
      items: docs.map((d) => alertView(d.id, d.data())),
      nextCursor: snap.size > limit && lastSeen instanceof Timestamp ? encodeCursor(`${lastSeen.seconds}.${lastSeen.nanoseconds}`, last.id) : null,
    }
  },
}

type Actor = { uid: string; role: "operator" | "partner" }
type Act = "acknowledge" | "resolve"

function parseAlertId(data: Data): string {
  if (!isSafeDocId(data.alertId)) throw badQuery()
  return data.alertId
}

/**
 * The transition `act` on alert `alertId` by `actor`, in one transaction with the call's audit row. `firmId`: the
 * caller's firm (a firm route), or null for the operator. The owner rule (spec R6): the operator acts at any level; a
 * partner from level 1 (the partners' rung of `OWNER_LADDER`).
 */
async function transition(alertId: string, act: Act, actor: Actor, firmId: string | null, nowMs: number, audit: CallAudit): Promise<AlertView> {
  const ref = opsAlertsRef().doc(alertId)
  const view = await adminDb().runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data() as AlertRow | undefined
    if (!row || (firmId !== null && row.firmId !== firmId)) throw notFound()
    audit.firmId = row.firmId
    if (actor.role === "partner" && row.level < OWNER_LADDER.indexOf("partner")) throw new HttpError(403, "alert_not_owner")
    if (row.state === "resolved") throw new HttpError(409, "alert_resolved")
    if (act === "acknowledge" && row.state === "acknowledged") throw new HttpError(409, "alert_already_acknowledged")
    const at = Timestamp.fromMillis(nowMs)
    const record: AlertActionRecord = { action: act, by: actor.uid, role: actor.role, level: row.level, at }
    const actions = [...(Array.isArray(row.actions) ? row.actions : []), record].slice(-MAX_ACTIONS)
    const who: ActorRecord = { uid: actor.uid, role: actor.role }
    const update =
      act === "acknowledge"
        ? { state: "acknowledged" as const, escalateAt: null, acknowledgedAt: at, acknowledgedBy: who, actions, updatedAt: at }
        : { state: "resolved" as const, escalateAt: null, resolvedAt: at, resolvedBy: who, actions, updatedAt: at }
    await audit.stage(tx, "allow", act)
    tx.update(ref, update)
    return alertView(alertId, { ...row, ...update })
  })
  audit.committed()
  return view
}

const nowOf = (session: Session): number => session.now ?? Date.now()

/** A partner's acknowledge or resolve: `alert.ack` (the shared table), then the transition in the caller's firm. */
async function partnerTransition(session: Session, data: Data, audit: CallAudit, act: Act): Promise<AlertView> {
  const { caller } = session
  audit.firmId = caller.firmId
  audit.target = `firms/${caller.firmId}`
  await requirePermission(caller, "alert.ack")
  const alertId = parseAlertId(data)
  audit.target = `ops_alerts/${alertId}`
  return transition(alertId, act, { uid: caller.uid, role: "partner" }, caller.firmId, nowOf(session), audit)
}

/** acknowledgeAlert({ alertId }) → the alert's view: stops its escalation. */
export const acknowledgeAlertOp: FirmOperation<AlertView> = {
  auth: "firm",
  kind: "general",
  action: "alert.acknowledge",
  target: "ops_alerts",
  run: async (session, data, audit) => partnerTransition(session, data, audit, "acknowledge"),
}

/** resolveAlert({ alertId }) → the alert's view: closes it; a later raise reopens it as a new episode. */
export const resolveAlertOp: FirmOperation<AlertView> = {
  auth: "firm",
  kind: "general",
  action: "alert.resolve",
  target: "ops_alerts",
  run: async (session, data, audit) => partnerTransition(session, data, audit, "resolve"),
}

/**
 * operatorAlertAction({ alertId, action: "acknowledge" | "resolve" }) → the alert's view. The named operator's route:
 * platform admin only (`platformAdmin: true` in the caller's current custom claims; 403 platform_admin_only), checked
 * before the body. Firmless, like setPlatformAiKillSwitch; the audit row is written to the alert's firm.
 */
export const operatorAlertActionOp: FirmlessOperation<AlertView> = {
  auth: "firmless",
  kind: "general",
  action: "alert.operator_action",
  target: "ops_alerts",
  run: async ({ uid, claims }, data, audit) => {
    if (claims.platformAdmin !== true) throw new HttpError(403, "platform_admin_only")
    const alertId = parseAlertId(data)
    if (data.action !== "acknowledge" && data.action !== "resolve") throw badQuery()
    audit.target = `ops_alerts/${alertId}`
    return transition(alertId, data.action, { uid, role: "operator" }, null, (alertOpsTestSeam.now ?? Date.now)(), audit)
  },
}

/** Test seam (spec §6): the operator route's clock (a firmless route gets no router clock). Set in a test, deleted after. */
export const alertOpsTestSeam: { now?: () => number } = {}
