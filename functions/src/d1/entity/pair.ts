import type { DocumentData, DocumentReference, Transaction } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../../admin"
import { HttpError } from "../../http/errors"
import type { Caller } from "../../p5/auth"
import { isSafeDocId } from "../../p5/common"
import { maxLabel } from "../conflict/engine"
import { withinClearance } from "./read"

/**
 * The entity pair a decision acts on (spec P2-25, P2-34): every key row of the pair, both
 * entities and their clients, read inside the decision's transaction, behind one 404 gate.
 */

export type Pair = {
  pairId: string
  a: string
  b: string
  rows: Array<{ ref: DocumentReference; data: DocumentData }>
  left: DocumentData
  right: DocumentData
  label: Classification
}

const notFound = () => new HttpError(404, "not_found")

/**
 * readPair(tx, caller, linkId): `linkId` must be a safe doc id (400 invalid_query). The addressed
 * row, then every row of its pair (`firmId == caller.firmId, leftId == a, rightId == b`), both
 * `entities` docs and their `clients` rows are read in `tx`. A missing or other-firm row or
 * entity is 404 not_found. `label` is the max over every row, both entities and their clients
 * (an unknown label counts as the highest); a caller cleared below it gets 404 not_found too, so
 * no state code is ever decided for a pair the caller may not see.
 */
export async function readPair(tx: Transaction, caller: Caller, linkId: string): Promise<Pair> {
  if (!isSafeDocId(linkId)) throw new HttpError(400, "invalid_query")
  const db = adminDb()
  const addressed = (await tx.get(db.collection("entity_links").doc(linkId))).data()
  if (!addressed || addressed.firmId !== caller.firmId) throw notFound()
  const a: unknown = addressed.leftId
  const b: unknown = addressed.rightId
  if (!isSafeDocId(a) || !isSafeDocId(b) || a === b) throw notFound()

  const snap = await tx.get(db.collection("entity_links").where("firmId", "==", caller.firmId).where("leftId", "==", a).where("rightId", "==", b))
  const rows = snap.docs.map((d) => ({ ref: d.ref, data: d.data() }))
  if (!rows.some((r) => r.ref.id === linkId)) throw notFound()

  const [leftSnap, rightSnap] = await tx.getAll(db.collection("entities").doc(a), db.collection("entities").doc(b))
  const left = leftSnap.data()
  const right = rightSnap.data()
  if (!left || left.firmId !== caller.firmId || !right || right.firmId !== caller.firmId) throw notFound()

  const clientLabels: unknown[] = []
  for (const entityId of [a, b]) {
    const owner = await tx.get(db.collection("clients").where("firmId", "==", caller.firmId).where("entityId", "==", entityId).limit(1))
    for (const doc of owner.docs) clientLabels.push(doc.data().classification)
  }

  const label = [...rows.map((r) => r.data.classification), left.classification, right.classification, ...clientLabels].reduce<Classification>(
    (acc, l) => maxLabel(acc, l),
    "public"
  )
  if (!withinClearance(label, caller.clearanceLevel)) throw notFound()
  return { pairId: `${a}_${b}`, a, b, rows, left, right, label }
}
