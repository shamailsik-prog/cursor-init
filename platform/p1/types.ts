/** Classification ranks 0–4. Compare ranks, never label strings. */
export const CLASSIFICATION_RANKS = {
  public: 0,
  internal: 1,
  confidential: 2,
  privileged: 3,
  "privileged-restricted": 4,
} as const

export type Classification = keyof typeof CLASSIFICATION_RANKS

/**
 * Own labels only. `value in CLASSIFICATION_RANKS` also accepted inherited keys
 * ("constructor", "__proto__", "toString" …) whose "rank" is not a number, so
 * every rank comparison against them was false — i.e. it failed open.
 */
const CLASSIFICATION_LABELS: ReadonlySet<string> = new Set(Object.keys(CLASSIFICATION_RANKS))

export function isClassification(value: unknown): value is Classification {
  return typeof value === "string" && CLASSIFICATION_LABELS.has(value)
}

/** Throws on anything that is not an own classification label (fail closed). */
export function classificationRank(label: Classification): number {
  if (!isClassification(label)) {
    throw new Error("unknown classification label")
  }
  return CLASSIFICATION_RANKS[label]
}
