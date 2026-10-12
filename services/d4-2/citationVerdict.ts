/**
 * Module 33 per-authority verdict: the one rule that turns a judgment's recorded treatments into
 * VERIFIED / UNVERIFIED / OVERRULED (v6 M33; E-22). Pure and dependency-free, so the in-memory
 * gate (draftingIntelligence.ts) and the Cloud Functions gate (functions/src/d4/gate.ts) share it
 * and cannot drift apart (P4-2).
 */

export type Bench = "single" | "division" | "full" | "larger"

/** Per-authority states (v6 M33: "VERIFIED / UNVERIFIED / OVERRULED"). */
export type CitationVerdict = "VERIFIED" | "UNVERIFIED" | "OVERRULED"

const BENCH_RANK: Readonly<Record<Bench, number>> = { single: 1, division: 2, full: 3, larger: 4 }

/** 1 (single) to 4 (larger): a higher rank can overrule a lower one. */
export function benchRank(b: Bench): number {
  return BENCH_RANK[b]
}

/**
 * One recorded treatment of the judgment being checked. `treatingJudgmentBench` is the bench of the
 * treating judgment when the store holds it, otherwise null; `recordedTreatingBench` is the bench the
 * treatment record itself states.
 */
export type TreatmentFact = {
  kind: string
  treatingJudgmentBench: Bench | null
  recordedTreatingBench: Bench
}

/**
 * Only an "overruled" treatment counts. It makes the judgment OVERRULED when some overruling comes from
 * a bench that outranks the treated one, or is recorded as "larger". An overruling whose bench
 * precedence cannot be established leaves currency unverified (UNVERIFIED), never VERIFIED. With no
 * overruling at all the judgment is VERIFIED.
 */
export function verdictFromTreatments(treatedBench: Bench, treatments: readonly TreatmentFact[]): CitationVerdict {
  let overruled = false
  for (const t of treatments) {
    if (t.kind !== "overruled") continue
    overruled = true
    const larger =
      (t.treatingJudgmentBench !== null && benchRank(t.treatingJudgmentBench) > benchRank(treatedBench)) ||
      t.recordedTreatingBench === "larger"
    if (larger) return "OVERRULED"
  }
  return overruled ? "UNVERIFIED" : "VERIFIED"
}
