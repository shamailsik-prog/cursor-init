import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../../admin"
import { HttpError } from "../../http/errors"
import type { Caller } from "../../p5/auth"
import { isKnownClassification, rankOf } from "../../p5/classification"
import { isSafeDocId } from "../../p5/common"
import { parseName } from "../validate"
import { normaliseCnic, normalisePhone } from "../conflict/normalise"
import { isClientType, keywordIntakeClassifier } from "./classify"
import { intakeEnabled } from "./flag"
import { promoteIntake } from "./promote"
import { routeByRules } from "./route"
import { insertIntake, listFirmIntakes, listMessages, patchIntake, readIntake, type IntakeWrite } from "./store"
import type { ClassifyOutput, CreateIntakeInput, IntakeClassifier, IntakeMessage, IntakeRecord, OpposingParty, PromoteResult, Prospect, RouteRule } from "./types"

/**
 * Module 5 client intake. Handlers are module functions; wave 2 wires routes.
 * The flag is checked before any store read. Firm id comes from the caller.
 */

const STAFF = new Set(["partner", "associate", "clerk", "intern"])
const LAWYERS = new Set(["partner", "associate"])
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function assertEnabled(): void {
  if (!intakeEnabled()) throw new HttpError(404, "feature_disabled")
}

const invalid = () => new HttpError(400, "invalid_subjects")

async function assertStaff(caller: Caller): Promise<void> {
  assertEnabled()
  const row = (await adminDb().collection("users").doc(caller.uid).get()).data()
  if (!row || row.firmId !== caller.firmId || row.active !== true || row.role !== caller.role || !STAFF.has(caller.role)) {
    throw new HttpError(403, "role_not_permitted")
  }
}

function assertConfirmation(caller: Caller, confirmation: { confirmedBy?: string }): void {
  if (confirmation.confirmedBy !== caller.uid || !LAWYERS.has(caller.role)) throw new HttpError(400, "confirmation_required")
}

async function load(caller: Caller, intakeId: string): Promise<IntakeRecord> {
  if (!isSafeDocId(intakeId)) throw new HttpError(404, "not_found")
  const row = await readIntake(caller.firmId, intakeId, caller.clearanceLevel)
  if (!row) throw new HttpError(404, "not_found")
  return row
}

function optionalPhone(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string") throw invalid()
  const phone = normalisePhone(value)
  if (!phone) throw invalid()
  return phone
}

function optionalEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string") throw invalid()
  const email = value.trim()
  if (!EMAIL.test(email) || email.length > 254) throw invalid()
  return email
}

function opposingOf(value: unknown): OpposingParty[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 20) throw invalid()
  return value.map((party) => {
    if (!party || typeof party !== "object" || Array.isArray(party)) throw invalid()
    const name = parseName((party as { name?: unknown }).name)
    const raw = (party as { cnic?: unknown }).cnic
    if (raw === undefined || raw === null || raw === "") return { name }
    if (typeof raw !== "string") throw invalid()
    const cnic = normaliseCnic(raw)
    if (!cnic) throw invalid()
    return { name, cnic }
  })
}

function classificationOf(value: unknown, caller: Caller): Classification {
  if (value === undefined) return "confidential"
  if (!isKnownClassification(value)) throw invalid()
  if (rankOf(value) > rankOf(caller.clearanceLevel)) throw new HttpError(403, "exceeds_own_clearance")
  return value
}

function courtRefOf(value: CreateIntakeInput["courtRef"]): { raw: string; courtId: string } | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value.raw !== "string" || typeof value.courtId !== "string") throw invalid()
  const raw = value.raw.trim()
  const courtId = value.courtId.trim()
  if (raw.length < 1 || raw.length > 300 || courtId.length < 1 || courtId.length > 100) throw invalid()
  return { raw, courtId }
}

function textOf(value: unknown): string {
  if (typeof value !== "string") throw invalid()
  const text = value.trim()
  if (text.length < 1 || text.length > 4000) throw invalid()
  return text
}

function apply(text: string, prospect: Prospect, courtRef: { raw: string; courtId: string } | undefined, classifier: IntakeClassifier): ClassifyOutput {
  return classifier.classify({ text, prospectName: prospect.name, prospectType: prospect.type, ...(courtRef ? { courtRef } : {}) })
}

function withClassification(intake: IntakeRecord, output: ClassifyOutput, status: IntakeRecord["status"]): IntakeWrite {
  return {
    firmId: intake.firmId,
    classification: intake.classification,
    matterId: intake.matterId,
    clientId: intake.clientId,
    conflictCheckId: intake.conflictCheckId,
    status,
    practiceArea: output.practiceArea,
    urgency: output.urgency,
    followUp: output.followUp,
    followUpReasons: output.followUpReasons,
    assigneeId: intake.assigneeId,
    queue: intake.queue,
    text: intake.text,
    prospect: { ...intake.prospect, type: output.prospectType },
    court: output.court,
    waiver: intake.waiver,
    confirmedBy: intake.confirmedBy,
    closeReason: intake.closeReason,
    createdBy: intake.createdBy,
  }
}

export async function createIntake(caller: Caller, input: CreateIntakeInput, classifier: IntakeClassifier = keywordIntakeClassifier): Promise<IntakeRecord> {
  assertEnabled()
  await assertStaff(caller)
  const text = textOf(input.text)
  const suppliedType = input.prospect?.type
  if (suppliedType !== undefined && !isClientType(suppliedType)) throw invalid()
  const draft: Prospect = {
    name: parseName(input.prospect?.name),
    phone: optionalPhone(input.prospect?.phone),
    email: optionalEmail(input.prospect?.email),
    type: suppliedType ?? null,
    opposingParties: opposingOf(input.prospect?.opposingParties),
  }
  const courtRef = courtRefOf(input.courtRef)
  const output = apply(text, draft, courtRef, classifier)
  const row: IntakeWrite = {
    firmId: caller.firmId,
    classification: classificationOf(input.classification, caller),
    matterId: null,
    clientId: null,
    conflictCheckId: null,
    status: output.followUp ? "follow_up" : "open",
    practiceArea: output.practiceArea,
    urgency: output.urgency,
    followUp: output.followUp,
    followUpReasons: output.followUpReasons,
    assigneeId: null,
    queue: null,
    text,
    prospect: { ...draft, type: output.prospectType },
    court: output.court,
    waiver: null,
    confirmedBy: null,
    closeReason: null,
    createdBy: caller.uid,
  }
  return insertIntake(row, text)
}

export async function listIntakes(caller: Caller): Promise<{ items: IntakeRecord[] }> {
  assertEnabled()
  await assertStaff(caller)
  return { items: await listFirmIntakes(caller.firmId, caller.clearanceLevel) }
}

export async function getIntakeThread(caller: Caller, intakeId: string): Promise<{ intake: IntakeRecord; messages: IntakeMessage[] }> {
  assertEnabled()
  await assertStaff(caller)
  const intake = await load(caller, intakeId)
  return { intake, messages: await listMessages(caller.firmId, intake.intakeId) }
}

export async function classifyIntake(caller: Caller, intakeId: string, classifier: IntakeClassifier = keywordIntakeClassifier): Promise<IntakeRecord> {
  assertEnabled()
  await assertStaff(caller)
  const intake = await load(caller, intakeId)
  if (intake.status === "closed") throw new HttpError(409, "intake_closed")
  if (intake.status === "promoted") throw new HttpError(409, "already_promoted")
  const courtRef = intake.court ? { raw: intake.court.raw, courtId: intake.court.courtId } : undefined
  const output = apply(intake.text, intake.prospect, courtRef, classifier)
  return patchIntake(caller.firmId, intake.intakeId, caller.clearanceLevel, withClassification(intake, output, output.followUp ? "follow_up" : "open"))
}

async function lawyerAssignees(firmId: string, rules: readonly RouteRule[]): Promise<RouteRule[]> {
  const ids = [...new Set(rules.map((rule) => rule.assigneeId))].filter((id) => isSafeDocId(id))
  if (ids.length === 0) return []
  const docs = await adminDb().getAll(...ids.map((id) => adminDb().collection("users").doc(id)))
  const lawyers = new Set<string>()
  docs.forEach((doc, index) => {
    const row = doc.data()
    if (!row || row.firmId !== firmId || row.active !== true) return
    if (row.role === "partner" || row.role === "associate") lawyers.add(ids[index]!)
  })
  return rules.filter((rule) => lawyers.has(rule.assigneeId))
}

export async function routeIntake(caller: Caller, intakeId: string, rules: readonly RouteRule[]): Promise<IntakeRecord> {
  assertEnabled()
  await assertStaff(caller)
  if (!Array.isArray(rules) || rules.some((rule) => !rule || typeof rule.practiceArea !== "string" || typeof rule.assigneeId !== "string")) throw invalid()
  const intake = await load(caller, intakeId)
  if (intake.status === "closed") throw new HttpError(409, "intake_closed")
  if (intake.status === "promoted") throw new HttpError(409, "already_promoted")
  const decision = routeByRules({ practiceArea: intake.practiceArea, followUp: intake.followUp }, await lawyerAssignees(caller.firmId, rules))
  return patchIntake(caller.firmId, intake.intakeId, caller.clearanceLevel, {
    status: decision.queue === "lawyer" ? "routed" : "follow_up",
    queue: decision.queue,
    assigneeId: decision.assigneeId,
  })
}

export async function closeIntake(caller: Caller, intakeId: string, reason?: string): Promise<IntakeRecord> {
  assertEnabled()
  await assertStaff(caller)
  const intake = await load(caller, intakeId)
  if (intake.status === "promoted") throw new HttpError(409, "already_promoted")
  if (intake.status === "closed") return intake
  let closeReason: string | null = null
  if (reason !== undefined) {
    if (typeof reason !== "string") throw invalid()
    closeReason = reason.trim()
    if (closeReason.length > 500) throw invalid()
    if (closeReason === "") closeReason = null
  }
  return patchIntake(caller.firmId, intake.intakeId, caller.clearanceLevel, { status: "closed", closeReason, queue: null, assigneeId: null })
}

export async function promoteToClient(caller: Caller, intakeId: string, confirmation: { confirmedBy?: string } = {}): Promise<PromoteResult> {
  assertEnabled()
  assertConfirmation(caller, confirmation)
  await assertStaff(caller)
  if (!LAWYERS.has(caller.role)) throw new HttpError(400, "confirmation_required")
  const intake = await load(caller, intakeId)
  return promoteIntake(caller, intake)
}

export { IntakeRefusal } from "./promote"
export type { IntakeClassifier, IntakeRecord, PromoteResult, RouteRule }
