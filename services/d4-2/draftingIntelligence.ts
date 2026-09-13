import type { SpineStore } from "@/platform/spine/store"

export type GateResult =
  | { status: "OK" }
  | { status: "OVERRULED"; blocked: true }
  | { status: "TEMPORAL-MISMATCH"; blocked: true }

export function seedJudgment(
  store: SpineStore,
  id: string,
  title: string,
  benchType: "single" | "division" | "full" | "larger"
) {
  store.judgments.set(id, { id, title, benchType })
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

export function verifyCitations(
  store: SpineStore,
  citedJudgmentIds: string[],
  partnerOverrideReason?: string
): GateResult {
  for (const cited of citedJudgmentIds) {
    const hit = store.treatments.find(
      (t) => t.treatedId === cited && t.treatment === "overruled"
    )
    if (!hit) continue
    const treating = store.judgments.get(hit.treatingId)
    const treated = store.judgments.get(cited)
    const larger =
      treating &&
      treated &&
      benchRank(treating.benchType) > benchRank(treated.benchType)
    if (hit.treatment === "overruled" && (larger || hit.treatingBenchType === "larger")) {
      if (partnerOverrideReason?.trim()) return { status: "OK" }
      return { status: "OVERRULED", blocked: true }
    }
  }
  return { status: "OK" }
}

function benchRank(b: "single" | "division" | "full" | "larger"): number {
  return { single: 1, division: 2, full: 3, larger: 4 }[b]
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
  if (!asAt) return { status: "OK" }
  if (asAt.text !== usedText) {
    return { status: "TEMPORAL-MISMATCH", blocked: true }
  }
  return { status: "OK" }
}
