import { Timestamp, type DocumentReference, type Transaction } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { adminDb } from "../admin"
import { errorCode } from "../log"
import { ACK_WINDOW_MS, alertIdFor, assertSafeDetail, maxSeverity, opsAlertsRef, type AlertRow, type AlertSpec } from "./model"
import { stagePage } from "./notifier"

/**
 * Raising an alert (audit F43, spec R3). A raise reads the alert in the caller's transaction (`prepareAlert`, with the
 * caller's other reads) and then writes it (`stageAlert`, with the caller's other writes), so the alert commits if and
 * only if the caller's state change does:
 *
 * - none yet: created `open` at level 0 (owner `operator`), with its acknowledgment deadline and one level-0 page;
 * - `open` or `acknowledged`: counted (`count`, `totalCount`, `lastSeenAt`, the latest `ref` and `detail`); severity
 *   only rises; no page (one page per episode and level: the dedupe);
 * - `resolved`: reopened as a new episode at level 0, acknowledgment and resolution cleared, with a new page.
 */

export type PreparedAlert = { spec: AlertSpec; id: string; ref: DocumentReference; current: AlertRow | undefined }

const SUBJECT_KEY = /^[A-Za-z]+:[A-Za-z0-9_.:/-]{1,200}$/
const REF = /^[A-Za-z0-9_]+\/[A-Za-z0-9_.:-]{1,150}$/

function assertSpec(spec: AlertSpec): void {
  if (typeof spec.firmId !== "string" || spec.firmId === "" || spec.firmId.length > 128 || spec.firmId.includes("/")) throw new Error("alert: invalid firmId")
  if (!SUBJECT_KEY.test(spec.subjectKey)) throw new Error("alert: invalid subjectKey")
  if (spec.ref !== null && !REF.test(spec.ref)) throw new Error("alert: invalid ref")
  assertSafeDetail(spec.detail)
}

/** Reads the alerts `specs` raise, in `tx` (call it with the transaction's other reads, before any write). */
export async function prepareAlerts(tx: Transaction, specs: readonly AlertSpec[]): Promise<PreparedAlert[]> {
  if (specs.length === 0) return []
  for (const spec of specs) assertSpec(spec)
  const ids = specs.map((s) => alertIdFor(s.condition, s.firmId, s.subjectKey))
  if (new Set(ids).size !== ids.length) throw new Error("alert: one alert raised twice in one transaction")
  const refs = ids.map((id) => opsAlertsRef().doc(id))
  const snaps = await tx.getAll(...refs)
  return specs.map((spec, i) => ({ spec, id: ids[i], ref: refs[i], current: snaps[i].exists ? (snaps[i].data() as AlertRow) : undefined }))
}

export async function prepareAlert(tx: Transaction, spec: AlertSpec): Promise<PreparedAlert> {
  return (await prepareAlerts(tx, [spec]))[0]
}

export type StagedAlert = "opened" | "reopened" | "counted"

/** Writes a prepared alert in `tx` at `nowMs` (writes only). */
export function stageAlert(tx: Transaction, prepared: PreparedAlert, nowMs: number): StagedAlert {
  const { spec, current, ref } = prepared
  const at = Timestamp.fromMillis(nowMs)
  if (current === undefined || current.state === "resolved") {
    const row: AlertRow = {
      schemaVersion: 1,
      condition: spec.condition,
      firmId: spec.firmId,
      subjectKey: spec.subjectKey,
      ref: spec.ref,
      detail: { ...spec.detail },
      baseSeverity: spec.severity,
      severity: spec.severity,
      state: "open",
      level: 0,
      ownerRole: "operator",
      episode: current === undefined ? 1 : current.episode + 1,
      count: 1,
      totalCount: (current?.totalCount ?? 0) + 1,
      firstSeenAt: at,
      lastSeenAt: at,
      escalateAt: Timestamp.fromMillis(nowMs + ACK_WINDOW_MS[spec.severity]),
      escalations: [],
      actions: Array.isArray(current?.actions) ? current.actions : [],
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      resolvedBy: null,
      createdAt: current?.createdAt ?? at,
      updatedAt: at,
    }
    tx.set(ref, row)
    stagePage(tx, prepared.id, row, 0, "operator", [{ kind: "oncall" }], nowMs)
    return current === undefined ? "opened" : "reopened"
  }
  tx.update(ref, {
    count: current.count + 1,
    totalCount: current.totalCount + 1,
    lastSeenAt: at,
    ref: spec.ref,
    detail: { ...spec.detail },
    severity: maxSeverity(current.severity, spec.severity),
    updatedAt: at,
  })
  return "counted"
}

/** Raises one alert in a transaction of its own (a condition derived by a scheduled pass, or a failed commit's). */
export async function raiseAlert(spec: AlertSpec, nowMs: number): Promise<{ id: string; staged: StagedAlert }> {
  return adminDb().runTransaction(async (tx) => {
    const prepared = await prepareAlert(tx, spec)
    return { id: prepared.id, staged: stageAlert(tx, prepared, nowMs) }
  })
}

/** How long a best-effort raise may take before the caller goes on without it. */
export const BEST_EFFORT_RAISE_MS = 5_000

/**
 * `raiseAlert`, bounded to `BEST_EFFORT_RAISE_MS` and never throwing: a failure is logged `ops_alert.raise_failed` at
 * ERROR (a registered policy), so even a store outage that defeats the durable record is announced. Returns the
 * alert id, or null when it was not raised.
 */
export async function raiseAlertBestEffort(spec: AlertSpec, nowMs: number): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("alert raise timed out"), { code: "raise_timeout" })), BEST_EFFORT_RAISE_MS)
  })
  try {
    return (await Promise.race([raiseAlert(spec, nowMs), timeout])).id
  } catch (err) {
    logger.error("ops_alert.raise_failed", { condition: spec.condition, firmId: spec.firmId, subjectKey: spec.subjectKey, code: errorCode(err) })
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** A detail string: the value when it is a code or id the guard accepts, else `"unknown"` (never breaks a raise). */
export function detailText(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,128}$/.test(value) ? value : "unknown"
}

/** A detail integer: the value when it is a safe integer, else -1. */
export function detailInt(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : -1
}
