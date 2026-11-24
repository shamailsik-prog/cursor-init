/**
 * Sources a learner may cite. Anything else is refused.
 * Accepted drafts and corrections are the firm record. The other four are the
 * L4.6 inputs (admin folder, user activity, a connected computer, a curated update).
 */
export const AUTHORISED_LEARNING_SOURCES = [
  "accepted-draft",
  "accepted-correction",
  "admin-folder",
  "user-activity",
  "connected-computer",
  "industry-update",
] as const

export type LearningSource = (typeof AUTHORISED_LEARNING_SOURCES)[number]

export function parseLearningSource(value: unknown): LearningSource {
  if (typeof value !== "string") throw new Error("learning source is not authorised")
  const source = value.trim()
  if (!(AUTHORISED_LEARNING_SOURCES as readonly string[]).includes(source)) {
    throw new Error("learning source is not authorised")
  }
  return source as LearningSource
}
