import { CLASSIFICATION_RANKS, type Classification } from "@/platform/p1/types"

/**
 * Own-property classification guard. `isClassification` in platform/p1 uses
 * `in`, which also accepts Object.prototype keys ("constructor", "__proto__",
 * ...); P5 must fail closed on those, so it uses this guard instead.
 */
export function isKnownClassification(value: unknown): value is Classification {
  return typeof value === "string" && Object.hasOwn(CLASSIFICATION_RANKS, value)
}

/** Integer rank of a classification; throws for anything that is not a known label. */
export function rankOf(label: Classification): number {
  const rank: unknown = isKnownClassification(label) ? CLASSIFICATION_RANKS[label] : undefined
  if (typeof rank !== "number" || !Number.isInteger(rank)) {
    throw new Error(`unknown classification: ${String(label)}`)
  }
  return rank
}
