import { isClassification, type Classification } from "@/platform/p1/types"
import { rankOf, type DraftRecord, type SpineStore } from "@/platform/spine/store"
import { checkPermission } from "@/platform/p5/checkPermission"
import {
  checkTemporalConsistency,
  verifyCitations,
} from "@/services/d4-2/draftingIntelligence"
import { getDocumentTypes } from "@/lib/foundation-data"

export type TemplateSummary = {
  id: string
  name: string
  posture: string
  category: string
}

export type TemporalCitationInput = {
  sectionId: string
  offenceDate: string
  usedText: string
}

export type DraftPreflightInput = {
  actorId: string
  matterId: string
  classification: Classification
  citedJudgmentIds: string[]
  temporalCitations: TemporalCitationInput[]
  partnerOverride?: { partnerId: string; reason: string }
}

export type DraftPreflightResult = {
  ok: boolean
  citationStatus: "OK" | "OVERRULED"
  temporal: Array<{ sectionId: string; status: "OK" | "TEMPORAL-MISMATCH" }>
}

export function listTemplateCatalog(query: string): TemplateSummary[] {
  const normalizedQuery = query.toLowerCase()
  return getDocumentTypes()
    .map((type) => ({
      id: type.id,
      name: type.name,
      posture: type.posture,
      category: type.category,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((item) => {
      if (!normalizedQuery) return true
      return (
        item.id.toLowerCase().includes(normalizedQuery) ||
        item.name.toLowerCase().includes(normalizedQuery) ||
        item.posture.toLowerCase().includes(normalizedQuery)
      )
    })
}

export function listTemplates(
  query: string,
  limit: number,
  cursor: number
): { items: TemplateSummary[]; total: number; nextCursor: string | null } {
  const all = listTemplateCatalog(query)
  const items = all.slice(cursor, cursor + limit)
  const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
  return { items, total: all.length, nextCursor }
}

export function runDraftPreflight(
  store: SpineStore,
  input: DraftPreflightInput
): DraftPreflightResult {
  if (!isClassification(input.classification)) {
    throw new Error("classification must be a rank-0–4 label")
  }
  const actor = store.users.get(input.actorId)
  if (!actor) throw new Error("unknown actor")
  const matter = store.matters.get(input.matterId)
  if (!matter) throw new Error("unknown matter")
  const permission = checkPermission(store, input.actorId, "draft", input.matterId)
  if (!permission.allow) throw new Error(`permission denied: ${permission.reason}`)
  if (rankOf(input.classification) < rankOf(matter.classification)) {
    throw new Error("draft classification cannot be lower than matter classification")
  }

  const citation = verifyCitations(
    store,
    input.citedJudgmentIds,
    input.partnerOverride
  )
  const citationStatus = citation.status === "OVERRULED" ? "OVERRULED" : "OK"
  const temporal = input.temporalCitations.map((row) => {
    const gate = checkTemporalConsistency(
      store,
      row.sectionId,
      row.offenceDate,
      row.usedText
    )
    return {
      sectionId: row.sectionId,
      status: gate.status === "TEMPORAL-MISMATCH" ? "TEMPORAL-MISMATCH" : "OK",
    }
  })
  const temporalBlocked = temporal.some((row) => row.status !== "OK")
  const citationBlocked = citationStatus !== "OK"

  return {
    ok: !citationBlocked && !temporalBlocked,
    citationStatus,
    temporal,
  }
}

export function composeDraft(
  store: SpineStore,
  input: {
    actorId: string
    matterId: string
    templateId: string
    title: string
    body: string
    classification: Classification
    preflight: DraftPreflightInput
  }
): DraftRecord {
  const templateExists = getDocumentTypes().some((type) => type.id === input.templateId)
  if (!templateExists) throw new Error("unknown templateId")
  const gate = runDraftPreflight(store, input.preflight)
  if (!gate.ok) {
    throw new Error("preflight blocked drafting")
  }
  const matter = store.matters.get(input.matterId)
  if (!matter) throw new Error("unknown matter")
  const draft: DraftRecord = {
    id: store.id("drf"),
    firmId: matter.firmId,
    matterId: input.matterId,
    templateId: input.templateId,
    title: input.title,
    body: input.body,
    classification: input.classification,
    createdBy: input.actorId,
    createdAt: Date.now(),
    status: "draft",
  }
  store.drafts.set(draft.id, draft)
  return draft
}
