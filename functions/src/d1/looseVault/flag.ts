import { canReadDocument, canUseLooseVault } from "@/platform/p5/documentAccess"
import { readDocumentRecord } from "@/platform/d1/documentRecord"
import { rankOfStoredOrMax, SpineStore, type DocumentRecord, type User } from "@/platform/spine/store"
import { type QueryDocumentSnapshot, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../../admin"
import { HttpError } from "../../http/errors"
import { stageAudit } from "../../p5/audit"
import type { Caller } from "../../p5/auth"
import { rankOf } from "../../p5/classification"
import { isSafeDocId } from "../../p5/common"

/**
 * L4.5 loose vault, Erratum E-18. Env-only, same spelling as services/d2-1/grammar.ts.
 * Unset, blank, or any value other than "true" (after trim and lower-case) is off.
 * This module does not register the flag; a later integration PR does that.
 */
export const LOOSE_VAULT_FLAG_ENV = "SIKANDER_FLAG_L4_LOOSE_VAULT"

export function isLooseVaultEnabled(): boolean {
  return process.env[LOOSE_VAULT_FLAG_ENV]?.trim().toLowerCase() === "true"
}

/** 404 feature_disabled. Callers must run this before any Firestore read. */
export function assertLooseVaultEnabled(): void {
  if (!isLooseVaultEnabled()) throw new HttpError(404, "feature_disabled")
}

export function looseNotFound(): HttpError {
  return new HttpError(404, "not_found")
}

function actorUser(actor: Caller): User {
  return { id: actor.uid, firmId: actor.firmId, role: actor.role, clearanceLevel: actor.clearanceLevel }
}

/**
 * E-18 gate from canUseLooseVault: clerk or partner, clearance at least confidential.
 * Runs after the flag check and before any read. A bad clearance label fails closed.
 */
export function assertLooseVaultActor(actor: Caller): void {
  assertLooseVaultEnabled()
  if (!actor || !isSafeDocId(actor.uid) || !isSafeDocId(actor.firmId)) throw new HttpError(403, "loose_vault_denied")
  let allowed = false
  try {
    allowed = canUseLooseVault({ role: actor.role, clearanceLevel: actor.clearanceLevel })
  } catch {
    allowed = false
  }
  if (!allowed) throw new HttpError(403, "loose_vault_denied")
}

/** Loose row (`matterId === null`) the actor may read, via canReadDocument. One store per scan. */
export function looseReader(actor: Caller): (doc: Pick<DocumentRecord, "firmId" | "classification" | "matterId">) => boolean {
  const store = new SpineStore()
  const user = actorUser(actor)
  return (doc) => {
    if (doc.matterId !== null || doc.firmId !== actor.firmId) return false
    try {
      return canReadDocument(store, user, doc)
    } catch {
      return false
    }
  }
}

/**
 * Matter-bound row the actor could read. Used only to choose 409 not_loose over 404,
 * so a non-member learns nothing about a file that is already on a matter.
 */
export function canReadBoundRow(
  actor: Caller,
  doc: Pick<DocumentRecord, "firmId" | "classification" | "matterId">,
  matter: { id: string; firmId: string; classification: DocumentRecord["classification"] } | null,
  member: boolean
): boolean {
  if (doc.matterId === null || !matter || matter.id !== doc.matterId || matter.firmId !== doc.firmId) return false
  const store = new SpineStore()
  store.matters.set(matter.id, {
    id: matter.id,
    firmId: matter.firmId,
    clientId: "",
    title: "",
    courtId: null,
    caseNumber: null,
    caseNumberStatus: "pending",
    status: "live",
    classification: matter.classification,
  })
  if (member) {
    store.members.set(store.memberKey(matter.id, actor.uid), {
      matterId: matter.id,
      userId: actor.uid,
      firmId: matter.firmId,
    })
  }
  try {
    return canReadDocument(store, actorUser(actor), doc)
  } catch {
    return false
  }
}

/** Caller clearance covers a stored label. An unknown label ranks as the maximum (fail closed). */
export function clearanceCovers(actor: Caller, label: unknown): boolean {
  try {
    return rankOf(actor.clearanceLevel) >= rankOfStoredOrMax(label)
  } catch {
    return false
  }
}

export function canonicalLoose(id: string, data: unknown): DocumentRecord | null {
  const record = readDocumentRecord(id, data)
  if (!record || record.firmId !== dataFirm(data)) return null
  return record
}

function dataFirm(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined
  const firmId = (data as { firmId?: unknown }).firmId
  return typeof firmId === "string" ? firmId : undefined
}

/**
 * Firm documents on the single-field `firmId` index. `matterId == null` is filtered in memory
 * so this module does not need a composite index (firestore.indexes.json is not ours to edit).
 */
export async function firmDocumentDocs(firmId: string): Promise<QueryDocumentSnapshot[]> {
  const snap = await adminDb().collection("documents").where("firmId", "==", firmId).get()
  return snap.docs
}

export function auditLoose(
  tx: Transaction,
  row: {
    firmId: string
    actorId: string
    action: string
    docId: string
    classification: DocumentRecord["classification"]
    reason: string
  }
): void {
  try {
    stageAudit(
      {
        firmId: row.firmId,
        actorId: row.actorId,
        action: row.action,
        target: `documents/${row.docId}`,
        classification: row.classification,
        decision: "allow",
        reason: row.reason,
      },
      tx
    )
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw new HttpError(503, "audit_unavailable")
  }
}
