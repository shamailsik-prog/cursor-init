import type { SpineStore } from "@/platform/spine/store"

/**
 * Citation-gate partner override, bound to the authenticated caller.
 *
 * L17.1 (human control): "the gate's block is cleared only by a partner recording a reason".
 * The partner is the caller: a request body may name `partnerOverride.partnerId` only as
 * the session user (or omit it, in which case it is filled from the session). Naming anyone
 * else, or asking for an override without the partner role, is a 403; a blank reason is a 400.
 */
export type RawPartnerOverride = { partnerId?: string; reason?: string } | undefined

export type PartnerOverride = { partnerId: string; reason: string }

export type ResolvedPartnerOverride =
  | { ok: true; override: PartnerOverride | undefined }
  | { ok: false; status: 400 | 403; code: string; error: string }

export function resolvePartnerOverride(
  store: SpineStore,
  raw: RawPartnerOverride,
  callerId: string | undefined
): ResolvedPartnerOverride {
  if (raw === undefined || raw === null) return { ok: true, override: undefined }
  if (typeof raw !== "object") {
    return { ok: false, status: 400, code: "INVALID_OVERRIDE", error: "partnerOverride must be an object" }
  }
  const named = typeof raw.partnerId === "string" ? raw.partnerId.trim() : ""
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : ""
  if (!named && !reason) return { ok: true, override: undefined }
  if (!callerId) {
    return { ok: false, status: 403, code: "OVERRIDE_FORBIDDEN", error: "partner override requires an authenticated partner" }
  }
  if (named && named !== callerId) {
    return {
      ok: false,
      status: 403,
      code: "OVERRIDE_FORBIDDEN",
      error: "partnerOverride.partnerId must be the authenticated caller",
    }
  }
  const caller = store.users.get(callerId)
  if (!caller || caller.role !== "partner") {
    return { ok: false, status: 403, code: "OVERRIDE_FORBIDDEN", error: "partner role required to override the citation gate" }
  }
  if (!reason) {
    return { ok: false, status: 400, code: "OVERRIDE_REASON_REQUIRED", error: "partner override reason is required" }
  }
  return { ok: true, override: { partnerId: callerId, reason } }
}

/**
 * Service-level check (defence in depth, independent of the HTTP boundary): the override
 * counts only when the named partner is the caller, holds the partner role, belongs to the
 * firm that owns the matter, and recorded a reason.
 */
export function isEffectivePartnerOverride(
  store: SpineStore,
  override: PartnerOverride | undefined,
  caller: { actorId: string; firmId: string } | undefined
): override is PartnerOverride {
  if (!override || !caller) return false
  if (!override.reason || !override.reason.trim()) return false
  if (override.partnerId !== caller.actorId) return false
  const partner = store.users.get(caller.actorId)
  return !!partner && partner.role === "partner" && partner.firmId === caller.firmId
}
