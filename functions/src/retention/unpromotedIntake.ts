import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { adminDb } from "../admin"
import { activePolicy, anonymiseApplied, inventory, retentionClassOf, retentionTestSeam, type InventoryStore } from "./config"

/**
 * Firm-scoped reach for an intake that has no matter yet (L2, L5). The matter-deletion query
 * matches matterId, so a null matterId is invisible to it. This sweep reads the firm's rows and
 * anonymises the ones still unpromoted, by intake id or by createdAt. The fields it clears are
 * the store's anonymise map, which names the PII body fields.
 */

const INTAKE_PII = ["text", "prospect.name", "prospect.phone", "prospect.email", "prospect.opposingParties"] as const
const MESSAGE_PII = ["text"] as const

export type UnpromotedSweep = { firmId: string; intakeId?: string; olderThanMs?: number }

function storeOf(id: string): InventoryStore {
  const store = inventory().stores.find((row) => row.id === id)
  if (!store?.anonymise) throw new Error(`missing anonymise for ${id}`)
  return store
}

function named(store: InventoryStore, fields: readonly string[]): Record<string, string | number | null> {
  const map = store.anonymise ?? {}
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(map, field)) throw new Error(`anonymise for ${store.id} does not name ${field}`)
  }
  return map
}

function ageMs(data: DocumentData): number | null {
  const at = data.createdAt
  if (at instanceof Timestamp) return at.toMillis()
  return null
}

function alreadyApplied(data: DocumentData, fields: Record<string, string | number | null>): boolean {
  return anonymiseApplied(data, fields)
}

/**
 * TODO(W1-Q09A): honour the class-wide legal hold once it is wired for this sweep.
 * The shipped policy keeps matter_record and matter_content on legalHold while their action
 * stays retain, so the hold is not a deletion block yet. The seam turns the guard on.
 */
function classHoldBlocks(store: InventoryStore): boolean {
  if (process.env.NODE_ENV === "production" || retentionTestSeam.honourUnpromotedLegalHold !== true) return false
  return activePolicy().classes[retentionClassOf(store)]?.legalHold === true
}

function selected(data: DocumentData, spec: UnpromotedSweep, intakeId?: string): boolean {
  if (data.firmId !== spec.firmId) return false
  if (data.matterId !== null) return false
  if (spec.intakeId && intakeId !== spec.intakeId && data.intakeId !== spec.intakeId) return false
  if (spec.olderThanMs === undefined) return true
  const ms = ageMs(data)
  return ms !== null && ms < spec.olderThanMs
}

async function sweep(collection: string, spec: UnpromotedSweep, fields: Record<string, string | number | null>, idField: "doc" | "intakeId"): Promise<number> {
  const snap = await adminDb().collection(collection).where("firmId", "==", spec.firmId).get()
  let writes = 0
  for (const doc of snap.docs) {
    const data = doc.data()
    const id = idField === "doc" ? doc.id : typeof data.intakeId === "string" ? data.intakeId : ""
    if (!selected(data, spec, id)) continue
    if (alreadyApplied(data, fields)) continue
    await doc.ref.update({ ...fields })
    writes += 1
  }
  return writes
}

/** Anonymise unpromoted intake rows and their messages. A promoted row is left as it is. */
export async function anonymiseUnpromotedIntakes(spec: UnpromotedSweep): Promise<{ intakes: number; messages: number }> {
  const intakeStore = storeOf("firestore:intakes")
  const messageStore = storeOf("firestore:intake_messages")
  if (classHoldBlocks(intakeStore) || classHoldBlocks(messageStore)) return { intakes: 0, messages: 0 }
  const intakes = named(intakeStore, INTAKE_PII)
  const messages = named(messageStore, MESSAGE_PII)
  return {
    intakes: await sweep("intakes", spec, intakes, "doc"),
    messages: await sweep("intake_messages", spec, messages, "intakeId"),
  }
}
