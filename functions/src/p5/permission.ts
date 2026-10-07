import type { Classification } from "@/platform/p1/types";
import {
  decide,
  type D1Action,
  type FirmAdminAction,
  type PermissionDecision,
} from "@/platform/p5/permissionDecision";
import { adminDb } from "../admin";
import { HttpError } from "../http/errors";
import { appendAudit } from "./audit";
import type { Caller } from "./auth";
import { isKnownClassification } from "./classification";

export type { PermissionDecision };

type Evaluation = PermissionDecision & { classification: Classification };

/**
 * P5 permission check (Layer 18 §4.5) for Cloud Functions: the shared decision table
 * (platform/p5/permissionDecision.ts — the same one the Next.js checkPermission evaluates,
 * I-3 / U-2) over matters/{id} and matter_members/{matterId}_{uid} read from Firestore.
 * Fails closed: a malformed matterId denies with "invalid-matter-id", a read error denies with
 * "store-unavailable"; every decision is audited (one audit_log row: action, decision, reason),
 * and if the audit write fails the result is deny "audit_unavailable".
 */
export async function checkPermission(
  caller: Caller,
  action: string,
  matterId?: string,
  extra?: { scope?: "own_matters" },
): Promise<PermissionDecision> {
  let evaluation: Evaluation;
  try {
    evaluation =
      matterId !== undefined && !isValidMatterId(matterId)
        ? {
            allow: false,
            reason: "invalid-matter-id",
            classification: "internal",
          }
        : await evaluate(caller, action, matterId, extra);
  } catch {
    evaluation = {
      allow: false,
      reason: "store-unavailable",
      classification: "internal",
    };
  }

  try {
    await appendAudit({
      firmId: caller.firmId,
      actorId: caller.uid,
      action,
      target:
        matterId !== undefined
          ? `matters/${matterId}`
          : `firms/${caller.firmId}`,
      classification: evaluation.classification,
      decision: evaluation.allow ? "allow" : "deny",
      reason: evaluation.reason,
    });
  } catch {
    return { allow: false, reason: "audit_unavailable" };
  }
  return { allow: evaluation.allow, reason: evaluation.reason };
}

/**
 * Authorises a firm-administration action (identity and MFA administration: partner only) or a D1 action
 * through checkPermission, so it is decided by the shared table and audited like every other
 * decision. Deny → 403 partner_only (the operations' existing error code); an audit failure →
 * 503 audit_unavailable. The operations keep their own extra guards (self-change, clearance
 * cap, last partner).
 */
export async function requirePermission(
  caller: Caller,
  action: FirmAdminAction | D1Action,
): Promise<void> {
  const decision = await checkPermission(caller, action);
  if (decision.allow) return;
  if (decision.reason === "audit_unavailable")
    throw new HttpError(503, "audit_unavailable");
  throw new HttpError(
    403,
    decision.reason === "partner-only"
      ? "partner_only"
      : decision.reason.replaceAll("-", "_"),
  );
}

/** A single Firestore document id: non-empty, no "/", not "." / "..", not reserved `__*__`. */
function isValidMatterId(id: string): boolean {
  return (
    id !== "" &&
    !id.includes("/") &&
    id !== "." &&
    id !== ".." &&
    !/^__.*__$/.test(id)
  );
}

async function evaluate(
  caller: Caller,
  action: string,
  matterId: string | undefined,
  extra: { scope?: "own_matters" } | undefined,
): Promise<Evaluation> {
  let matter: { firmId: string; classification: unknown } | null | undefined;
  let isMember = false;
  if (matterId) {
    const db = adminDb();
    const data = (await db.collection("matters").doc(matterId).get()).data();
    matter = data
      ? { firmId: data.firmId as string, classification: data.classification }
      : null;
    if (matter && matter.firmId === caller.firmId) {
      isMember = (
        await db
          .collection("matter_members")
          .doc(`${matterId}_${caller.uid}`)
          .get()
      ).exists;
    }
  }
  const decision = decide(caller, action, matter, isMember, extra);
  // The audit row carries the matter's classification once the matter is known to be in the
  // caller's firm (an unreadable one as the highest rank), otherwise "internal".
  const classification: Classification =
    matter && matter.firmId === caller.firmId
      ? isKnownClassification(matter.classification)
        ? matter.classification
        : "privileged-restricted"
      : "internal";
  return { ...decision, classification };
}
