import { canonicalPayload } from "@/platform/p6/masterStore"

/** Marker on a sealed learning payload. The master body is `l46After`, not this envelope. */
export const LEARNING_BASELINE = "baseline" as const

/** Only a proposal whose source module is L4.6 is a learning envelope. Shape alone is not. */
export const LEARNING_SOURCE_MODULE = "L4.6"

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

/** A learning envelope only when the proposal was sealed by L4.6 and the payload has the baseline fields. */
export function learningEnvelope(payload: unknown, sourceModule: string): LearningBaselinePayload | null {
  if (sourceModule !== LEARNING_SOURCE_MODULE || !isLearningBaseline(payload)) return null
  return payload
}

/** Body that a sealed apply writes. An L4.6 envelope contributes `l46After` only. Any other payload is stored whole. */
export function masterBody(payload: unknown, sourceModule: string): unknown {
  return learningEnvelope(payload, sourceModule)?.l46After ?? payload
}

/** True when the live entry is the baseline the learner recorded. A missing entry matches only a missing before. */
export function baselineMatchesLive(live: unknown | undefined, before: unknown): boolean {
  if (before === undefined) return live === undefined
  if (live === undefined) return false
  return canonicalPayload(live) === canonicalPayload(before)
}

/**
 * Non-L4.6 payloads are not baseline-checked, even when they have the envelope shape.
 * An L4.6 payload that is not an envelope does not match.
 */
export function sealedBaselineMatches(live: unknown | undefined, payload: unknown, sourceModule: string): boolean {
  if (sourceModule !== LEARNING_SOURCE_MODULE) return true
  if (!isLearningBaseline(payload)) return false
  if (payload.l46BeforeMissing) return live === undefined
  return baselineMatchesLive(live, payload.l46Before)
}
