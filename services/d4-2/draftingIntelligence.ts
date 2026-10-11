import type { Judgment, SpineStore } from "@/platform/spine/store"
import { isUnrecognisedRef, normaliseCitation } from "@/services/d4-2/citations"
import {
  verdictFromTreatments,
  type CitationVerdict,
  type TreatmentFact,
} from "@/services/d4-2/citationVerdict"
import { isEffectivePartnerOverride, type PartnerOverride } from "@/services/d4-2/partnerOverride"

export type GateResult =
  | { status: "OK" }
  | { status: "TEMPORAL-MISMATCH"; blocked: true }

/** Module 33 per-authority states (v6 M33: "VERIFIED / UNVERIFIED / OVERRULED"); the rule is in citationVerdict.ts. */
export type { CitationVerdict }

export type CitationFinding = {
  /** The judgment id or canonical citation as first referenced. */
  ref: string
  judgmentId: string | null
  status: CitationVerdict
}

/**
 * Gate outcome. E-22: "approval blocked on any non-VERIFIED result". `status` is "OK" only when
 * every authority is VERIFIED, or when the calling partner recorded an override reason
 * (`overridden`); otherwise the worst state (OVERRULED > UNVERIFIED) and `blocked`.
 */
export type CitationGateResult = {
  status: "OK" | "OVERRULED" | "UNVERIFIED"
  blocked: boolean
  overridden: boolean
  findings: CitationFinding[]
}

export function seedJudgment(
  store: SpineStore,
  id: string,
  title: string,
  benchType: "single" | "division" | "full" | "larger",
  citation?: string
) {
  store.judgments.set(id, { id, title, benchType, ...(citation ? { citation } : {}) })
}

export function seedTreatment(
  store: SpineStore,
  treatingId: string,
  treatedId: string,
  treatment: "overruled" | "followed" | "applied",
  treatingBenchType: "single" | "division" | "full" | "larger"
) {
  store.treatments.push({ treatingId, treatedId, treatment, treatingBenchType })
}

function resolveJudgment(store: SpineStore, ref: string): Judgment | null {
  const byId = store.judgments.get(ref)
  if (byId) return byId
  const canonical = normaliseCitation(ref)
  if (!canonical) return null
  for (const judgment of store.judgments.values()) {
    if (judgment.citation && normaliseCitation(judgment.citation) === canonical) return judgment
  }
  return null
}

function verdictFor(store: SpineStore, judgment: Judgment): CitationVerdict {
  const treatments: TreatmentFact[] = store.treatments
    .filter((t) => t.treatedId === judgment.id)
    .map((t) => ({
      kind: t.treatment,
      treatingJudgmentBench: store.judgments.get(t.treatingId)?.benchType ?? null,
      recordedTreatingBench: t.treatingBenchType,
    }))
  return verdictFromTreatments(judgment.benchType, treatments)
}

/**
 * Cross-checks every referenced authority (judgment ids and/or citation strings — callers pass
 * the union of extractCitations(draftBody) and any ids they list) against the authority store.
 * Unknown or unverifiable authorities are UNVERIFIED, never OK.
 *
 * `caller` is the authenticated actor and the firm that owns the matter. A partner override
 * is effective only when its partnerId is that caller, a partner of that firm, with a reason.
 */
export function verifyCitations(
  store: SpineStore,
  refs: readonly string[],
  partnerOverride?: PartnerOverride,
  caller?: { actorId: string; firmId: string }
): CitationGateResult {
  const findings: CitationFinding[] = []
  const seen = new Set<string>()
  for (const raw of refs) {
    const ref = typeof raw === "string" ? raw.trim() : ""
    if (!ref) continue
    if (isUnrecognisedRef(ref)) {
      // A suspected authority the extractor could not read exactly: never resolvable (E-22).
      if (seen.has(`r:${ref}`)) continue
      seen.add(`r:${ref}`)
      findings.push({ ref, judgmentId: null, status: "UNVERIFIED" })
      continue
    }
    const judgment = resolveJudgment(store, ref)
    const displayRef = judgment && store.judgments.has(ref) ? ref : (normaliseCitation(ref) ?? ref)
    const key = judgment ? `j:${judgment.id}` : `r:${displayRef}`
    if (seen.has(key)) continue
    seen.add(key)
    findings.push({
      ref: displayRef,
      judgmentId: judgment?.id ?? null,
      status: judgment ? verdictFor(store, judgment) : "UNVERIFIED",
    })
  }
  const worst: CitationGateResult["status"] = findings.some((f) => f.status === "OVERRULED")
    ? "OVERRULED"
    : findings.some((f) => f.status === "UNVERIFIED")
      ? "UNVERIFIED"
      : "OK"
  if (worst === "OK") return { status: "OK", blocked: false, overridden: false, findings }
  if (isEffectivePartnerOverride(store, partnerOverride, caller)) {
    return { status: "OK", blocked: false, overridden: true, findings }
  }
  return { status: worst, blocked: true, overridden: false, findings }
}

export function seedSection(
  store: SpineStore,
  sectionId: string,
  versions: {
    versionNo: number
    effectiveFrom: string
    effectiveTo: string | null
    text: string
  }[]
) {
  for (const v of versions) {
    store.sectionVersions.push({ sectionId, ...v })
  }
}

export function getSectionAsAt(
  store: SpineStore,
  sectionId: string,
  asAt: string
): { text: string; versionNo: number } | null {
  const rows = store.sectionVersions.filter((v) => v.sectionId === sectionId)
  const hit = rows.find((v) => {
    if (asAt < v.effectiveFrom) return false
    if (v.effectiveTo && asAt >= v.effectiveTo) return false
    return true
  })
  return hit ? { text: hit.text, versionNo: hit.versionNo } : null
}

export function checkTemporalConsistency(
  store: SpineStore,
  sectionId: string,
  offenceDate: string,
  usedText: string
): GateResult {
  const asAt = getSectionAsAt(store, sectionId, offenceDate)
  if (!asAt || asAt.text !== usedText) {
    return { status: "TEMPORAL-MISMATCH", blocked: true }
  }
  return { status: "OK" }
}
