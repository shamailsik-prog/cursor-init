import type { RouteRule } from "./types"

export type RouteDecision = { queue: "lawyer" | "follow_up"; assigneeId: string | null }

/**
 * First matching rule wins. A follow-up (ambiguous court or entity) and an
 * unknown practice area both go to the follow-up queue. No rule is invented.
 */
export function routeByRules(input: { practiceArea: string | null; followUp: boolean }, rules: readonly RouteRule[]): RouteDecision {
  if (input.followUp || input.practiceArea === null) return { queue: "follow_up", assigneeId: null }
  const match = rules.find((rule) => rule.practiceArea === input.practiceArea)
  if (!match) return { queue: "follow_up", assigneeId: null }
  return { queue: "lawyer", assigneeId: match.assigneeId }
}
