import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { onCall } from "firebase-functions/v2/https"
import type { UpdateMultiFactorInfoRequest } from "firebase-admin/auth"
import { FieldValue, Timestamp, type DocumentData, type DocumentReference } from "firebase-admin/firestore"
import { adminAuth, adminDb } from "../admin"
import { FUNCTION_TIMEOUT_SECONDS, REGION } from "../health"
import { HttpError } from "../http/errors"
import type { Role } from "./auth"
import { isKnownClassification, rankOf } from "./classification"
import {
  callableHandler,
  errorCode,
  isSafeDocId,
  parseRole,
  parseUid,
  readTargetDoc,
  requirePartner,
  usersRef,
  type FirmOperation,
} from "./common"

/**
 * MFA policy and recovery (Module 40 / P5, erratum E-19). Every call writes
 * exactly one audit_log decision row (see CallAudit in common.ts).
 *
 * Recovery codes are stored as HMAC-SHA-256(code, per-user random salt) in
 * `mfa_recovery/{uid}` = { recoveryCodeHashes, recoveryCodeSalt, generatedAt },
 * never in plaintext or reversibly encrypted: they only ever need to be
 * verified. That collection has no rules match, so clients cannot read it
 * (the users doc is readable by same-firm staff). (The spec's field is
 * `users.recoveryCodesEncrypted`; hashing is the stricter choice.)
 */

const RECOVERY_CODE_COUNT = 10
/** 10 random bytes = 80 bits = 16 Crockford base32 characters. */
const RECOVERY_CODE_BYTES = 10
const SALT_BYTES = 32
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const NORMALISED_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{16}$/
const APPROVAL_TTL_MS = 60 * 60 * 1000

type CodeHash = { hash: string; used: boolean }

const recoveryRef = (uid: string) => adminDb().collection("mfa_recovery").doc(uid)
const approvalsRef = () => adminDb().collection("mfa_disable_approvals")

function toCrockford(bytes: Buffer): string {
  let out = ""
  let bits = 0
  let acc = 0
  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += CROCKFORD[(acc >> bits) & 31]
    }
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31]
  return out
}

/** A new code for humans: 16 Crockford base32 characters in four dash-separated groups. */
function newRecoveryCode(): string {
  return toCrockford(randomBytes(RECOVERY_CODE_BYTES)).match(/.{4}/g)!.join("-")
}

/** Canonical form of a typed code: upper case, no separators or spaces, O→0 and I/L→1. */
export function normaliseRecoveryCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
}

function hashCode(salt: Buffer, normalised: string): string {
  return createHmac("sha256", salt).update(normalised).digest("hex")
}

/**
 * Index of the stored hash matching `code` (compared with timingSafeEqual,
 * scanning every entry), or -1.
 */
function matchCode(doc: DocumentData, code: string): number {
  const normalised = normaliseRecoveryCode(code)
  const hashes: unknown = doc.recoveryCodeHashes
  if (!NORMALISED_CODE_RE.test(normalised) || typeof doc.recoveryCodeSalt !== "string" || !Array.isArray(hashes)) return -1
  const candidate = Buffer.from(hashCode(Buffer.from(doc.recoveryCodeSalt, "base64"), normalised), "hex")
  let found = -1
  hashes.forEach((entry: unknown, i) => {
    const stored = Buffer.from(typeof (entry as CodeHash)?.hash === "string" ? (entry as CodeHash).hash : "", "hex")
    if (stored.length === candidate.length && timingSafeEqual(stored, candidate) && found === -1) found = i
  })
  return found
}

/**
 * enforceMfaForRole({ firmId, role, enforced }) → { firmId, role, enforced }. Partner only.
 * Adds (arrayUnion) or removes (arrayRemove) `role` in `firms/{firmId}.mfaEnforcedRoles`.
 * Lifting enforcement for `partner` is allowed; like every call it is audited.
 */
export const enforceMfaForRoleOp: FirmOperation<{ firmId: string; role: Role; enforced: boolean }> = {
  auth: "firm",
  kind: "general",
  action: "identity.enforceMfaForRole",
  target: "firms",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    requirePartner(caller)
    const role = parseRole(data.role)
    if (typeof data.enforced !== "boolean") throw new HttpError(400, "invalid_enforced")
    const enforced = data.enforced

    const firmRef = adminDb().collection("firms").doc(caller.firmId)
    await adminDb().runTransaction(async (tx) => {
      if (!(await tx.get(firmRef)).exists) throw new HttpError(404, "not_found")
      await audit.stage(tx, "allow", "ok")
      tx.update(firmRef, {
        mfaEnforcedRoles: enforced ? FieldValue.arrayUnion(role) : FieldValue.arrayRemove(role),
        updatedAt: FieldValue.serverTimestamp(),
      })
    })
    audit.committed()
    return { firmId: caller.firmId, role, enforced }
  },
}
export const enforceMfaForRoleHandler = callableHandler(enforceMfaForRoleOp)

/**
 * generateRecoveryCodes({ firmId }) → { codes }: 10 new codes for the caller,
 * returned only here. Replaces (invalidates) any earlier set. Not MFA-exempt,
 * and it requires an enrolled factor (403 factor_required) and a session
 * signed in with a second factor (403 mfa_required), so a password alone can
 * neither plant nor rotate codes. The client flow is enrol, then generate:
 * the enrolment-finalize token already carries the second factor. The
 * enrolled factor uids are stored with the hashes, and disableMfa only honours
 * the codes while one of them is still enrolled.
 */
export const generateRecoveryCodesOp: FirmOperation<{ codes: string[] }> = {
  auth: "firm",
  kind: "general",
  action: "identity.generateRecoveryCodes",
  target: "users",
  run: async ({ caller, secondFactor }, _data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `users/${caller.uid}`
    const factorUids = await enrolledFactorUids(caller.uid)
    if (factorUids.length === 0) throw new HttpError(403, "factor_required")
    if (!secondFactor) throw new HttpError(403, "mfa_required")

    const salt = randomBytes(SALT_BYTES)
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode)
    const hashes: CodeHash[] = codes.map((c) => ({ hash: hashCode(salt, normaliseRecoveryCode(c)), used: false }))
    await adminDb().runTransaction(async (tx) => {
      await audit.stage(tx, "allow", "ok")
      tx.set(recoveryRef(caller.uid), {
        recoveryCodeHashes: hashes,
        recoveryCodeSalt: salt.toString("base64"),
        factorUids,
        generatedAt: FieldValue.serverTimestamp(),
      })
    })
    audit.committed()
    return { codes }
  },
}
export const generateRecoveryCodesHandler = callableHandler(generateRecoveryCodesOp)

/**
 * approveMfaDisable({ firmId, uid }) → { approvalId, expiresAt }. A partner
 * other than the subject (self → 403 second_partner_required), same firm,
 * cleared at least as high as the subject, records a one-hour, single-use
 * `mfa_disable_approvals/{id}`. Not MFA-exempt.
 */
export const approveMfaDisableOp: FirmOperation<{ approvalId: string; expiresAt: string }> = {
  auth: "firm",
  kind: "general",
  action: "identity.approveMfaDisable",
  target: "users",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    requirePartner(caller)
    const uid = parseUid(data.uid)
    audit.target = `users/${uid}`
    if (uid === caller.uid) throw new HttpError(403, "second_partner_required")

    const ref = approvalsRef().doc()
    const expiresAt = Timestamp.fromMillis(Date.now() + APPROVAL_TTL_MS)
    await adminDb().runTransaction(async (tx) => {
      await readTargetDoc(tx, caller, uid)
      await audit.stage(tx, "allow", "ok")
      tx.create(ref, {
        firmId: caller.firmId,
        subjectUid: uid,
        approverUid: caller.uid,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt,
        used: false,
      })
    })
    audit.committed()
    return { approvalId: ref.id, expiresAt: expiresAt.toDate().toISOString() }
  },
}
export const approveMfaDisableHandler = callableHandler(approveMfaDisableOp)

/** The uids of the Auth user's enrolled second factors; an unknown user has none. */
async function enrolledFactorUids(uid: string): Promise<string[]> {
  try {
    return ((await adminAuth().getUser(uid)).multiFactor?.enrolledFactors ?? []).map((f) => f.uid)
  } catch (err) {
    if (errorCode(err) === "auth/user-not-found") return []
    throw err
  }
}

const MAX_CODE_ATTEMPTS = 5

/**
 * Removes exactly `factorUids` from the user's enrolled factors, keeping any
 * other factor (e.g. one enrolled after the commit). Idempotent. Returns
 * whether factors remain.
 *
 * Known, accepted race: this is getUser then updateUser with the kept list,
 * and Auth has no compare-and-set, so a factor enrolled in the milliseconds
 * between the two calls would be dropped. The only effect is that the user
 * must enrol that factor again (MFA is being removed anyway, which is what
 * the subject and a second partner asked for); nothing is granted.
 */
async function removeFactors(uid: string, factorUids: readonly string[]): Promise<boolean> {
  const current = (await adminAuth().getUser(uid)).multiFactor?.enrolledFactors ?? []
  const keep = current.filter((f) => !factorUids.includes(f.uid))
  if (keep.length !== current.length) {
    await adminAuth().updateUser(uid, {
      multiFactor: {
        enrolledFactors:
          keep.length === 0
            ? null
            : keep.map((f) => {
                const phoneNumber = (f as { phoneNumber?: unknown }).phoneNumber
                return {
                  uid: f.uid,
                  factorId: f.factorId,
                  ...(typeof phoneNumber === "string" ? { phoneNumber } : {}),
                  ...(f.displayName ? { displayName: f.displayName } : {}),
                  ...(f.enrollmentTime ? { enrollmentTime: f.enrollmentTime } : {}),
                }
              }) as UpdateMultiFactorInfoRequest[],
      },
    })
  }
  return keep.length > 0
}

/**
 * disableMfa({ firmId, uid, recoveryCode, approvalId }) → { uid, mfaEnabled }.
 * Callable by the subject or by a partner (403 partner_only otherwise). Only
 * the subject is MFA-exempt (a user who lost the device signs in with the
 * first factor only); a partner acting for someone else is subject to the
 * firm's MFA policy like any other call.
 *
 * One transaction checks the approval: it exists, is in the same firm and for
 * the same subject, and is unexpired; the approver is neither the subject nor
 * the caller, and is still an active partner of the firm cleared at least as
 * high as the subject. Otherwise 403 second_partner_required.
 *
 * Attempt cap: before that transaction, every code attempt against an unused
 * approval reserves itself in its own transaction on the approval
 * (`codeAttempts`): at MAX_CODE_ATTEMPTS or more it is refused with 403
 * approval_voided, otherwise it increments the count. Reserving first keeps the
 * cap exact under concurrency. The reservation fails closed, so a store error
 * fails the call.
 *
 * An unused approval then needs a recovery code:
 * - no match, or none of the factors the codes were generated for is still
 *   enrolled → 403 invalid_code;
 * - already used → 409 code_used.
 * A rejected code consumes nothing but its reserved attempt.
 *
 * On success the approval is marked used and records the factor uids to
 * remove (those enrolled now). Every other code is invalidated: only the
 * consumed code's hash is kept, as used.
 *
 * After commit these steps run, each idempotent:
 * 1. remove exactly the recorded factors;
 * 2. mark the approval `factorsRemovedAt`;
 * 3. set `users/{uid}.mfaEnabled`;
 * 4. revoke refresh tokens;
 * 5. only then mark the approval `completed`.
 * If any step fails, an extra `mfa_disable_incomplete` deny row is written
 * (the failure itself is logged by `audited`). The same caller may then retry
 * with the same approval and no code while it is used by them, not completed
 * and unexpired (audited as allow `resume`), which re-runs the steps.
 */
export const disableMfaOp: FirmOperation<{ uid: string; mfaEnabled: boolean }> = {
  auth: "firm",
  kind: "general",
  action: "identity.disableMfa",
  target: "users",
  // Only the subject (a user who lost the device) is exempt from the MFA policy.
  mfaExempt: (uid, data) => data.uid === uid,
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    const uid = parseUid(data.uid)
    audit.target = `users/${uid}`
    if (uid !== caller.uid && caller.role !== "partner") throw new HttpError(403, "partner_only")
    const approvalId = data.approvalId
    if (!isSafeDocId(approvalId)) throw new HttpError(403, "second_partner_required")
    const recoveryCode = typeof data.recoveryCode === "string" ? data.recoveryCode : ""
    const enrolledNow = await enrolledFactorUids(uid)

    const approvalRef = approvalsRef().doc(approvalId)
    await reserveCodeAttempt(approvalRef, caller.firmId, uid)
    const factorUids = await adminDb().runTransaction(async (tx) => {
      const subject = await readTargetDoc(tx, caller, uid)
      const approval = (await tx.get(approvalRef)).data()
      const approverUid: unknown = approval?.approverUid
      const valid =
        approval !== undefined &&
        approval.firmId === caller.firmId &&
        approval.subjectUid === uid &&
        approval.expiresAt instanceof Timestamp &&
        approval.expiresAt.toMillis() > Date.now() &&
        isSafeDocId(approverUid) &&
        approverUid !== uid &&
        approverUid !== caller.uid
      if (!valid) throw new HttpError(403, "second_partner_required")
      const approver = (await tx.get(usersRef().doc(approverUid as string))).data()
      if (
        approver?.firmId !== caller.firmId ||
        approver.role !== "partner" ||
        approver.active !== true ||
        !isKnownClassification(approver.clearanceLevel) ||
        rankOf(approver.clearanceLevel) < rankOf(isKnownClassification(subject.clearanceLevel) ? subject.clearanceLevel : "privileged-restricted")
      ) {
        throw new HttpError(403, "second_partner_required")
      }

      if (approval.used !== false) {
        const resumable = approval.used === true && approval.usedBy === caller.uid && approval.completed !== true
        if (!resumable) throw new HttpError(403, "second_partner_required")
        await audit.stage(tx, "allow", "resume")
        return Array.isArray(approval.factorUids) ? (approval.factorUids as unknown[]).filter(isString) : []
      }
      const recovery = (await tx.get(recoveryRef(uid))).data() ?? {}
      const index = matchCode(recovery, recoveryCode)
      if (index === -1) throw new HttpError(403, "invalid_code")
      const hashes = recovery.recoveryCodeHashes as CodeHash[]
      if (hashes[index].used !== false) throw new HttpError(409, "code_used")
      const boundTo: unknown = recovery.factorUids
      if (!Array.isArray(boundTo) || !boundTo.some((f) => enrolledNow.includes(f as string))) {
        throw new HttpError(403, "invalid_code")
      }

      await audit.stage(tx, "allow", "ok")
      tx.update(recoveryRef(uid), {
        recoveryCodeHashes: [{ ...hashes[index], used: true }],
        invalidatedAt: FieldValue.serverTimestamp(),
      })
      tx.update(approvalRef, {
        used: true,
        usedBy: caller.uid,
        usedAt: FieldValue.serverTimestamp(),
        factorUids: enrolledNow,
      })
      return enrolledNow
    })
    audit.committed()

    let mfaEnabled: boolean
    try {
      mfaEnabled = await removeFactors(uid, factorUids)
      await approvalRef.update({ factorsRemovedAt: FieldValue.serverTimestamp() })
      await usersRef().doc(uid).update({ mfaEnabled, mfaDisabledAt: FieldValue.serverTimestamp() })
      await adminAuth().revokeRefreshTokens(uid)
      await approvalRef.update({ completed: true, completedAt: FieldValue.serverTimestamp() })
    } catch (err) {
      await audit.incident("mfa_disable_incomplete")
      throw err
    }
    return { uid, mfaEnabled }
  },
}
export const disableMfaHandler = callableHandler(disableMfaOp)

/**
 * Reserves one code attempt on an unused approval for this firm and subject,
 * in its own transaction: at MAX_CODE_ATTEMPTS or more → 403 approval_voided,
 * otherwise `codeAttempts` is incremented. Anything else (missing, used,
 * another subject) is left for the main transaction to refuse or resume.
 */
async function reserveCodeAttempt(
  approvalRef: DocumentReference,
  firmId: string,
  uid: string
): Promise<void> {
  await adminDb().runTransaction(async (tx) => {
    const approval = (await tx.get(approvalRef)).data()
    if (!approval || approval.firmId !== firmId || approval.subjectUid !== uid || approval.used !== false) return
    const attempts = typeof approval.codeAttempts === "number" ? approval.codeAttempts : 0
    if (attempts >= MAX_CODE_ATTEMPTS) throw new HttpError(403, "approval_voided")
    tx.update(approvalRef, { codeAttempts: attempts + 1 })
  })
}

function isString(v: unknown): v is string {
  return typeof v === "string"
}

/**
 * syncMfaStatus({ firmId }) → { uid, mfaEnabled }: sets the caller's
 * `users/{uid}.mfaEnabled` from the Auth user's enrolled factors (enrolment
 * happens client-side, so the client calls this afterwards). MFA-exempt: it
 * only mirrors Auth state, and an enforced user calls it right after enrolling.
 */
export const syncMfaStatusOp: FirmOperation<{ uid: string; mfaEnabled: boolean }> = {
  auth: "firm",
  kind: "general",
  action: "identity.syncMfaStatus",
  target: "users",
  mfaExempt: () => true,
  run: async ({ caller }, _data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `users/${caller.uid}`
    const mfaEnabled = (await enrolledFactorUids(caller.uid)).length > 0
    await adminDb().runTransaction(async (tx) => {
      await audit.stage(tx, "allow", "ok")
      tx.update(usersRef().doc(caller.uid), { mfaEnabled })
    })
    audit.committed()
    return { uid: caller.uid, mfaEnabled }
  },
}
export const syncMfaStatusHandler = callableHandler(syncMfaStatusOp)

export const enforceMfaForRole = onCall({ region: REGION, timeoutSeconds: FUNCTION_TIMEOUT_SECONDS }, enforceMfaForRoleHandler)
export const generateRecoveryCodes = onCall({ region: REGION, timeoutSeconds: FUNCTION_TIMEOUT_SECONDS }, generateRecoveryCodesHandler)
export const approveMfaDisable = onCall({ region: REGION, timeoutSeconds: FUNCTION_TIMEOUT_SECONDS }, approveMfaDisableHandler)
export const disableMfa = onCall({ region: REGION, timeoutSeconds: FUNCTION_TIMEOUT_SECONDS }, disableMfaHandler)
export const syncMfaStatus = onCall({ region: REGION, timeoutSeconds: FUNCTION_TIMEOUT_SECONDS }, syncMfaStatusHandler)
