import { isClassification, type Classification } from "@/platform/p1/types"
import { rankOf, type SpineStore } from "@/platform/spine/store"

export function setClassification(
  store: SpineStore,
  artefactId: string,
  next: Classification,
  actorId: string,
  declassifyReason?: string
): void {
  if (!isClassification(next)) {
    throw new Error("artefact write omitted classification")
  }
  const doc = store.documents.get(artefactId)
  const matter = store.matters.get(artefactId)
  const current = doc?.classification ?? matter?.classification
  if (!current) throw new Error("unknown artefact")

  if (rankOf(next) < rankOf(current)) {
    const actor = store.users.get(actorId)
    if (!actor || actor.role !== "partner" || !declassifyReason?.trim()) {
      throw new Error("Classification downgrade rejected: use declassify() with a partner reason")
    }
  }

  if (doc) doc.classification = next
  if (matter) matter.classification = next
  store.audit.push({
    action: declassifyReason ? "declassify" : "classify",
    actorId,
    target: artefactId,
    classification: next,
    reason: declassifyReason,
  })
}

export function declassify(
  store: SpineStore,
  artefactId: string,
  next: Classification,
  partnerId: string,
  reason: string
): void {
  const partner = store.users.get(partnerId)
  if (!partner || partner.role !== "partner") {
    throw new Error("declassify is partner-only")
  }
  if (!reason.trim()) throw new Error("declassify requires a recorded reason")
  setClassification(store, artefactId, next, partnerId, reason)
}
