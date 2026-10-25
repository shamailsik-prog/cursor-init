/**
 * FA-D4-001-FU1: the Admin SDK side of the court-ops acknowledgement backfill
 * (platform/persistence/courtOpsAckBackfill.ts). It lives with the operator scripts, not under platform/: the Next server
 * never imports it, and the Next Firestore static guards (F01 no full-collection scans, F10 fenced writes) cover the
 * server's own code.
 */
import { FieldPath, type DocumentReference, type Firestore } from "firebase-admin/firestore"
import { COURT_OPS_ACK_PREFIX } from "@/platform/persistence/courtOpsAcknowledgement"
import {
  COURT_OPS_ACK_COLLECTION,
  courtOpsAckItemKey,
  decideCourtOpsAckMove,
  legacyCourtOpsAckItems,
  type CourtOpsAckBackfillRow,
  type CourtOpsAckBackfillStore,
  type NestedCourtOpsAckDocument,
} from "@/platform/persistence/courtOpsAckBackfill"

/** The first id after every id under the prefix (`;` follows `:` in the byte order Firestore sorts ids by). */
const PREFIX_END = `${COURT_OPS_ACK_PREFIX.slice(0, -1)};`
/** Firestore nests at most 100 levels; a walk deeper than this is not advancing. */
const MAX_NESTED_DEPTH = 100
const EVIDENCE_BATCH = 100

/** The Admin SDK store (the script and the emulator tests). */
export function adminCourtOpsAckBackfillStore(db: Firestore): CourtOpsAckBackfillStore {
  return {
    async move(planned) {
      const legacyRef = db.collection(COURT_OPS_ACK_COLLECTION).doc(planned.from)
      const targetRef = db.collection(COURT_OPS_ACK_COLLECTION).doc(planned.to)
      return db.runTransaction(async (tx) => {
        const legacy = await tx.get(legacyRef)
        const target = await tx.get(targetRef)
        const decision = decideCourtOpsAckMove(planned, legacy.exists ? legacy.data() : null, target.exists ? target.data() : null)
        if (decision.write) {
          tx.set(targetRef, decision.write)
          tx.delete(legacyRef)
        }
        return decision.outcome
      })
    },
    async appendAudit(row) {
      // create(): an audit row is never overwritten.
      await db.collection("audit_log").doc(row.id).create(row)
    },
  }
}

/** Every existing document under `ref` (FU1b: an ack id with `/` became a sub-collection path), depth-first. */
async function nestedUnder(ref: DocumentReference, depth: number, out: NestedCourtOpsAckDocument[]): Promise<void> {
  if (depth > MAX_NESTED_DEPTH) throw new Error(`nested acknowledgement walk exceeded ${MAX_NESTED_DEPTH} levels at ${ref.path}`)
  for (const sub of await ref.listCollections()) {
    for (const child of await sub.listDocuments()) {
      if ((await child.get()).exists) out.push({ path: child.path })
      await nestedUnder(child, depth + 1, out)
    }
  }
}

/**
 * The backfill's input (a one-off run; Admin SDK):
 * - `rows`: every document whose id is under `ops:court_ops:ack:` (an id-range query, not the whole collection);
 * - `nested`: every document below an ack-prefixed parent. `listDocuments()` returns the collection's references,
 *   including parents that exist only as a path, and only ack-prefixed ones are walked;
 * - `itemFirms`: for each legacy row's item, the firm its `document_workflow` or `follow_ups` row carries (only `firmId`
 *   is read), or null.
 */
export async function readCourtOpsAckBackfillInput(db: Firestore): Promise<{
  rows: CourtOpsAckBackfillRow[]
  nested: NestedCourtOpsAckDocument[]
  itemFirms: Map<string, string | null>
}> {
  const coll = db.collection(COURT_OPS_ACK_COLLECTION)
  const snap = await coll.orderBy(FieldPath.documentId()).startAt(COURT_OPS_ACK_PREFIX).endBefore(PREFIX_END).get()
  const rows = snap.docs.map((d) => ({ id: d.id, data: (d.data() ?? {}) as Record<string, unknown> }))
  const nested: NestedCourtOpsAckDocument[] = []
  for (const ref of await coll.listDocuments()) {
    if (ref.id.startsWith(COURT_OPS_ACK_PREFIX)) await nestedUnder(ref, 1, nested)
  }
  const itemFirms = new Map<string, string | null>()
  const items = legacyCourtOpsAckItems(rows)
  for (let i = 0; i < items.length; i += EVIDENCE_BATCH) {
    const part = items.slice(i, i + EVIDENCE_BATCH)
    const refs = part.map(({ queueType, itemId }) => db.collection(queueType === "workflow" ? "document_workflow" : "follow_ups").doc(itemId))
    const snaps = await db.getAll(...refs, { fieldMask: ["firmId"] })
    snaps.forEach((s, k) => {
      const item = part[k] as (typeof part)[number]
      const firmId: unknown = s.exists ? s.get("firmId") : null
      itemFirms.set(courtOpsAckItemKey(item.queueType, item.itemId), typeof firmId === "string" && firmId !== "" ? firmId : null)
    })
  }
  return { rows, nested, itemFirms }
}
