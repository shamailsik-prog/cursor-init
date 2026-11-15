import type { FollowUp } from "@/platform/spine/store"

/**
 * FA-D4-001-FU1-002: `resolve_follow_up` used to `setDoc` the in-memory follow-up. That creates a row
 * the database does not have and overwrites a row that is already resolved, another firm's, or on a
 * matter the caller cannot access. Both repositories call `decideFollowUpResolution` on the row they
 * just read, then `update` that row (never `set`, never merge). A refusal throws before any write.
 */

export type FollowUpResolveRefusal = "missing" | "already_resolved" | "wrong_firm" | "wrong_matter" | "not_resolvable"

/**
 * One code per refusal. The F02 router forwards a single `code` and drops every other field, so the
 * reason has to be the code (`functions/src/http/f02NextAuthority.ts` `errorCodeOf`).
 */
export const FOLLOW_UP_RESOLVE_CODES = {
  missing: "follow_up_not_found",
  wrong_firm: "follow_up_wrong_firm",
  wrong_matter: "follow_up_wrong_matter",
  already_resolved: "follow_up_already_resolved",
  not_resolvable: "follow_up_not_resolvable",
} as const satisfies Record<FollowUpResolveRefusal, string>

export class FollowUpResolveRefusedError extends Error {
  readonly code: (typeof FOLLOW_UP_RESOLVE_CODES)[FollowUpResolveRefusal]
  constructor(
    readonly followUpId: string,
    readonly reason: FollowUpResolveRefusal
  ) {
    super(`follow-up ${followUpId} resolve refused: ${reason}`)
    this.name = "FollowUpResolveRefusedError"
    this.code = FOLLOW_UP_RESOLVE_CODES[reason]
  }
}

export type FollowUpResolveCaller = {
  firmId: string
  actorId: string
  resolvedAt: number
  /** True when this caller may resolve a follow-up of this matter. */
  matterAllowed: (matterId: string) => boolean
}

const FOLLOW_UP_KINDS = ["case_number_reject", "l4_10_silence", "limitation_alert"] as const
type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number]

function isFollowUpKind(value: unknown): value is FollowUpKind {
  return FOLLOW_UP_KINDS.some((kind) => kind === value)
}

/**
 * The resolved follow-up, or a refusal. `stored` is the persisted document (`null` when there is none).
 * A resolvable row is `open`, or has no status (the legacy open shape). `resolved` and any other status refuse.
 * Firm is checked before matter: a foreign row whose matter the caller could otherwise access still refuses.
 */
export function decideFollowUpResolution(followUpId: string, stored: unknown, caller: FollowUpResolveCaller): FollowUp {
  if (stored === null || stored === undefined || typeof stored !== "object" || Array.isArray(stored)) {
    throw new FollowUpResolveRefusedError(followUpId, "missing")
  }
  const row = stored as Record<string, unknown>
  if (typeof row.id === "string" && row.id !== followUpId) {
    throw new FollowUpResolveRefusedError(followUpId, "not_resolvable")
  }
  const firmId = typeof row.firmId === "string" ? row.firmId : ""
  if (firmId === "" || firmId !== caller.firmId) {
    throw new FollowUpResolveRefusedError(followUpId, "wrong_firm")
  }
  const matterId = typeof row.matterId === "string" ? row.matterId : ""
  if (matterId === "" || !caller.matterAllowed(matterId)) {
    throw new FollowUpResolveRefusedError(followUpId, "wrong_matter")
  }
  if (row.status === "resolved") {
    throw new FollowUpResolveRefusedError(followUpId, "already_resolved")
  }
  if (row.status !== undefined && row.status !== null && row.status !== "open") {
    throw new FollowUpResolveRefusedError(followUpId, "not_resolvable")
  }
  if (!isFollowUpKind(row.kind) || !Number.isFinite(caller.resolvedAt) || caller.actorId === "") {
    throw new FollowUpResolveRefusedError(followUpId, "not_resolvable")
  }
  return {
    id: followUpId,
    firmId,
    matterId,
    courtId: typeof row.courtId === "string" ? row.courtId : "",
    raw: typeof row.raw === "string" ? row.raw : "",
    kind: row.kind,
    status: "resolved",
    resolvedBy: caller.actorId,
    resolvedAt: caller.resolvedAt,
  }
}
