/** Classification ranks 0–4. Compare ranks, never label strings. */
export const CLASSIFICATION_RANKS = {
  public: 0,
  internal: 1,
  confidential: 2,
  privileged: 3,
  "privileged-restricted": 4,
} as const

export type Classification = keyof typeof CLASSIFICATION_RANKS

export function isClassification(value: unknown): value is Classification {
  return typeof value === "string" && value in CLASSIFICATION_RANKS
}

export function classificationRank(label: Classification): number {
  return CLASSIFICATION_RANKS[label]
}
