import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"
import { appendAudit } from "./audit"
import type { Caller } from "./auth"
import { isKnownClassification, rankOf } from "./classification"

export type PermissionDecision = { allow: boolean; reason: string }

type Evaluation = PermissionDecision & { classification: Classification }

/**
 * Decision table ported from platform/p5/checkPermission.ts (reasons kept identical),
 * reading matters/{id} and matter_members/{matterId}_{uid} from Firestore.
 * Fails closed: a malformed matterId denies with "invalid-matter-id", a read
 * error denies with "store-unavailable"; every decision is
 * audited, and if the audit write fails the result is deny "audit_unavailable".
 */
export async function checkPermission(
  caller: Caller,
  action: string,
  matterId?: string,
  extra?: { scope?: "own_matters" }
): Promise<PermissionDecision> {
  let evaluation: Evaluation
  try {
    evaluation =
      matterId !== undefined && !isValidMatterId(matterId)
        ? { allow: false, reason: "invalid-matter-id", classification: "internal" }
        : await evaluate(caller, action, matterId, extra)
  } catch {
    evaluation = { allow: false, reason: "store-unavailable", classification: "internal" }
  }

  try {
    await appendAudit({
      firmId: caller.firmId,
      actorId: caller.uid,
      action,
      target: matterId !== undefined ? `matters/${matterId}` : `firms/${caller.firmId}`,
      classification: evaluation.classification,
      decision: evaluation.allow ? "allow" : "deny",
      reason: evaluation.reason,
    })
  } catch {
    return { allow: false, reason: "audit_unavailable" }
  }
  return { allow: evaluation.allow, reason: evaluation.reason }
}

/** A single Firestore document id: non-empty, no "/", not "." / "..", not reserved `__*__`. */
function isValidMatterId(id: string): boolean {
  return id !== "" && !id.includes("/") && id !== "." && id !== ".." && !/^__.*__$/.test(id)
}

async function evaluate(
  caller: Caller,
  action: string,
  matterId: string | undefined,
  extra: { scope?: "own_matters" } | undefined
): Promise<Evaluation> {
  const deny = (reason: string, classification: Classification = "internal"): Evaluation => ({
    allow: false,
    reason,
    classification,
  })
  const allow = (reason: string, classification: Classification = "internal"): Evaluation => ({
    allow: true,
    reason,
    classification,
  })

  if (caller.role === "intern" && (action === "research" || action === "draft")) {
    return deny("intern-channel-denied")
  }

  if (extra?.scope === "own_matters" || caller.role === "client") {
    if (action === "research" || action === "draft") return deny("client-channel-denied")
    if (action === "list_matters") return allow("client-own-matters")
  }

  if (action === "list_matters") return allow("ok")

  let classification: Classification = "internal"
  if (matterId) {
    const db = adminDb()
    const matterSnap = await db.collection("matters").doc(matterId).get()
    const matter = matterSnap.data()
    if (!matter || matter.firmId !== caller.firmId) return deny("cross-firm")

    const raw: unknown = matter.classification
    // Unknown classification: cannot prove clearance, so treat as the highest rank.
    classification = isKnownClassification(raw) ? raw : "privileged-restricted"

    const member = await db.collection("matter_members").doc(`${matterId}_${caller.uid}`).get()
    if (!member.exists) return deny("not-member", classification)

    if (!isKnownClassification(raw) || !(rankOf(caller.clearanceLevel) >= rankOf(raw))) {
      return deny("clearance", classification)
    }
  }

  if (action === "research" && caller.role === "client") return deny("client-research-denied", classification)

  return allow("ok", classification)
}
