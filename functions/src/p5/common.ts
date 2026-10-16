import type { DocumentData, Transaction } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"
import { HttpError } from "../http/errors"
import type { IdempotentOperation } from "../http/idempotency"
import type { RateKind } from "../http/rateLimit"
import { errorCode, logFailure } from "../log"
import { appendAudit } from "./audit"
import { isRole, type Caller, type FirmlessIdentity, type Role } from "./auth"
import { isKnownClassification, rankOf } from "./classification"
import { requirePermission } from "./permission"
import type { FirmAdminAction } from "@/platform/p5/permissionDecision"

/**
 * Shared scaffolding for the P5 operations (identity.ts, mfa.ts, gates.ts): the
 * Operation type the HTTP `api` runs (http/router.ts — the only entry point, U-1),
 * request parsing, the one-audit-row-per-call CallAudit / runAudited wrapper, and
 * the target-user checks.
 */

export type Data = Record<string, unknown>

/**
 * The idempotency side of a call's effect (audit F09): stages the operation's effect marker in the effect's own
 * transaction (`IdempotentOperation.stageEffect`, a write-only `create`).
 */
export type EffectSink = Pick<IdempotentOperation, "stageEffect">

/** Collects the audit context of one call and writes its single row. */
export class CallAudit {
  firmId = ""
  target: string
  /**
   * Set by the HTTP router for a POST route whose mode is not `rerun` (audit F09): staging the call's allow row in a
   * transaction also stages the operation's effect marker there, so the effect and the operation's "effect committed"
   * state commit together, and a second effect of the same operation cannot commit.
   */
  effects: EffectSink | undefined
  private readonly actorId: string
  private written = false

  /** `actorId` is the verified uid, or "anonymous" for an unauthenticated call. */
  constructor(
    private readonly action: string,
    actorId: string,
    target: string
  ) {
    this.actorId = actorId
    this.target = target
  }

  /** Records the allow decision; throws 503 audit_unavailable if it cannot be written. */
  async allow(): Promise<void> {
    await this.write("allow", "ok")
  }

  /** Records a deny decision unless this call already has its row. */
  async deny(reason: string): Promise<void> {
    if (!this.written) await this.write("deny", reason)
  }

  /**
   * Stages the row in a transaction; call `committed()` once that transaction has committed. When the call runs as an
   * idempotent operation (`effects`), the operation's effect marker is staged too: for an allow row by default, for a
   * deny row only with `{ effect: true }` (a refusal that commits a domain change, e.g. approveDraft's `gate_blocked`),
   * and never with `{ effect: false }` (a caller that handles the marker itself) or after this call's row has committed.
   */
  async stage(tx: Transaction, decision: "allow" | "deny", reason: string, opts: { effect?: boolean } = {}): Promise<void> {
    try {
      await appendAudit(this.row(decision, reason), tx)
    } catch {
      throw new HttpError(503, "audit_unavailable")
    }
    if ((opts.effect ?? decision === "allow") && !this.written) this.effects?.stageEffect(tx)
  }

  committed(): void {
    this.written = true
  }

  /**
   * Records a post-commit incident (e.g. a failed claims sync) as an extra deny
   * row, after this call's decision row. Best effort: a failure is logged.
   */
  async incident(reason: string): Promise<void> {
    try {
      await appendAudit(this.row("deny", reason))
    } catch (err) {
      logFailure("identity incident audit failed", err)
    }
  }

  private async write(decision: "allow" | "deny", reason: string): Promise<void> {
    try {
      await appendAudit(this.row(decision, reason))
    } catch {
      throw new HttpError(503, "audit_unavailable")
    }
    this.written = true
  }

  private row(decision: "allow" | "deny", reason: string) {
    return {
      firmId: this.firmId,
      actorId: this.actorId,
      action: this.action,
      target: this.target,
      classification: "internal" as Classification,
      decision,
      reason,
    }
  }
}

export { errorCode, logFailure }

/**
 * Runs an operation body; any failure without an audit row yet is audited as
 * a deny and rethrown as is (a failed deny write throws 503 audit_unavailable instead).
 */
export async function runAudited<T>(audit: CallAudit, body: () => Promise<T>): Promise<T> {
  try {
    return await body()
  } catch (err) {
    if (!(err instanceof HttpError)) logFailure("identity operation failed", err)
    await audit.deny(err instanceof HttpError ? err.code : "internal")
    throw err
  }
}

/**
 * A firm-bound, authenticated session: the Caller, whether the token has a second factor, and
 * the router's clock for this request (`now`, epoch ms; absent outside the router → Date.now()).
 * `idempotencyKey` is the request's Idempotency-Key on POST/PUT (absent on GET), for keys of
 * jobs the call causes (P3-4, `jobKey`). `route` is the operation's route, `"POST /api/..."` (set with the key; P3-38).
 * `startedAtMs` is when the router received the request on the real clock (`Date.now()`, never the injectable `now`),
 * so an operation can bound the time spent before it starts paid work (P1 committeeBrain, re-audit R3-D2).
 * `operation` is the request's idempotent operation on POST/PUT (audit F09): its fence, its effect marker and, on a
 * `resume` route, its `prior`.
 */
export type Session = {
  caller: Caller
  secondFactor: boolean
  now?: number
  idempotencyKey?: string
  route?: string
  startedAtMs?: number
  operation?: IdempotentOperation
}

export type { FirmlessIdentity }

/**
 * One P5 operation, independent of its transport. The HTTP router
 * authenticates (firm-bound or firmless), applies the per-user rate limit for
 * `kind`, creates the CallAudit for `action` / `target` and runs `run` inside
 * `runAudited`. `mfaExempt(uid, data)` exempts the call from the firm's MFA
 * policy (see bindHttpSession).
 */
export type FirmOperation<T = unknown> = {
  auth: "firm"
  kind: RateKind
  action: string
  target: string
  mfaExempt?: (uid: string, data: Data) => boolean
  run: (session: Session, data: Data, audit: CallAudit) => Promise<T>
}
export type FirmlessOperation<T = unknown> = {
  auth: "firmless"
  kind: RateKind
  action: string
  target: string
  run: (who: FirmlessIdentity, data: Data, audit: CallAudit) => Promise<T>
}
export type Operation<T = unknown> = FirmOperation<T> | FirmlessOperation<T>

/**
 * Authorises a firm-administration operation through P5 checkPermission with its explicit
 * action (identity.manage_users, identity.set_claims, identity.deactivate, mfa.enforce,
 * mfa.approve_disable): partner only, decided by the shared table and audited (U-2 / I-3).
 * Deny → 403 partner_only.
 */
export async function requirePartner(caller: Caller, action: FirmAdminAction): Promise<void> {
  await requirePermission(caller, action)
}

/** A safe single Firestore document id: non-empty, ≤128 chars, no "/", not "." / "..", not reserved `__*__`. */
export function isSafeDocId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value.length <= 128 &&
    !value.includes("/") &&
    value !== "." &&
    value !== ".." &&
    !/^__.*__$/.test(value)
  )
}

/** Firestore's own document-id rule: non-empty, no `/`, not `.` or `..`, not `__.*__`, at most 1500 bytes UTF-8. */
export function isFirestoreDocId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    !value.includes("/") &&
    value !== "." &&
    value !== ".." &&
    !/^__.*__$/.test(value) &&
    Buffer.byteLength(value, "utf8") <= 1500
  )
}

/** A user id that is also a safe single Firestore document id. */
export function parseUid(value: unknown): string {
  if (!isSafeDocId(value)) throw new HttpError(400, "invalid_uid")
  return value
}

export function parseRole(value: unknown): Role {
  if (!isRole(value)) throw new HttpError(400, "invalid_role")
  return value
}

/**
 * The caller may only act on users cleared no higher than themselves (per the
 * target's users doc). A missing or malformed clearance counts as the highest rank.
 */
export function requireTargetWithinOwnClearance(caller: Caller, raw: unknown): void {
  const targetRank = rankOf(isKnownClassification(raw) ? raw : "privileged-restricted")
  if (!(targetRank <= rankOf(caller.clearanceLevel))) throw new HttpError(403, "exceeds_own_clearance")
}

export const usersRef = () => adminDb().collection("users")

/**
 * Reads the target's users doc inside a transaction and applies the shared
 * target checks: missing → 404 not_found, other firm → 403 cross_firm,
 * clearance above the caller's → 403 exceeds_own_clearance.
 */
export async function readTargetDoc(tx: Transaction, caller: Caller, uid: string): Promise<DocumentData> {
  const doc = (await tx.get(usersRef().doc(uid))).data()
  if (!doc) throw new HttpError(404, "not_found")
  if (doc.firmId !== caller.firmId) throw new HttpError(403, "cross_firm")
  requireTargetWithinOwnClearance(caller, doc.clearanceLevel)
  return doc
}
