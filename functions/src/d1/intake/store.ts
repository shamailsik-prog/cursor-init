import { FieldValue, Timestamp, type DocumentData } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../../admin"
import { HttpError } from "../../http/errors"
import { isKnownClassification, rankOf } from "../../p5/classification"
import { intakeEnabled } from "./flag"
import type { CourtView, FollowUpReason, IntakeMessage, IntakeRecord, IntakeStatus, Prospect, Urgency, WaiverRef } from "./types"
import { INTAKE_STATUSES, URGENCIES } from "./types"
import { isClientType } from "./classify"

/**
 * Firm-scoped reads and writes for `intakes` and `intake_messages`.
 * Both collections are inventoried by W1-INV; this module does not edit retention.
 * Every call re-checks the flag before touching the store.
 */

const intakes = () => adminDb().collection("intakes")
const messages = () => adminDb().collection("intake_messages")

function assertEnabled(): void {
  if (!intakeEnabled()) throw new HttpError(404, "feature_disabled")
}

const iso = (value: unknown): string | null => (value instanceof Timestamp ? value.toDate().toISOString() : null)

function isStatus(value: unknown): value is IntakeStatus {
  return typeof value === "string" && (INTAKE_STATUSES as readonly string[]).includes(value)
}

function isUrgency(value: unknown): value is Urgency {
  return typeof value === "string" && (URGENCIES as readonly string[]).includes(value)
}

function isReason(value: unknown): value is FollowUpReason {
  return value === "ambiguous_court_prefix" || value === "unknown_court_prefix" || value === "ambiguous_entity"
}

function prospectOf(raw: unknown): Prospect | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  if (typeof row.name !== "string" || row.name === "") return null
  if (row.phone !== null && typeof row.phone !== "string") return null
  if (row.email !== null && typeof row.email !== "string") return null
  if (row.type !== null && !isClientType(row.type)) return null
  if (!Array.isArray(row.opposingParties)) return null
  const opposingParties: Prospect["opposingParties"] = []
  for (const party of row.opposingParties) {
    if (!party || typeof party !== "object" || Array.isArray(party)) return null
    const name = (party as { name?: unknown }).name
    const cnic = (party as { cnic?: unknown }).cnic
    if (typeof name !== "string" || name === "") return null
    if (cnic !== undefined && typeof cnic !== "string") return null
    opposingParties.push(cnic === undefined ? { name } : { name, cnic })
  }
  return { name: row.name, phone: (row.phone as string | null) ?? null, email: (row.email as string | null) ?? null, type: row.type as Prospect["type"], opposingParties }
}

function courtOf(raw: unknown): CourtView | null | undefined {
  if (raw === null) return null
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  if (typeof row.raw !== "string" || typeof row.courtId !== "string") return undefined
  if (row.status !== "ok" && row.status !== "ambiguous" && row.status !== "rejected") return undefined
  const view: CourtView = { raw: row.raw, courtId: row.courtId, status: row.status }
  if (typeof row.prefix === "string") view.prefix = row.prefix
  if (row.status === "ok" && typeof row.canonical === "string") view.canonical = row.canonical
  return view
}

function waiverOf(raw: unknown): WaiverRef | null | undefined {
  if (raw === null) return null
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  if (typeof row.checkId !== "string" || typeof row.partnerId !== "string" || typeof row.consentReference !== "string" || typeof row.note !== "string" || typeof row.at !== "string") {
    return undefined
  }
  return { checkId: row.checkId, partnerId: row.partnerId, consentReference: row.consentReference, note: row.note, at: row.at }
}

/** The row as the caller's firm may see it. Another firm, or a missing row, is null (no existence leak). */
export function intakeFrom(id: string, firmId: string, data: DocumentData | undefined): IntakeRecord | null {
  if (!data || data.firmId !== firmId) return null
  const prospect = prospectOf(data.prospect)
  const court = courtOf(data.court)
  const waiver = waiverOf(data.waiver)
  const reasons = Array.isArray(data.followUpReasons) ? data.followUpReasons.filter(isReason) : []
  if (
    !isKnownClassification(data.classification) ||
    !isStatus(data.status) ||
    !isUrgency(data.urgency) ||
    typeof data.followUp !== "boolean" ||
    typeof data.text !== "string" ||
    typeof data.createdBy !== "string" ||
    !prospect ||
    court === undefined ||
    waiver === undefined ||
    (data.matterId !== null && typeof data.matterId !== "string") ||
    (data.clientId !== null && typeof data.clientId !== "string") ||
    (data.conflictCheckId !== null && typeof data.conflictCheckId !== "string") ||
    (data.assigneeId !== null && typeof data.assigneeId !== "string") ||
    (data.queue !== null && data.queue !== "lawyer" && data.queue !== "follow_up") ||
    (data.confirmedBy !== null && typeof data.confirmedBy !== "string") ||
    (data.closeReason !== null && typeof data.closeReason !== "string")
  ) {
    throw new HttpError(409, "intake_malformed")
  }
  return {
    intakeId: id,
    firmId,
    classification: data.classification,
    matterId: data.matterId,
    clientId: data.clientId,
    conflictCheckId: data.conflictCheckId,
    status: data.status,
    practiceArea: typeof data.practiceArea === "string" ? data.practiceArea : null,
    urgency: data.urgency,
    followUp: data.followUp,
    followUpReasons: reasons,
    assigneeId: data.assigneeId,
    queue: data.queue,
    text: data.text,
    prospect,
    court,
    waiver,
    confirmedBy: data.confirmedBy,
    closeReason: data.closeReason,
    createdBy: data.createdBy,
    createdAt: iso(data.createdAt),
  }
}

/** Above the caller's clearance is the same answer as a missing row. An unknown label fails closed. */
function withinClearance(data: DocumentData | undefined, clearance: Classification): boolean {
  return isKnownClassification(data?.classification) && rankOf(data.classification) <= rankOf(clearance)
}

export async function readIntake(firmId: string, intakeId: string, clearance: Classification): Promise<IntakeRecord | null> {
  assertEnabled()
  const data = (await intakes().doc(intakeId).get()).data()
  if (!data || data.firmId !== firmId || !withinClearance(data, clearance)) return null
  return intakeFrom(intakeId, firmId, data)
}

export async function listFirmIntakes(firmId: string, clearance: Classification): Promise<IntakeRecord[]> {
  assertEnabled()
  const snap = await intakes().where("firmId", "==", firmId).get()
  const items: IntakeRecord[] = []
  for (const doc of snap.docs) {
    const data = doc.data()
    if (!withinClearance(data, clearance)) continue
    const row = intakeFrom(doc.id, firmId, data)
    if (row) items.push(row)
  }
  items.sort((a, b) => {
    const at = (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
    return at !== 0 ? at : (a.intakeId < b.intakeId ? 1 : -1)
  })
  return items
}

export type IntakeWrite = Omit<IntakeRecord, "intakeId" | "createdAt">

export async function insertIntake(row: IntakeWrite, messageText: string): Promise<IntakeRecord> {
  assertEnabled()
  const ref = intakes().doc()
  const message = messages().doc()
  const db = adminDb()
  const body = JSON.parse(JSON.stringify(row)) as IntakeWrite
  await db.runTransaction(async (tx) => {
    tx.create(ref, { ...body, createdAt: FieldValue.serverTimestamp() })
    tx.create(message, {
      firmId: row.firmId,
      intakeId: ref.id,
      direction: "inbound",
      text: messageText,
      createdAt: FieldValue.serverTimestamp(),
    })
  })
  const stored = await readIntake(row.firmId, ref.id, row.classification)
  if (!stored) throw new HttpError(500, "internal")
  return stored
}

export async function patchIntake(firmId: string, intakeId: string, clearance: Classification, patch: Partial<IntakeWrite>): Promise<IntakeRecord> {
  assertEnabled()
  const current = await readIntake(firmId, intakeId, clearance)
  if (!current) throw new HttpError(404, "not_found")
  await intakes().doc(intakeId).update(JSON.parse(JSON.stringify(patch)) as Partial<IntakeWrite>)
  const stored = await readIntake(firmId, intakeId, clearance)
  if (!stored) throw new HttpError(404, "not_found")
  return stored
}

export async function listMessages(firmId: string, intakeId: string): Promise<IntakeMessage[]> {
  assertEnabled()
  // Single-field query: a composite intakeId+firmId index is not added in this wave.
  const snap = await messages().where("intakeId", "==", intakeId).get()
  const items: IntakeMessage[] = []
  for (const doc of snap.docs) {
    const data = doc.data()
    if (data.firmId !== firmId || data.intakeId !== intakeId || typeof data.text !== "string" || data.direction !== "inbound") continue
    items.push({ messageId: doc.id, intakeId, firmId, direction: "inbound", text: data.text, createdAt: iso(data.createdAt) })
  }
  items.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || (a.messageId < b.messageId ? -1 : 1))
  return items
}

export type { Classification }
