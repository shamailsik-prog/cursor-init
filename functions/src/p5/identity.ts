import { logger } from "firebase-functions"
import { onCall, type CallableRequest } from "firebase-functions/v2/https"
import { FieldValue, type DocumentData, type Transaction } from "firebase-admin/firestore"
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
    try {
      await appendAudit(this.row(decision, reason), tx)
    } catch {
      throw new HttpError(503, "audit_unavailable")
    }
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

/** A loggable error code: the SDK's `code` string if any, never the message (which may carry an email). */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === "string" ? code : "unknown"
}

/** Logs a failure with a generic message, its code and (optionally) a uid; no raw error text. */
function logFailure(message: string, err: unknown, uid?: string): void {
  logger.error(message, uid === undefined ? { code: errorCode(err) } : { uid, code: errorCode(err) })
}

/** Runs a callable body; any failure without an audit row yet is audited as a deny, then mapped to HttpsError. */
async function audited<T>(audit: CallAudit, body: () => Promise<T>): Promise<T> {
  try {
    return await body()
  } catch (err) {
    if (!(err instanceof HttpError)) logFailure("identity callable failed", err)
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
 * The caller may only act on users cleared no higher than themselves (per the
 * target's users doc). A missing or malformed clearance counts as the highest rank.
 */
function requireTargetWithinOwnClearance(caller: Caller, raw: unknown): void {
  const targetRank = rankOf(isKnownClassification(raw) ? raw : "privileged-restricted")
  if (!(targetRank <= rankOf(caller.clearanceLevel))) throw new HttpError(403, "exceeds_own_clearance")
}

/** Requires the Auth user to exist in the caller's firm (per its custom claims). Unknown → cross_firm too. */
async function requireUserInFirm(uid: string, firmId: string): Promise<void> {
  let firmClaim: unknown
  try {
    firmClaim = (await adminAuth().getUser(uid)).customClaims?.firmId
  } catch (err) {
    if (errorCode(err) === "auth/user-not-found") throw new HttpError(403, "cross_firm")
    throw err
  }
  if (firmClaim !== firmId) throw new HttpError(403, "cross_firm")
}

const usersRef = () => adminDb().collection("users")

/**
 * Reads the target's users doc inside a transaction and applies the shared
 * target checks: missing → 404 not_found, other firm → 403 cross_firm,
 * clearance above the caller's → 403 exceeds_own_clearance.
 */
async function readTargetDoc(tx: Transaction, caller: Caller, uid: string): Promise<DocumentData> {
  const doc = (await tx.get(usersRef().doc(uid))).data()
  if (!doc) throw new HttpError(404, "not_found")
  if (doc.firmId !== caller.firmId) throw new HttpError(403, "cross_firm")
  requireTargetWithinOwnClearance(caller, doc.clearanceLevel)
  return doc
}

/**
 * Refuses (409 last_partner) a change that would leave the firm with no active
 * partner other than `leavingUid`. Read inside the transaction, so two partners
 * removing each other concurrently cannot both succeed.
 */
async function requireAnotherActivePartner(tx: Transaction, firmId: string, leavingUid: string): Promise<void> {
  const partners = await tx.get(
    usersRef().where("firmId", "==", firmId).where("role", "==", "partner").where("active", "==", true)
  )
  if (!partners.docs.some((d) => d.id !== leavingUid)) throw new HttpError(409, "last_partner")
}

function claimsVersionOf(doc: DocumentData | undefined): number {
  const v: unknown = doc?.claimsVersion
  return typeof v === "number" && Number.isInteger(v) ? v : 0
}

/**
 * Makes the Auth claims mirror `users/{uid}` (role, clearanceLevel, firmId,
 * claimsVersion), keeping unrelated claims. Re-reads the doc after each write
 * and repeats if a newer version committed meanwhile, so concurrent writers
 * converge on the latest doc state.
 */
async function syncClaimsFromDoc(uid: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const doc = (await usersRef().doc(uid).get()).data()
    if (!doc) throw new HttpError(404, "not_found")
    const existing = (await adminAuth().getUser(uid)).customClaims ?? {}
    await adminAuth().setCustomUserClaims(uid, {
      ...existing,
      firmId: doc.firmId,
      role: doc.role,
      clearanceLevel: doc.clearanceLevel,
      claimsVersion: claimsVersionOf(doc),
    })
    if (claimsVersionOf((await usersRef().doc(uid).get()).data()) === claimsVersionOf(doc)) return
  }
}

/** True when running as a deployed function (not tests/emulated scripts). */
function isHosted(): boolean {
  return Boolean(process.env.K_SERVICE || process.env.FUNCTION_TARGET)
}

/**
 * Hosted first-firm bootstrap gate: the caller's verified email must equal
 * SIKANDER_BOOTSTRAP_FOUNDER_EMAIL (case-insensitive). Unset → 409
 * bootstrap_not_configured; mismatch or unverified → 403 bootstrap_founder_mismatch.
 */
function requireBootstrapFounder(verifiedEmail: string | undefined): void {
  if (!isHosted()) return
  const expected = (process.env.SIKANDER_BOOTSTRAP_FOUNDER_EMAIL ?? "").trim().toLowerCase()
  if (expected === "") throw new HttpError(409, "bootstrap_not_configured")
  if (verifiedEmail?.trim().toLowerCase() !== expected) throw new HttpError(403, "bootstrap_founder_mismatch")
}

async function emailTaken(email: string): Promise<boolean> {
  try {
    await adminAuth().getUserByEmail(email)
    return true
  } catch (err) {
    if (errorCode(err) === "auth/user-not-found") return false
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
 * allow `bootstrap_resume`). A founder whose users doc is `active: false` is
 * not resumed.
 *
 * Hosted deploys (K_SERVICE / FUNCTION_TARGET set) additionally gate the very
 * first bootstrap on SIKANDER_BOOTSTRAP_FOUNDER_EMAIL, so a stranger cannot
 * win the race on a fresh deploy. The platformAdmin path is unaffected.
 */
export async function onboardFirmHandler(request: CallableRequest<unknown>): Promise<{ firmId: string }> {
  const data = dataOf(request)
  const audit = new CallAudit("identity.onboardFirm", request, "platform/bootstrap")
  return audited(audit, async () => {
    const { uid, claims, verifiedEmail } = await callerWithoutFirm(request.auth)
    const name = typeof data.name === "string" ? data.name.trim() : ""
    if (name === "" || name.length > MAX_FIRM_NAME) throw new HttpError(400, "invalid_name")
    if (claims.firmId !== undefined) throw new HttpError(409, "already_onboarded")
    const isPlatformAdmin = claims.platformAdmin === true

    const db = adminDb()
    const bootstrapRef = db.collection("platform").doc("bootstrap")
    const firmRef = db.collection("firms").doc()
    const firmId = firmRef.id

    const userRef = db.collection("users").doc(uid)
    const founderDoc = (founderFirmId: string) => ({ firmId: founderFirmId, ...FOUNDER, mfaEnabled: false, active: true })

    const outcome = await db.runTransaction(async (tx) => {
      const bootstrap = await tx.get(bootstrapRef)
      const marker = bootstrap.data()
      if (marker?.founderUid === uid && isSafeDocId(marker.firstFirmId)) {
        const firstFirmId = marker.firstFirmId
        const [firm, userDoc] = await Promise.all([
          tx.get(db.collection("firms").doc(firstFirmId)),
          tx.get(userRef),
        ])
        if (firm.exists && userDoc.data()?.active !== false) {
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
      if (!bootstrap.exists && !isPlatformAdmin) requireBootstrapFounder(verifiedEmail)
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
      if (errorCode(err) === "auth/email-already-exists") throw new HttpError(409, "already_exists")
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
        .catch((rollbackErr: unknown) => logFailure("createFirmUser rollback failed", rollbackErr, uid))
      throw err
    }
    return { uid }
  })
}

/**
 * setUserClaims({ firmId, uid, role?, clearanceLevel? }). Partner only, same firm, never self.
 *
 * `users/{uid}` is the source of truth and changes are serialised per target:
 * a transaction re-reads the doc, re-checks the target's clearance against the
 * fresh value, refuses to demote the firm's last active partner (409
 * last_partner), and writes the new role/clearance with `claimsVersion + 1`.
 * After commit the Auth claims are set from the committed doc (other existing
 * claims, including `platformAdmin`, are kept: this path can neither set nor
 * strip it), then refresh tokens are revoked so sessions end and the next
 * sign-in carries the new claims. If setting the claims fails, the doc is
 * reverted to its prior role/clearance, but only while `claimsVersion` is
 * still ours (a newer change stays authoritative), and the error is returned.
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
    await requireUserInFirm(uid, caller.firmId)

    const userRef = usersRef().doc(uid)
    const change = await adminDb().runTransaction(async (tx) => {
      const current = await readTargetDoc(tx, caller, uid)
      const nextRole: unknown = role ?? current.role
      const nextClearance: unknown = clearanceLevel ?? current.clearanceLevel
      if (!isRole(nextRole) || !isKnownClassification(nextClearance)) throw new HttpError(409, "target_state_invalid")
      if (current.role === "partner" && current.active === true && nextRole !== "partner") {
        await requireAnotherActivePartner(tx, caller.firmId, uid)
      }
      const version = claimsVersionOf(current) + 1
      await audit.stage(tx, "allow", "ok")
      tx.update(userRef, {
        role: nextRole,
        clearanceLevel: nextClearance,
        claimsVersion: version,
        updatedAt: FieldValue.serverTimestamp(),
      })
      return { version, role: nextRole, clearanceLevel: nextClearance, before: { role: current.role, clearanceLevel: current.clearanceLevel } }
    })
    audit.committed()

    try {
      await syncClaimsFromDoc(uid)
    } catch (err) {
      await revertIfStillOurs(uid, change.version, change.before).catch((revertErr: unknown) =>
        logFailure("setUserClaims revert failed", revertErr, uid)
      )
      throw err
    }
    await adminAuth().revokeRefreshTokens(uid)
    return { uid, role: change.role, clearanceLevel: change.clearanceLevel }
  })
}

/** Restores the users doc's prior role/clearance (as a new version) if `version` is still the latest. */
async function revertIfStillOurs(uid: string, version: number, before: { role: unknown; clearanceLevel: unknown }): Promise<void> {
  const userRef = usersRef().doc(uid)
  await adminDb().runTransaction(async (tx) => {
    const doc = (await tx.get(userRef)).data()
    if (!doc || claimsVersionOf(doc) !== version) return
    tx.update(userRef, {
      role: before.role,
      clearanceLevel: before.clearanceLevel,
      claimsVersion: version + 1,
      updatedAt: FieldValue.serverTimestamp(),
    })
  })
}

/**
 * deactivateUser({ firmId, uid }). Partner only, same firm, never self.
 * In a transaction on `users/{uid}` (missing → 404 not_found): the target's
 * current clearance may not exceed the caller's, the firm's last active
 * partner cannot be deactivated (409 last_partner), and the doc is set
 * `active: false` (which alone locks the user out: callers need an active doc).
 * Then the Auth user is disabled and its refresh tokens revoked. Documents the
 * user created are left untouched.
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
    await requireUserInFirm(uid, caller.firmId)

    await adminDb().runTransaction(async (tx) => {
      const current = await readTargetDoc(tx, caller, uid)
      if (current.role === "partner" && current.active === true) {
        await requireAnotherActivePartner(tx, caller.firmId, uid)
      }
      await audit.stage(tx, "allow", "ok")
      tx.update(usersRef().doc(uid), { active: false, deactivatedAt: FieldValue.serverTimestamp() })
    })
    audit.committed()

    await adminAuth().updateUser(uid, { disabled: true })
    await adminAuth().revokeRefreshTokens(uid)
    return { uid, active: false }
  })
}

export const onboardFirm = onCall({ region: REGION }, onboardFirmHandler)
export const createFirmUser = onCall({ region: REGION }, createFirmUserHandler)
export const setUserClaims = onCall({ region: REGION }, setUserClaimsHandler)
export const deactivateUser = onCall({ region: REGION }, deactivateUserHandler)
