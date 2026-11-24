import type { DocumentData } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../../admin"
import { HttpError } from "../../http/errors"
import { CallAudit, runAudited, type FirmOperation } from "../../p5/common"
import type { Caller } from "../../p5/auth"
import { isKnownClassification, rankOf } from "../../p5/classification"
import { isSafeDocId } from "../../p5/common"
import { registerClientOp, type RegisterResult } from "../client/ops"
import { maxLabel } from "../conflict/engine"
import { runConflictCheckOp } from "../conflict/ops"
import type { Waiver } from "../conflict/disclosure"
import { openMatterOp } from "../matter/ops"
import { patchIntake, stampMessageMatter } from "./store"
import type { IntakeRecord, PromoteResult, WaiverRef } from "./types"

/**
 * Promotion runs the existing Module 6 check before any client or matter write.
 * A FLAG (or an unresolved review) blocks until the existing waiver path clears
 * it. The check is the one openMatter binds. openMatter requires the client
 * subject to carry a clientId, and a name-only check cannot, so once the check
 * is cleared the client is registered and that id is added to the subject.
 * The hits, the result and the waiver are left as the conflict module wrote them.
 * A replay returns the same client and matter.
 */

export class IntakeRefusal extends HttpError {
  readonly conflictCheckId?: string

  constructor(status: number, code: string, conflictCheckId?: string) {
    super(status, code)
    this.name = "IntakeRefusal"
    this.conflictCheckId = conflictCheckId
  }
}

async function callFirm<T>(op: FirmOperation<T>, caller: Caller, data: Record<string, unknown>): Promise<T> {
  const audit = new CallAudit(op.action, caller.uid, op.target)
  // MFA is enforced by the router (wave 2). These operations do not read the factor.
  return runAudited(audit, () => op.run({ caller, secondFactor: false }, data, audit))
}

function recordedWaiver(raw: unknown): Waiver | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  if (typeof row.partnerId !== "string" || typeof row.note !== "string" || typeof row.consentReference !== "string" || typeof row.at !== "string" || row.clientConsent !== true) {
    return null
  }
  return { partnerId: row.partnerId, note: row.note, clientConsent: true, consentReference: row.consentReference, at: row.at }
}

/** Cleared the way openMatter accepts a check: CLEAR, or FLAG with a recorded waiver. */
function promotable(row: DocumentData): { waiver: Waiver | null } | null {
  if (row.stale === true || row.firmId === undefined) return null
  if (row.decision === "cleared" && row.result === "CLEAR") return { waiver: null }
  const waiver = recordedWaiver(row.waiver)
  if (row.decision === "cleared" && row.result === "FLAG" && waiver) return { waiver }
  return null
}

function waiverRef(checkId: string, waiver: Waiver | null): WaiverRef | null {
  if (!waiver) return null
  return { checkId, partnerId: waiver.partnerId, consentReference: waiver.consentReference, note: waiver.note, at: waiver.at }
}

function resultOf(intake: IntakeRecord, clientId: string, matterId: string, checkId: string, waiver: WaiverRef | null): PromoteResult {
  return { intakeId: intake.intakeId, clientId, matterId, conflictCheckId: checkId, waiver }
}

async function loadCheck(checkId: string, firmId: string): Promise<DocumentData> {
  const row = (await adminDb().collection("conflict_checks").doc(checkId).get()).data()
  if (!row || row.firmId !== firmId) throw new IntakeRefusal(409, "conflict_blocked", checkId)
  return row
}

async function remember(caller: Caller, intake: IntakeRecord, checkId: string): Promise<void> {
  if (intake.conflictCheckId === checkId) return
  await patchIntake(intake.firmId, intake.intakeId, caller.clearanceLevel, { conflictCheckId: checkId })
}

/**
 * openMatter reads `subjects[0].clientId`. The pre-registration check has none.
 * Adding that one field does not change the name, the keys, the hits or the waiver.
 */
async function attachClientId(checkId: string, clientId: string, subjects: unknown): Promise<void> {
  if (!Array.isArray(subjects) || subjects.length < 1) throw new IntakeRefusal(409, "conflict_blocked", checkId)
  const first = subjects[0]
  if (!first || typeof first !== "object" || (first as { role?: unknown }).role !== "client") throw new IntakeRefusal(409, "conflict_blocked", checkId)
  const current = (first as { clientId?: unknown }).clientId
  if (current === clientId) return
  if (current !== undefined) throw new IntakeRefusal(409, "conflict_blocked", checkId)
  const next = subjects.map((subject, index) => (index === 0 && subject && typeof subject === "object" ? { ...subject, clientId } : subject))
  await adminDb().collection("conflict_checks").doc(checkId).update({ subjects: next })
}

async function matterForCheck(firmId: string, checkId: string): Promise<{ matterId: string; clientId: string } | null> {
  const snap = await adminDb().collection("matters").where("conflictCheckId", "==", checkId).get()
  for (const doc of snap.docs) {
    const data = doc.data()
    if (data.firmId === firmId && typeof data.clientId === "string") return { matterId: doc.id, clientId: data.clientId }
  }
  return null
}

async function openOrFind(caller: Caller, checkId: string, title: string, classification: Classification, courtId: string | undefined): Promise<{ matterId: string; clientId: string }> {
  const data: Record<string, unknown> = { conflictCheckId: checkId, title, classification }
  if (courtId !== undefined) data.courtId = courtId
  try {
    const opened = await callFirm(openMatterOp, caller, data)
    const matterId = opened.matterId
    const clientId = opened.clientId
    if (typeof matterId !== "string" || typeof clientId !== "string") throw new HttpError(500, "internal")
    return { matterId, clientId }
  } catch (err) {
    if (err instanceof HttpError && err.code === "check_already_bound") {
      const existing = await matterForCheck(caller.firmId, checkId)
      if (existing) return existing
    }
    throw err
  }
}

async function finish(intake: IntakeRecord, caller: Caller, clientId: string, matterId: string, checkId: string, waiver: Waiver | null, label: Classification): Promise<PromoteResult> {
  const ref = waiverRef(checkId, waiver)
  const saved = await patchIntake(intake.firmId, intake.intakeId, caller.clearanceLevel, {
    status: "promoted",
    classification: label,
    clientId,
    matterId,
    conflictCheckId: checkId,
    confirmedBy: caller.uid,
    waiver: ref,
    followUp: false,
  })
  await stampMessageMatter(intake.firmId, intake.intakeId, matterId)
  return resultOf(saved, clientId, matterId, checkId, ref)
}

function labelFor(intake: IntakeRecord, check: DocumentData, caller: Caller): Classification {
  const checkLabel = isKnownClassification(check.classification) ? check.classification : "privileged-restricted"
  const label = maxLabel(intake.classification, checkLabel)
  if (rankOf(label) > rankOf(caller.clearanceLevel)) throw new HttpError(403, "exceeds_own_clearance")
  return label
}

export async function promoteIntake(caller: Caller, intake: IntakeRecord): Promise<PromoteResult> {
  if (intake.status === "closed") throw new HttpError(409, "intake_closed")
  if (intake.status === "promoted" && intake.clientId && intake.matterId && intake.conflictCheckId) {
    await stampMessageMatter(intake.firmId, intake.intakeId, intake.matterId)
    return resultOf(intake, intake.clientId, intake.matterId, intake.conflictCheckId, intake.waiver)
  }
  if (rankOf(intake.classification) > rankOf(caller.clearanceLevel)) throw new HttpError(403, "exceeds_own_clearance")
  if (intake.prospect.type === null) throw new HttpError(409, "follow_up_required")
  if (!intake.prospect.phone) throw new HttpError(400, "invalid_subjects")
  if (intake.prospect.opposingParties.length < 1) throw new HttpError(409, "opposing_required")

  let checkId = intake.conflictCheckId
  if (!checkId) {
    const keys: Record<string, string> = { phone: intake.prospect.phone }
    const screened = await callFirm(runConflictCheckOp, caller, {
      client: { name: intake.prospect.name, keys },
      opposingParties: intake.prospect.opposingParties.map((party) => (party.cnic ? { name: party.name, keys: { cnic: party.cnic } } : { name: party.name })),
    })
    checkId = screened.checkId
    await remember(caller, intake, checkId)
  }
  if (!isSafeDocId(checkId)) throw new IntakeRefusal(409, "conflict_blocked")

  const row = await loadCheck(checkId, caller.firmId)
  const bound = typeof row.boundMatterId === "string" ? row.boundMatterId : ""
  if (bound) {
    const existing = await matterForCheck(caller.firmId, checkId)
    if (!existing) throw new IntakeRefusal(409, "conflict_blocked", checkId)
    const cleared = promotable(row) ?? { waiver: recordedWaiver(row.waiver) }
    return finish(intake, caller, existing.clientId, existing.matterId, checkId, cleared.waiver, labelFor(intake, row, caller))
  }

  const cleared = promotable(row)
  if (!cleared) throw new IntakeRefusal(409, "conflict_blocked", checkId)

  const label = labelFor(intake, row, caller)
  let clientId = intake.clientId
  if (!clientId) {
    const registered: RegisterResult = await callFirm(registerClientOp, caller, {
      name: intake.prospect.name,
      type: intake.prospect.type,
      primaryMobile: intake.prospect.phone,
      classification: label,
      ...(intake.prospect.type === "company" ? { companyName: intake.prospect.name } : {}),
      ...(intake.prospect.email ? { email: intake.prospect.email } : {}),
    })
    clientId = registered.clientId
    await patchIntake(intake.firmId, intake.intakeId, caller.clearanceLevel, { clientId, conflictCheckId: checkId })
  }

  await attachClientId(checkId, clientId, row.subjects)
  const courtId = intake.court?.status === "ok" ? intake.court.courtId : undefined
  const opened = await openOrFind(caller, checkId, intake.prospect.name, label, courtId)
  return finish(intake, caller, opened.clientId, opened.matterId, checkId, cleared.waiver, label)
}
