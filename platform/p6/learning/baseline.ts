import { canonicalPayload } from "@/platform/p6/masterStore"

/** Marker on a sealed learning payload. The master body is `l46After`, not this envelope. */
export const LEARNING_BASELINE = "baseline" as const

export type LearningBaselinePayload = {
  l46: typeof LEARNING_BASELINE
  l46BeforeMissing: boolean
  l46Before: unknown
  l46After: unknown
}

export function learningBaselinePayload(before: unknown, after: unknown): LearningBaselinePayload {
  return {
    l46: LEARNING_BASELINE,
    l46BeforeMissing: before === undefined,
    l46Before: before === undefined ? null : before,
    l46After: after,
  }
}

export function isLearningBaseline(payload: unknown): payload is LearningBaselinePayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false
  const record = payload as Record<string, unknown>
  return record.l46 === LEARNING_BASELINE && typeof record.l46BeforeMissing === "boolean" && "l46Before" in record && "l46After" in record
}

/** Body that a sealed apply writes. A learning envelope contributes `l46After` only. */
export function masterBody(payload: unknown): unknown {
  return isLearningBaseline(payload) ? payload.l46After : payload
}

/** True when the live entry is the baseline the learner recorded. A missing entry matches only a missing before. */
export function baselineMatchesLive(live: unknown | undefined, before: unknown): boolean {
  if (before === undefined) return live === undefined
  if (live === undefined) return false
  return canonicalPayload(live) === canonicalPayload(before)
}

/** Non-learning payloads are not baseline-checked. A learning envelope must still match. */
export function sealedBaselineMatches(live: unknown | undefined, payload: unknown): boolean {
  if (!isLearningBaseline(payload)) return true
  if (payload.l46BeforeMissing) return live === undefined
  return baselineMatchesLive(live, payload.l46Before)
}
