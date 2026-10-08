import type { DocumentData } from "firebase-admin/firestore"
import { adminDb } from "../../admin"

/**
 * The entity + client view shared by the review queue, getEntity and the decisions (spec P2-31,
 * P2-32): an entity's canonical name and deterministic keys, with the client it was registered as.
 */

export type EntityKeys = { cnic?: string; ntn?: string; secp?: string; phone?: string }

export type EntitySummary = {
  entityId: string
  canonicalName: string
  clientId: string | null
  clientCode: string | null
  keys: EntityKeys
}

/** A `clients` row with its id. */
export type ClientRef = { id: string; row: DocumentData }

/** Entity field holding each key (as registerClient writes them). */
const ENTITY_FIELD = { cnic: "cnic", ntn: "ntn", secp: "secpNumber", phone: "phone" } as const

/** The keys an entity row carries, in the order cnic, ntn, secp, phone. */
export function entityKeys(row: DocumentData): EntityKeys {
  const keys: EntityKeys = {}
  for (const [key, field] of Object.entries(ENTITY_FIELD) as Array<[keyof EntityKeys, string]>) {
    const value: unknown = row[field]
    if (typeof value === "string" && value !== "") keys[key] = value
  }
  return keys
}

export function entitySummary(entityId: string, entityRow: DocumentData, client: ClientRef | undefined): EntitySummary {
  return {
    entityId,
    canonicalName: typeof entityRow.canonicalName === "string" ? entityRow.canonicalName : "",
    clientId: client ? client.id : null,
    clientCode: client && typeof client.row.clientCode === "string" ? client.row.clientCode : null,
    keys: entityKeys(entityRow),
  }
}

/** The client registered as `entityId` in the firm (registerClient writes exactly one), if any. */
export async function clientOfEntity(firmId: string, entityId: string): Promise<ClientRef | undefined> {
  const snap = await adminDb().collection("clients").where("firmId", "==", firmId).where("entityId", "==", entityId).limit(1).get()
  const doc = snap.docs[0]
  return doc ? { id: doc.id, row: doc.data() } : undefined
}
