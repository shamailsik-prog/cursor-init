/**
 * FA-D4-001: the Admin SDK side of the template-analytics backfill (platform/persistence/draftTemplateAnalyticsBackfill.ts).
 * It lives with the operator scripts, not under platform/: the Next server never imports it, and the Next Firestore
 * static guards (F01 no full-collection scans, F10 fenced writes) cover the server's own code.
 */
import type { Firestore } from "firebase-admin/firestore"
import {
  TEMPLATE_ANALYTICS_COLLECTION,
  decideTemplateAnalyticsMove,
  legacyTemplateIds,
  type AnalyticsBackfillRow,
  type TemplateAnalyticsBackfillStore,
} from "@/platform/persistence/draftTemplateAnalyticsBackfill"

/** The Admin SDK store (the script and the emulator tests). */
export function adminTemplateAnalyticsBackfillStore(db: Firestore): TemplateAnalyticsBackfillStore {
  return {
    async move(planned) {
      const legacyRef = db.collection(TEMPLATE_ANALYTICS_COLLECTION).doc(planned.from)
      const targetRef = db.collection(TEMPLATE_ANALYTICS_COLLECTION).doc(planned.to)
      return db.runTransaction(async (tx) => {
        const legacy = await tx.get(legacyRef)
        const target = await tx.get(targetRef)
        const decision = decideTemplateAnalyticsMove(planned, legacy.exists ? legacy.data() : null, target.exists ? target.data() : null)
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

/**
 * Reads the analytics collection whole (a one-off run; Admin SDK) and, for each legacy template id, the firm ids of its
 * `drafts` rows (only `firmId` is selected: draft bodies are never read).
 */
export async function readTemplateAnalyticsBackfillInput(
  db: Firestore
): Promise<{ rows: AnalyticsBackfillRow[]; draftFirmsByTemplate: Map<string, Set<string>> }> {
  const rows = (await db.collection(TEMPLATE_ANALYTICS_COLLECTION).get()).docs.map((d) => ({
    id: d.id,
    data: (d.data() ?? {}) as Record<string, unknown>,
  }))
  const draftFirmsByTemplate = new Map<string, Set<string>>()
  for (const templateId of legacyTemplateIds(rows)) {
    const drafts = await db.collection("drafts").where("templateId", "==", templateId).select("firmId").get()
    const firms = new Set<string>()
    for (const d of drafts.docs) {
      const firmId: unknown = d.get("firmId")
      if (typeof firmId === "string" && firmId !== "") firms.add(firmId)
    }
    draftFirmsByTemplate.set(templateId, firms)
  }
  return { rows, draftFirmsByTemplate }
}
