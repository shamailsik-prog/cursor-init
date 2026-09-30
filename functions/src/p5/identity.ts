import { logger } from "firebase-functions"
import { onCall, type CallableRequest } from "firebase-functions/v2/https"
import { FieldValue, type Transaction } from "firebase-admin/firestore"
import type { UserRecord } from "firebase-admin/auth"
import type { Classification } from "@/platform/p1/types"
import { adminAuth, adminDb } from "../admin"
import { REGION } from "../health"
import { HttpError, toHttpsError } from "../http/errors"
import { appendAudit } from "./audit"
import { callerFromCallable, callerWithoutFirm, isRole, type Caller, type Role } from "./auth"
import { isKnownClassification, rankOf } from "./classification"

/**
 * Module 40 identity lifecycle callables: firm onboarding, firm users, claims
 * and deactivation. Every call writes exactly one audit_log row (allow or
 * deny). Allowed mutations are audited *before* they run, so a failed audit
 * write stops the call (503 audit_unavailable → `unavailable`) with nothing changed.
 */

type Data = Record<string, unknown>

const MAX_FIRM_NAME = 200
const MAX_EMAIL = 254
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const FOUNDER = { role: "partner", clearanceLevel: "privileged-restricted" } as const

function dataOf(request: CallableRequest<unknown>): Data {
  const d = request.data
  return d !== null && typeof d === "object" && !Array.isArray(d) ? (d as Data) : {}
}

/** Collects the audit context of one call and writes its single row. */
class CallAudit {
  firmId = ""
  target: string
  private readonly actorId: string
  private written = false

  constructor(
    private readonly action: string,
    request: CallableRequest<unknown>,
    target: string
  ) {
    // request.auth is the runtime-verified token; unauthenticated calls are "anonymous".
    this.actorId = request.auth?.uid ?? "anonymous"
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
    await appendAudit(this.row(decision, reason), tx)
  }

  committed(): void {
    this.written = true
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

/** Runs a callable body; any failure without an audit row yet is audited as a deny, then mapped to HttpsError. */
async function audited<T>(audit: CallAudit, body: () => Promise<T>): Promise<T> {
  try {
    return await body()
  } catch (err) {
    if (!(err instanceof HttpError)) logger.error("identity callable failed", err)
    const reason = err instanceof HttpError ? err.code : "internal"
    try {
      await audit.deny(reason)
    } catch (auditErr) {
      throw toHttpsError(auditErr)
    }
    throw toHttpsError(err)
  }
}

function requirePartner(caller: Caller): void {
  if (caller.role !== "partner") throw new HttpError(403, "partner_only")
}

function forbidPlatformAdmin(data: Data): void {
  if (Object.hasOwn(data, "platformAdmin")) throw new HttpError(403, "platform_admin_forbidden")
}

/** A safe single Firestore document id: non-empty, ≤128 chars, no "/", not "." / "..", not reserved `__*__`. */
function isSafeDocId(value: unknown): value is string {
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
function parseUid(value: unknown): string {
  if (!isSafeDocId(value)) throw new HttpError(400, "invalid_uid")
  return value
}

function parseEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim() : ""
  if (email.length > MAX_EMAIL || !EMAIL_RE.test(email)) throw new HttpError(400, "invalid_email")
  return email
}

function parseRole(value: unknown): Role {
  if (!isRole(value)) throw new HttpError(400, "invalid_role")
  return value
}

function parseClearance(value: unknown): Classification {
  if (!isKnownClassification(value)) throw new HttpError(400, "invalid_clearance")
  return value
}

function requireWithinOwnClearance(caller: Caller, clearance: Classification): void {
  if (!(rankOf(clearance) <= rankOf(caller.clearanceLevel))) throw new HttpError(403, "exceeds_own_clearance")
}

/**
 * The caller may only act on users cleared no higher than themselves. A target
 * whose clearance claim is missing or malformed is treated as the highest rank.
 */
function requireTargetWithinOwnClearance(caller: Caller, target: UserRecord): void {
  const raw: unknown = target.customClaims?.clearanceLevel
  const targetRank = rankOf(isKnownClassification(raw) ? raw : "privileged-restricted")
  if (!(targetRank <= rankOf(caller.clearanceLevel))) throw new HttpError(403, "exceeds_own_clearance")
}

/** The target user, if it belongs to the caller's firm (per its current custom claims). Unknown → cross_firm too. */
async function userInFirm(uid: string, firmId: string): Promise<UserRecord> {
  let user: UserRecord
  try {
    user = await adminAuth().getUser(uid)
  } catch (err) {
    if ((err as { code?: unknown })?.code === "auth/user-not-found") throw new HttpError(403, "cross_firm")
    throw err
  }
  if (user.customClaims?.firmId !== firmId) throw new HttpError(403, "cross_firm")
  return user
}

async function emailTaken(email: string): Promise<boolean> {
  try {
    await adminAuth().getUserByEmail(email)
    return true
  } catch (err) {
    if ((err as { code?: unknown })?.code === "auth/user-not-found") return false
    throw err
  }
}

/**
 * onboardFirm({ name }) → { firmId }.
 * Allowed for a caller without a firmId claim when the platform has not been
 * bootstrapped yet (race-safe: `platform/bootstrap` is read and created in one
 * transaction), or when the caller holds `platformAdmin: true`. Creates the
 * firm and the caller's users doc, then makes the caller its founding partner.
 *
 * Recoverable: the claims are set after the transaction commits, so if that
 * fails the founder is left without claims. `platform/bootstrap.founderUid`
 * lets that founder call again: when the caller is the founder, has no firmId
 * claim and `firms/{firstFirmId}` exists, the founder claims and users doc are
 * re-applied idempotently and the same firmId is returned (audited as
 * allow `bootstrap_resume`).
 */
export async function onboardFirmHandler(request: CallableRequest<unknown>): Promise<{ firmId: string }> {
  const data = dataOf(request)
  const audit = new CallAudit("identity.onboardFirm", request, "platform/bootstrap")
  return audited(audit, async () => {
    const { uid, claims } = await callerWithoutFirm(request.auth)
    const name = typeof data.name === "string" ? data.name.trim() : ""
    if (name === "" || name.length > MAX_FIRM_NAME) throw new HttpError(400, "invalid_name")
    if (claims.firmId !== undefined) throw new HttpError(409, "already_onboarded")
    const isPlatformAdmin = claims.platformAdmin === true

    const db = adminDb()
    const bootstrapRef = db.collection("platform").doc("bootstrap")
    const firmRef = db.collection("firms").doc()
    const firmId = firmRef.id

    const userRef = db.collection("users").doc(uid)
    const founderDoc = (firmId: string) => ({ firmId, ...FOUNDER, mfaEnabled: false, active: true })

    const outcome = await db.runTransaction(async (tx) => {
      const bootstrap = await tx.get(bootstrapRef)
      const marker = bootstrap.data()
      if (marker?.founderUid === uid && isSafeDocId(marker.firstFirmId)) {
        const firstFirmId = marker.firstFirmId
        const [firm, userDoc] = await Promise.all([
          tx.get(db.collection("firms").doc(firstFirmId)),
          tx.get(userRef),
        ])
        if (firm.exists) {
          audit.firmId = firstFirmId
          audit.target = `firms/${firstFirmId}`
          await audit.stage(tx, "allow", "bootstrap_resume")
          if (userDoc.exists) tx.set(userRef, { firmId: firstFirmId, ...FOUNDER, active: true }, { merge: true })
          else tx.set(userRef, { ...founderDoc(firstFirmId), createdAt: FieldValue.serverTimestamp() })
          return { kind: "resumed" as const, firmId: firstFirmId }
        }
      }
      if (bootstrap.exists && !isPlatformAdmin) {
        // Reset: an earlier attempt of this transaction may have taken the allow branch.
        audit.firmId = ""
        audit.target = "platform/bootstrap"
        await audit.stage(tx, "deny", "bootstrap_closed")
        return { kind: "denied" as const }
      }
      audit.firmId = firmId
      audit.target = `firms/${firmId}`
      await audit.stage(tx, "allow", "ok")
      const now = FieldValue.serverTimestamp()
      if (!bootstrap.exists) tx.create(bootstrapRef, { firstFirmId: firmId, founderUid: uid, at: now })
      tx.create(firmRef, { name, dataResidency: "PK", plan: "internal", createdAt: now })
      tx.set(userRef, { ...founderDoc(firmId), createdAt: now })
      return { kind: "created" as const, firmId }
    })
    audit.committed()
    if (outcome.kind === "denied") throw new HttpError(403, "bootstrap_closed")

    await adminAuth().setCustomUserClaims(uid, { ...claims, firmId: outcome.firmId, ...FOUNDER })
    return { firmId: outcome.firmId }
  })
}

/**
 * createFirmUser({ firmId, email, role, clearanceLevel }) → { uid }. Partner only.
 * The new user's clearance may not exceed the caller's; `platformAdmin` can never be set.
 */
export async function createFirmUserHandler(request: CallableRequest<unknown>): Promise<{ uid: string }> {
  const data = dataOf(request)
  const audit = new CallAudit("identity.createFirmUser", request, "users")
  return audited(audit, async () => {
    const caller = await callerFromCallable(request.auth, data.firmId as string)
    audit.firmId = caller.firmId
    requirePartner(caller)
    forbidPlatformAdmin(data)
    const email = parseEmail(data.email)
    const role = parseRole(data.role)
    const clearanceLevel = parseClearance(data.clearanceLevel)
    requireWithinOwnClearance(caller, clearanceLevel)

    const uid = adminDb().collection("users").doc().id
    audit.target = `users/${uid}`
    if (await emailTaken(email)) throw new HttpError(409, "already_exists")
    await audit.allow()

    try {
      await adminAuth().createUser({ uid, email })
    } catch (err) {
      if ((err as { code?: unknown })?.code === "auth/email-already-exists") throw new HttpError(409, "already_exists")
      throw err
    }
    try {
      await adminAuth().setCustomUserClaims(uid, { firmId: caller.firmId, role, clearanceLevel })
      await adminDb().collection("users").doc(uid).create({
        firmId: caller.firmId,
        role,
        clearanceLevel,
        mfaEnabled: false,
        active: true,
        createdAt: FieldValue.serverTimestamp(),
      })
    } catch (err) {
      // Do not leave a half-provisioned account behind.
      await adminAuth()
        .deleteUser(uid)
        .catch(() => undefined)
      throw err
    }
    return { uid }
  })
}

/**
 * setUserClaims({ firmId, uid, role?, clearanceLevel? }). Partner only, same firm, never self.
 * Other existing custom claims are preserved, except `platformAdmin`, which this
 * path can never set or strip (an existing value is carried through unchanged).
 * The target's current clearance may not exceed the caller's.
 * Order: Auth claims → `users/{uid}` → refresh-token revocation. If the users-doc
 * write fails, the claims are rolled back to their previous value before the
 * error is returned. Revocation ends existing sessions so the next sign-in
 * carries the new claims (callables and requireAuth reject revoked sessions).
 */
export async function setUserClaimsHandler(
  request: CallableRequest<unknown>
): Promise<{ uid: string; role: Role; clearanceLevel: Classification }> {
  const data = dataOf(request)
  const audit = new CallAudit("identity.setUserClaims", request, "users")
  return audited(audit, async () => {
    const caller = await callerFromCallable(request.auth, data.firmId as string)
    audit.firmId = caller.firmId
    requirePartner(caller)
    forbidPlatformAdmin(data)
    const uid = parseUid(data.uid)
    audit.target = `users/${uid}`
    const role = data.role === undefined ? undefined : parseRole(data.role)
    const clearanceLevel = data.clearanceLevel === undefined ? undefined : parseClearance(data.clearanceLevel)
    if (role === undefined && clearanceLevel === undefined) throw new HttpError(400, "nothing_to_change")
    if (uid === caller.uid) throw new HttpError(403, "self_change_forbidden")
    if (clearanceLevel !== undefined) requireWithinOwnClearance(caller, clearanceLevel)
    const target = await userInFirm(uid, caller.firmId)
    requireTargetWithinOwnClearance(caller, target)
    await audit.allow()

    const previous = { ...(target.customClaims ?? {}) }
    const next = { ...previous, ...(role && { role }), ...(clearanceLevel && { clearanceLevel }) }
    await adminAuth().setCustomUserClaims(uid, next)
    try {
      await adminDb()
        .collection("users")
        .doc(uid)
        .set(
          { firmId: caller.firmId, ...(role && { role }), ...(clearanceLevel && { clearanceLevel }), updatedAt: FieldValue.serverTimestamp() },
          { merge: true }
        )
    } catch (err) {
      await adminAuth()
        .setCustomUserClaims(uid, previous)
        .catch((rollbackErr: unknown) => logger.error("setUserClaims claims rollback failed", { uid, rollbackErr }))
      throw err
    }
    await adminAuth().revokeRefreshTokens(uid)
    return { uid, role: next.role as Role, clearanceLevel: next.clearanceLevel as Classification }
  })
}

/**
 * deactivateUser({ firmId, uid }). Partner only, same firm, never self.
 * Disables the Auth user, revokes its refresh tokens and sets users/{uid}.active=false.
 * Documents the user created are left untouched. The target's current
 * clearance may not exceed the caller's.
 *
 * Afterwards the user's old token is rejected with 401 `user_disabled`, not
 * `token_revoked`: both the Admin SDK's verifyIdToken(checkRevoked) and
 * callerFromCallable check `disabled` before revocation. The revocation still
 * matters: if the account is re-enabled, pre-deactivation tokens stay invalid
 * (`token_revoked`).
 */
export async function deactivateUserHandler(request: CallableRequest<unknown>): Promise<{ uid: string; active: false }> {
  const data = dataOf(request)
  const audit = new CallAudit("identity.deactivateUser", request, "users")
  return audited(audit, async () => {
    const caller = await callerFromCallable(request.auth, data.firmId as string)
    audit.firmId = caller.firmId
    requirePartner(caller)
    const uid = parseUid(data.uid)
    audit.target = `users/${uid}`
    if (uid === caller.uid) throw new HttpError(403, "self_change_forbidden")
    requireTargetWithinOwnClearance(caller, await userInFirm(uid, caller.firmId))
    await audit.allow()

    await adminAuth().updateUser(uid, { disabled: true })
    await adminAuth().revokeRefreshTokens(uid)
    await adminDb()
      .collection("users")
      .doc(uid)
      .set({ active: false, deactivatedAt: FieldValue.serverTimestamp() }, { merge: true })
    return { uid, active: false }
  })
}

export const onboardFirm = onCall({ region: REGION }, onboardFirmHandler)
export const createFirmUser = onCall({ region: REGION }, createFirmUserHandler)
export const setUserClaims = onCall({ region: REGION }, setUserClaimsHandler)
export const deactivateUser = onCall({ region: REGION }, deactivateUserHandler)
