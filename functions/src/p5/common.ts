import type { CallableRequest } from "firebase-functions/v2/https"
import type { DocumentData, Transaction } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"
import { HttpError, toHttpsError } from "../http/errors"
import { clientIp, rateLimit, rateLimitAnonymous, type RateKind } from "../http/rateLimit"
import { errorCode, logFailure } from "../log"
import { appendAudit } from "./audit"
import {
  callableSession,
  callerWithoutFirm,
  hasSecondFactor,
  isRole,
  type Caller,
  type FirmlessIdentity,
  type Role,
} from "./auth"
import { isKnownClassification, rankOf } from "./classification"

/**
 * Shared scaffolding for the P5 operations (identity.ts, mfa.ts): the
 * Operation type that both entry points run (the onCall callables here via
 * `callableHandler`, the HTTP `api` via http/router.ts), request parsing, the
 * one-audit-row-per-call CallAudit / audited wrapper, and the target-user checks.
 */

export type Data = Record<string, unknown>

/** Request headers as Node / express deliver them (lower-case names; a repeated header may be an array). */
export type Headers = Record<string, string | string[] | undefined>

/** A header's value by case-insensitive name; the first value of a repeated header. */
export function header(headers: Headers, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === wanted) return Array.isArray(v) ? v[0] : v
  }
  return undefined
}

export function dataOf(request: CallableRequest<unknown>): Data {
  const d = request.data
  return d !== null && typeof d === "object" && !Array.isArray(d) ? (d as Data) : {}
}

/** Collects the audit context of one call and writes its single row. */
export class CallAudit {
  firmId = ""
  target: string
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

  /** Stages the row in a transaction; call `committed()` once that transaction has committed. */
  async stage(tx: Transaction, decision: "allow" | "deny", reason: string): Promise<void> {
    try {
      await appendAudit(this.row(decision, reason), tx)
    } catch {
      throw new HttpError(503, "audit_unavailable")
    }
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

/** Like `runAudited`, with failures mapped to HttpsError for the callable protocol. */
export async function audited<T>(audit: CallAudit, body: () => Promise<T>): Promise<T> {
  try {
    return await runAudited(audit, body)
  } catch (err) {
    throw toHttpsError(err)
  }
}

/** A firm-bound, authenticated session: the Caller and whether the token has a second factor. */
export type Session = { caller: Caller; secondFactor: boolean }

export type { FirmlessIdentity }

/**
 * One P5 operation, independent of its transport. The entry point
 * authenticates (firm-bound or firmless), applies the per-user rate limit for
 * `kind` (the HTTP route takes the same kind), creates the CallAudit for
 * `action` / `target` and runs `run` inside `runAudited`, so the callable and
 * the HTTP route share one implementation. `mfaExempt(uid, data)` exempts the
 * call from the firm's MFA policy (see requireAuth / callerFromCallable).
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
 * The onCall handler for an operation: the firm comes from `data.firmId`
 * (callableSession), or the firmless path (callerWithoutFirm).
 *
 * Rate limits match the HTTP `api`: an auth failure first counts against the
 * client IP from `request.rawRequest` (60/min; over it the call is refused
 * with no audit row), then is audited as a deny as before. After auth the
 * per-user limit for `op.kind` applies (shared counters with HTTP, per-firm
 * overrides). A refused call fails with `resource-exhausted`, details
 * `{ code: "rate_limited", retryAfter }`, and is not audited.
 * `opts.now` pins the clock (tests).
 */
export function callableHandler<T>(
  op: Operation<T>,
  opts: { now?: () => number } = {}
): (request: CallableRequest<unknown>) => Promise<T> {
  const clock = opts.now ?? Date.now
  return async (request) => {
    const data = dataOf(request)
    const now = clock()
    // request.auth is the runtime-verified token; unauthenticated calls are "anonymous".
    const audit = new CallAudit(op.action, request.auth?.uid ?? "anonymous", op.target)

    let run: () => Promise<T>
    let limit: () => Promise<void>
    try {
      if (op.auth === "firmless") {
        const who = await callerWithoutFirm(request.auth)
        run = () => op.run(who, data, audit)
        limit = () => rateLimit(who, op.kind, { now })
      } else {
        const mfaExempt = request.auth !== undefined && op.mfaExempt?.(request.auth.uid, data) === true
        const { caller, firm } = await callableSession(request.auth, data.firmId as string, { mfaExempt })
        run = () => op.run({ caller, secondFactor: hasSecondFactor(request.auth!.token) }, data, audit)
        limit = () => rateLimit(caller, op.kind, { firm, now })
      }
    } catch (err) {
      // rawRequest is always set by the onCall runtime; direct handler calls (tests) may omit it.
      if (err instanceof HttpError && request.rawRequest) {
        await rateLimitAnonymous(clientIp(request.rawRequest), now).catch((limitErr: unknown) => {
          throw toHttpsError(limitErr)
        })
      }
      return audited(audit, () => Promise.reject(err))
    }
    await limit().catch((limitErr: unknown) => {
      throw toHttpsError(limitErr)
    })
    return audited(audit, run)
  }
}

export function requirePartner(caller: Caller): void {
  if (caller.role !== "partner") throw new HttpError(403, "partner_only")
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
