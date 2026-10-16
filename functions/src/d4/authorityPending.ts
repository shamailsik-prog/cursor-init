import type { TreatmentFact } from "@/services/d4-2/citationVerdict"

/**
 * An overruling the store holds but cannot show (F05, #51 R1 D-1): held for review (ruling 3), or hidden by the reader's
 * visibility rules (plan D2). It is reported as an overruling whose treating bench cannot be relied on: no treating
 * judgment bench, and a recorded bench that is never "larger". The verdict rule therefore counts it as an overruling
 * that does not qualify: UNVERIFIED on its own, never VERIFIED, and it never hides another overruling that qualifies
 * (P4-2: the strongest warning wins). Its own module (type imports only), so the port and the corpus adapter both use
 * it without an import cycle; authority.ts re-exports it.
 */
export const PENDING_OVERRULING: Readonly<TreatmentFact> = Object.freeze({
  kind: "overruled",
  treatingJudgmentBench: null,
  recordedTreatingBench: "single",
})
