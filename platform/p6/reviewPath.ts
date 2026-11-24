/**
 * One advisor pass (v19 L16.3 step 2, L5577–L5579).
 * Suggestions (L5.2), draft review (L11.1) and argument strategy (L11.2)
 * are modes of this pass. No model is called. Nothing is written to the master.
 */
import { assertP6ConsolidationEnabled } from "@/platform/p6/consolidationFlag"

export const REVIEW_MODES = ["suggestions", "draft-review", "argument"] as const
export type ReviewMode = (typeof REVIEW_MODES)[number]

export type ReviewPathInput = {
  draftId: string
  text: string
}

export type ReviewPathResult = {
  owner: "review"
  mode: ReviewMode
  pass: "advisor"
  composed: true
  draftId: string
}

let calls = 0

export function reviewPathCalls(): number {
  return calls
}

export function runReviewPath(input: ReviewPathInput & { mode: ReviewMode }): ReviewPathResult {
  assertP6ConsolidationEnabled()
  calls += 1
  return { owner: "review", mode: input.mode, pass: "advisor", composed: true, draftId: input.draftId }
}

export function suggestForDraft(input: ReviewPathInput): ReviewPathResult {
  return runReviewPath({ ...input, mode: "suggestions" })
}

export function reviewDraft(input: ReviewPathInput): ReviewPathResult {
  return runReviewPath({ ...input, mode: "draft-review" })
}

export function strategiseArgument(input: ReviewPathInput): ReviewPathResult {
  return runReviewPath({ ...input, mode: "argument" })
}
