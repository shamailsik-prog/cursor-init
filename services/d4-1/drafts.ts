import { isClassification, type Classification } from "@/platform/p1/types"
import { PublicError } from "@/platform/http/publicError"
import { rankOf, rankOfStoredOrMax, type DraftRecord, type SpineStore } from "@/platform/spine/store"
import { checkPermission } from "@/platform/p5/checkPermission"
import {
  checkTemporalConsistency,
  verifyCitations,
  type CitationFinding,
} from "@/services/d4-2/draftingIntelligence"
import { extractCitations } from "@/services/d4-2/citations"
import { requireSupportedDraftBody } from "@/services/d4-2/draftCharset"
import courtsSeed from "@/data/courts.json"
import { loadCourts, normalise as normaliseCaseNumber } from "@/core/case-number-normaliser"

const courts = loadCourts(courtsSeed)

/** A case reference that normalises to the matter's own recorded case number is not an authority. */
/** Case-number text with case, dots, "No."/"Number", "of"/"/" and spacing folded away. */
function comparableCaseNumber(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/\./g, " ")
    .replace(/\b(?:NO|NUMBER)\b/g, " ")
    .replace(/\s+OF\s+/g, "/")
    .replace(/[\s/]+/g, "")
}

export function ownCaseReferenceMatcher(matter: {
  courtId: string
  caseNumber: string | null
}): (raw: string) => boolean {
  return (raw) => {
    if (!matter.caseNumber) return false
    try {
      const result = normaliseCaseNumber(raw, matter.courtId, courts)
      if (result.status !== "REJECT") return result.canonical === matter.caseNumber
    } catch {
      // fall through to the raw comparison
    }
    // R4 FP2: the normaliser cannot parse this reference — accept it when it is written the
    // same way as the recorded number (case, dots, "No.", "of"/"/" and spacing aside).
    return comparableCaseNumber(raw) === comparableCaseNumber(matter.caseNumber)
  }
}
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
  /** Judgment ids or citation strings the caller lists; unioned with the draft body's citations. */
  citedJudgmentIds: string[]
  temporalCitations: TemporalCitationInput[]
  partnerOverride?: { partnerId: string; reason: string }
  /** Draft text; every reported citation in it is extracted and checked (Module 33). */
  draftBody?: string
  /** Draft title (R4-2): charset-checked and gated together with the body. */
  draftTitle?: string
}

/** The text the gate reads for a draft (R4-2): the normalised title, a newline, the normalised body. */
export function gatedDraftText(title: string, body: string): string {
  return title ? `${title}\n${body}` : body
}

export type DraftPreflightResult = {
  ok: boolean
  citationStatus: "OK" | "OVERRULED" | "UNVERIFIED"
  /** Per-authority Module 33 result: VERIFIED / UNVERIFIED / OVERRULED. */
  citations: CitationFinding[]
  temporal: Array<{ sectionId: string; status: "OK" | "TEMPORAL-MISMATCH" }>
  /** Set when a citation-gate block was cleared by the calling partner's recorded reason. */
  partnerOverride?: { partnerId: string; reason: string }
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
  input: DraftPreflightInput,
  options: { recordOverride?: boolean } = {}
): DraftPreflightResult {
  if (!isClassification(input.classification)) {
    throw new PublicError("classification must be a rank-0–4 label")
  }
  const actor = store.users.get(input.actorId)
  if (!actor) throw new PublicError("unknown actor")
  const matter = store.matters.get(input.matterId)
  if (!matter) throw new PublicError("unknown matter")
  const permission = checkPermission(store, input.actorId, "draft", input.matterId)
  if (!permission.allow) throw new PublicError(`permission denied: ${permission.reason}`)
  if (rankOf(input.classification) < rankOfStoredOrMax(matter.classification)) {
    throw new PublicError("draft classification cannot be lower than matter classification")
  }

  // Review round 3: refuse (422 unsupported_characters) any body containing characters that can
  // disguise text; analyse the normalised body (NFC, ASCII digits/dashes).
  const body = input.draftBody === undefined ? "" : requireSupportedDraftBody(input.draftBody)
  // R4-2: the title is court-facing text too — same refusal, same gate.
  const title = input.draftTitle === undefined ? "" : requireSupportedDraftBody(input.draftTitle)
  const caller = { actorId: input.actorId, firmId: matter.firmId }
  // Module 33: the gate checks union(extracted from the body, caller-listed), never only the latter.
  const refs = [
    ...extractCitations(gatedDraftText(title, body), { isOwnCaseReference: ownCaseReferenceMatcher(matter) }),
    ...(input.citedJudgmentIds ?? []),
  ]
  const citation = verifyCitations(store, refs, input.partnerOverride, caller)
  const citationStatus = citation.status
  const overrideApplied =
    citation.overridden && input.partnerOverride
      ? { partnerId: input.partnerOverride.partnerId, reason: input.partnerOverride.reason.trim() }
      : undefined
  // Only committing steps record the override (review R1 #7): compose and package creation
  // (the approval-routing step) pass recordOverride; a preflight dry run does not.
  if (overrideApplied && options.recordOverride === true) {
    store.audit.push({
      action: "citation_gate_override",
      actorId: input.actorId,
      target: input.matterId,
      classification: isClassification(matter.classification) ? matter.classification : "privileged-restricted",
      reason: overrideApplied.reason,
      overriddenAuthorities: citation.findings
        .filter((f) => f.status !== "VERIFIED")
        .map((f) => `${f.ref}:${f.status}`),
    })
  }
  const temporal = input.temporalCitations.map((row) => {
    const gate = checkTemporalConsistency(
      store,
      row.sectionId,
      row.offenceDate,
      row.usedText
    )
    return {
      sectionId: row.sectionId,
      status: gate.status === "TEMPORAL-MISMATCH" ? ("TEMPORAL-MISMATCH" as const) : ("OK" as const),
    }
  })
  const temporalBlocked = temporal.some((row) => row.status !== "OK")
  const citationBlocked = citationStatus !== "OK"

  return {
    ok: !citationBlocked && !temporalBlocked,
    citationStatus,
    citations: citation.findings,
    temporal,
    ...(overrideApplied ? { partnerOverride: overrideApplied } : {}),
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
  if (!templateExists) throw new PublicError("unknown templateId")
  // The stored body is exactly the analysed body: refused if it has disguising characters,
  // otherwise normalised (NFC, ASCII digits/dashes) before the gate reads it and it is saved.
  const body = requireSupportedDraftBody(input.body)
  const title = requireSupportedDraftBody(input.title)
  // The gate always reads the title and body being saved, whatever the caller put in preflight.
  const gate = runDraftPreflight(store, { ...input.preflight, draftBody: body, draftTitle: title }, { recordOverride: true })
  if (!gate.ok) {
    throw new PublicError("preflight blocked drafting")
  }
  const matter = store.matters.get(input.matterId)
  if (!matter) throw new PublicError("unknown matter")
  const draft: DraftRecord = {
    id: store.id("drf"),
    firmId: matter.firmId,
    matterId: input.matterId,
    templateId: input.templateId,
    title,
    body,
    classification: input.classification,
    createdBy: input.actorId,
    createdAt: Date.now(),
    status: "draft",
  }
  store.drafts.set(draft.id, draft)
  return draft
}
