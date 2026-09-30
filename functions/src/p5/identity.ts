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

/** A loggable error code: the SDK's `code` string if any, never the message (which may carry an email). */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === "string" ? code : "unknown"
}

/** Logs a failure with a generic message, its code and (optionally) a uid; no raw error text. */
export function logFailure(message: string, err: unknown, uid?: string): void {
  logger.error(message, uid === undefined ? { code: errorCode(err) } : { uid, code: errorCode(err) })
}

/** Runs a callable body; any failure without an audit row yet is audited as a deny, then mapped to HttpsError. */
export async function audited<T>(audit: CallAudit, body: () => Promise<T>): Promise<T> {
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

export function requirePartner(caller: Caller): void {
  if (caller.role !== "partner") throw new HttpError(403, "partner_only")
}

function forbidPlatformAdmin(data: Data): void {
  if (Object.hasOwn(data, "platformAdmin")) throw new HttpError(403, "platform_admin_forbidden")
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

function parseEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim() : ""
  if (email.length > MAX_EMAIL || !EMAIL_RE.test(email)) throw new HttpError(400, "invalid_email")
  return email
}

export function parseRole(value: unknown): Role {
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
export async function readTargetDoc(tx: Transaction, caller: Caller, uid: string): Promise<DocumentData> {
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

/** The claims a transaction decided for a user; `version` is its claimsVersion. */
type ClaimsResult = { firmId: string; role: Role; clearanceLevel: Classification; version: number }

/**
 * `claims_sync/{uid}` records the latest committed ClaimsResult. It is written
 * only by the Admin SDK in the same transaction as the users doc (the rules'
 * default deny covers it), so unlike `users/{uid}.claimsVersion` a client
 * cannot tamper with it; versions and reverts are keyed on it.
 */
const claimsSyncRef = (uid: string) => adminDb().collection("claims_sync").doc(uid)

const MAX_SYNC_ATTEMPTS = 5

/** The committed version for a user: the claims_sync record, falling back to the users doc for older docs. */
function committedVersion(syncDoc: DocumentData | undefined, userDoc: DocumentData | undefined): number {
  const v: unknown = syncDoc?.version
  return typeof v === "number" && Number.isInteger(v) ? v : claimsVersionOf(userDoc)
}

/** Defence in depth: a ClaimsResult is only ever written to Auth if it is well formed and in the expected firm. */
function checkedResult(value: unknown, firmId: string): ClaimsResult {
  const r = (value ?? {}) as Record<string, unknown>
  if (
    r.firmId !== firmId ||
    !isRole(r.role) ||
    !isKnownClassification(r.clearanceLevel) ||
    typeof r.version !== "number" ||
    !Number.isInteger(r.version)
  ) {
    throw new HttpError(409, "claims_sync_failed")
  }
  return { firmId, role: r.role, clearanceLevel: r.clearanceLevel, version: r.version }
}

function claimsMatch(claims: Record<string, unknown>, r: ClaimsResult): boolean {
  return (
    claims.firmId === r.firmId &&
    claims.role === r.role &&
    claims.clearanceLevel === r.clearanceLevel &&
    claims.claimsVersion === r.version
  )
}

/**
 * Writes a transaction's own ClaimsResult to the Auth claims (keeping
 * unrelated claims), never values re-read from the client-reachable users doc.
 * It then confirms: if `claims_sync` shows a newer committed version, that
 * server-written result is adopted (validated, same firm) so concurrent writers
 * converge; otherwise the Auth claims must read back as the result. Gives up
 * after MAX_SYNC_ATTEMPTS with 409 claims_sync_failed.
 */
async function syncClaims(uid: string, result: ClaimsResult): Promise<void> {
  let target = checkedResult(result, result.firmId)
  for (let attempt = 0; attempt < MAX_SYNC_ATTEMPTS; attempt++) {
    const existing = (await adminAuth().getUser(uid)).customClaims ?? {}
    await adminAuth().setCustomUserClaims(uid, {
      ...existing,
      firmId: target.firmId,
      role: target.role,
      clearanceLevel: target.clearanceLevel,
      claimsVersion: target.version,
    })
    const latest = (await claimsSyncRef(uid).get()).data()
    if (typeof latest?.version === "number" && latest.version > target.version) {
      target = checkedResult(latest, target.firmId)
      continue
    }
    if (claimsMatch((await adminAuth().getUser(uid)).customClaims ?? {}, target)) return
  }
  throw new HttpError(409, "claims_sync_failed")
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
      const syncDoc = (await tx.get(claimsSyncRef(uid))).data()
      const nextRole: unknown = role ?? current.role
      const nextClearance: unknown = clearanceLevel ?? current.clearanceLevel
      if (!isRole(nextRole) || !isKnownClassification(nextClearance)) throw new HttpError(409, "target_state_invalid")
      if (current.role === "partner" && current.active === true && nextRole !== "partner") {
        await requireAnotherActivePartner(tx, caller.firmId, uid)
      }
      const result: ClaimsResult = {
        firmId: caller.firmId,
        role: nextRole,
        clearanceLevel: nextClearance,
        version: Math.max(committedVersion(syncDoc, current), claimsVersionOf(current)) + 1,
      }
      await audit.stage(tx, "allow", "ok")
      writeClaimsState(tx, uid, result)
      return { result, before: { role: current.role, clearanceLevel: current.clearanceLevel } }
    })
    audit.committed()

    try {
      await syncClaims(uid, change.result)
    } catch (err) {
      await recoverFailedSync(audit, uid, change.result, change.before)
      if (err instanceof HttpError && err.code === "claims_sync_failed") await audit.incident("claims_sync_failed")
      throw err
    }
    await adminAuth().revokeRefreshTokens(uid)
    return { uid, role: change.result.role, clearanceLevel: change.result.clearanceLevel }
  })
}

/** Writes a ClaimsResult to the users doc and its server-only claims_sync record in one transaction. */
function writeClaimsState(tx: Transaction, uid: string, r: ClaimsResult): void {
  tx.update(usersRef().doc(uid), {
    role: r.role,
    clearanceLevel: r.clearanceLevel,
    claimsVersion: r.version,
    updatedAt: FieldValue.serverTimestamp(),
  })
  tx.set(claimsSyncRef(uid), { ...r, at: FieldValue.serverTimestamp() })
}

/**
 * After a failed claims sync: revert the doc (if our version is still the
 * committed one) and re-sync the Auth claims from the reverted result, so doc
 * and claims agree again. Failures here are logged; the caller rethrows the
 * original error.
 */
async function recoverFailedSync(
  audit: CallAudit,
  uid: string,
  ours: ClaimsResult,
  before: { role: unknown; clearanceLevel: unknown }
): Promise<void> {
  let reverted: { result: ClaimsResult; blocked: boolean } | undefined
  try {
    reverted = await revertIfStillOurs(uid, ours, before)
  } catch (err) {
    logFailure("setUserClaims revert failed", err, uid)
    return
  }
  if (!reverted) return
  if (reverted.blocked) await audit.incident("revert_blocked_last_partner")
  try {
    await syncClaims(uid, reverted.result)
  } catch (err) {
    logFailure("setUserClaims re-sync after revert failed", err, uid)
  }
}

/**
 * Restores the prior role/clearance as a new version, only while `ours` is
 * still the committed version (per claims_sync, which clients cannot write).
 * If restoring the role would demote the firm's last active partner, the role
 * is kept and only the clearance is restored (`blocked: true`).
 */
async function revertIfStillOurs(
  uid: string,
  ours: ClaimsResult,
  before: { role: unknown; clearanceLevel: unknown }
): Promise<{ result: ClaimsResult; blocked: boolean } | undefined> {
  return adminDb().runTransaction(async (tx) => {
    const doc = (await tx.get(usersRef().doc(uid))).data()
    const syncDoc = (await tx.get(claimsSyncRef(uid))).data()
    if (!doc || committedVersion(syncDoc, doc) !== ours.version) return undefined
    let role: unknown = before.role
    let blocked = false
    if (doc.role === "partner" && doc.active === true && role !== "partner") {
      try {
        await requireAnotherActivePartner(tx, ours.firmId, uid)
      } catch (err) {
        if (!(err instanceof HttpError && err.code === "last_partner")) throw err
        role = doc.role
        blocked = true
      }
    }
    const result = checkedResult(
      { firmId: ours.firmId, role, clearanceLevel: before.clearanceLevel, version: ours.version + 1 },
      ours.firmId
    )
    writeClaimsState(tx, uid, result)
    return { result, blocked }
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
