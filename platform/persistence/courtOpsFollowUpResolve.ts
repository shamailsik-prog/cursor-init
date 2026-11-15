import { requireCallerFirmId } from "@/platform/persistence/callerFirm"
import { doc, runTransaction, type Firestore } from "@/platform/persistence/firestoreDbModular"
import { buildCourtOpsActivityRow } from "@/platform/persistence/workflowOpsActivity"
import type { FollowUp, SpineStore } from "@/platform/spine/store"

/**
 * FA-D4-001-FU1-002: `resolve_follow_up` reads the stored row and updates it only when the caller may
 * resolve it and it is open. A missing row, another firm, and a matter the caller cannot access are one
 * refusal, so the route can answer them with one body. The activity row is written in that same commit.
 */

export type FollowUpResolveRefusal = "not_found" | "already_resolved" | "not_resolvable"

/** One body for a missing, foreign, or hidden follow-up. The F02 router forwards `code` and drops the rest. */
export const FOLLOW_UP_NOT_FOUND_BODY = {
  error: "follow_up not found",
  code: "follow_up_not_found",
} as const

export const FOLLOW_UP_RESOLVE_CODES = {
  not_found: "follow_up_not_found",
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

export type FollowUpResolveInput = {
  id: string
  firmId: string
  actorId: string
  resolvedAt: number
  /** True when this caller may resolve a follow-up of this matter. */
  matterAllowed: (matterId: string) => boolean
  reason?: string
}

export type FollowUpResolveCaller = {
  firmId: string
  actorId: string
  resolvedAt: number
  matterAllowed: (matterId: string) => boolean
}

const FOLLOW_UP_KINDS = ["case_number_reject", "l4_10_silence", "limitation_alert"] as const
type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number]

function isFollowUpKind(value: unknown): value is FollowUpKind {
  return FOLLOW_UP_KINDS.some((kind) => kind === value)
}

/**
 * The resolved follow-up, or a refusal. Firm and matter are decided before any 409, so a hidden row that
 * is already resolved is still not_found. A resolvable row is `open`, or has no status (the legacy shape).
 */
export function decideFollowUpResolution(followUpId: string, stored: unknown, caller: FollowUpResolveCaller): FollowUp {
  if (stored === null || stored === undefined || typeof stored !== "object" || Array.isArray(stored)) {
    throw new FollowUpResolveRefusedError(followUpId, "not_found")
  }
  const row = stored as Record<string, unknown>
  const firmId = typeof row.firmId === "string" ? row.firmId : ""
  if (firmId === "" || firmId !== caller.firmId) {
    throw new FollowUpResolveRefusedError(followUpId, "not_found")
  }
  const matterId = typeof row.matterId === "string" ? row.matterId : ""
  if (matterId === "" || !caller.matterAllowed(matterId)) {
    throw new FollowUpResolveRefusedError(followUpId, "not_found")
  }
  if (typeof row.id === "string" && row.id !== followUpId) {
    throw new FollowUpResolveRefusedError(followUpId, "not_resolvable")
  }
  if (row.status === "resolved") {
    throw new FollowUpResolveRefusedError(followUpId, "already_resolved")
  }
  if (row.status !== undefined && row.status !== null && row.status !== "open") {
    throw new FollowUpResolveRefusedError(followUpId, "not_resolvable")
  }
  if (!isFollowUpKind(row.kind)) {
    throw new FollowUpResolveRefusedError(followUpId, "not_resolvable")
  }
  if (!Number.isFinite(caller.resolvedAt) || caller.actorId === "") {
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

export function courtOpsResolveActivityId(followUpId: string): string {
  return `ops:court_ops:follow_up:${followUpId}`
}

function resolutionActivity(follow: FollowUp, actorId: string, reason: string | undefined) {
  return buildCourtOpsActivityRow({
    id: courtOpsResolveActivityId(follow.id),
    firmId: follow.firmId,
    action: "court_ops_resolve_follow_up",
    actorId,
    classification: "internal",
    matterId: follow.matterId,
    documentId: null,
    followUpId: follow.id,
    queueType: "follow_up",
    status: follow.status ?? "resolved",
    detail: reason ?? follow.raw,
  })
}

/** Memory: read, decide, and write the row and its activity with no await between them. */
export async function resolveOpenFollowUpMemory(store: SpineStore, input: FollowUpResolveInput): Promise<FollowUp> {
  const firmId = requireCallerFirmId(input.firmId, "followUps.resolveOpen")
  const idx = store.followUps.findIndex((entry) => entry.id === input.id)
  const next = decideFollowUpResolution(input.id, idx < 0 ? null : store.followUps[idx], {
    firmId,
    actorId: input.actorId,
    resolvedAt: input.resolvedAt,
    matterAllowed: input.matterAllowed,
  })
  const row = store.followUps[idx]
  if (!row) throw new Error("follow-up resolve lost the row it had just accepted")
  row.status = "resolved"
  row.resolvedBy = input.actorId
  row.resolvedAt = input.resolvedAt
  const resolved = { ...row, ...next }
  store.workflowOpsActivity.set(courtOpsResolveActivityId(resolved.id), resolutionActivity(resolved, input.actorId, input.reason))
  return resolved
}

/**
 * Firestore: one transaction reads the document and updates only the resolution fields. `update` does not
 * create a missing document. The activity row is set in that same transaction, not with a later upsert.
 */
export async function resolveOpenFollowUpFirestore(db: Firestore, input: FollowUpResolveInput): Promise<FollowUp> {
  const firmId = requireCallerFirmId(input.firmId, "followUps.resolveOpen")
  if (typeof input.id !== "string" || input.id === "" || input.id.includes("/")) {
    throw new FollowUpResolveRefusedError(String(input.id), "not_found")
  }
  const ref = doc(db, "follow_ups", input.id)
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    const next = decideFollowUpResolution(input.id, snap.exists() ? snap.data() : null, {
      firmId,
      actorId: input.actorId,
      resolvedAt: input.resolvedAt,
      matterAllowed: input.matterAllowed,
    })
    tx.update(ref, {
      status: "resolved",
      resolvedBy: input.actorId,
      resolvedAt: input.resolvedAt,
    })
    tx.set(doc(db, "workflow_ops_activity", courtOpsResolveActivityId(next.id)), resolutionActivity(next, input.actorId, input.reason))
    return next
  })
}
