import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { onCall, type CallableRequest } from "firebase-functions/v2/https"
import { FieldValue, Timestamp, type DocumentData } from "firebase-admin/firestore"
import { adminAuth, adminDb } from "../admin"
import { REGION } from "../health"
import { HttpError } from "../http/errors"
import { callerFromCallable, hasSecondFactor, type Role } from "./auth"
import {
  CallAudit,
  audited,
  dataOf,
  isSafeDocId,
  parseRole,
  parseUid,
  readTargetDoc,
  requirePartner,
} from "./identity"

/**
 * MFA policy and recovery (Module 40 / P5, erratum E-19). Every call writes
 * exactly one audit_log decision row (see CallAudit in identity.ts).
 *
 * Recovery codes are stored as HMAC-SHA-256(code, per-user random salt) in
 * `users/{uid}.recoveryCodeHashes` (+ `recoveryCodeSalt`), never in plaintext
 * or reversibly encrypted: they only ever need to be verified. (The spec's
 * field is `recoveryCodesEncrypted`; hashing is the stricter choice.)
 */

const RECOVERY_CODE_COUNT = 10
/** 10 random bytes = 80 bits = 16 Crockford base32 characters. */
const RECOVERY_CODE_BYTES = 10
const SALT_BYTES = 32
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const NORMALISED_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{16}$/
const APPROVAL_TTL_MS = 60 * 60 * 1000

type CodeHash = { hash: string; used: boolean }

const usersRef = () => adminDb().collection("users")
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
export async function enforceMfaForRoleHandler(
  request: CallableRequest<unknown>
): Promise<{ firmId: string; role: Role; enforced: boolean }> {
  const data = dataOf(request)
  const audit = new CallAudit("identity.enforceMfaForRole", request, "firms")
  return audited(audit, async () => {
    const caller = await callerFromCallable(request.auth, data.firmId as string)
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
  })
}

/**
 * generateRecoveryCodes({ firmId }) → { codes }: 10 new codes for the caller,
 * returned only here. Replaces (invalidates) any earlier set. MFA-exempt so a
 * user of an enforced role can get codes while enrolling; but once the user
 * has an enrolled factor, the session must carry a second factor
 * (403 mfa_required), so a stolen password cannot rotate the codes.
 */
export async function generateRecoveryCodesHandler(request: CallableRequest<unknown>): Promise<{ codes: string[] }> {
  const data = dataOf(request)
  const audit = new CallAudit("identity.generateRecoveryCodes", request, "users")
  return audited(audit, async () => {
    const caller = await callerFromCallable(request.auth, data.firmId as string, { mfaExempt: true })
    audit.firmId = caller.firmId
    audit.target = `users/${caller.uid}`
    const enrolled = (await adminAuth().getUser(caller.uid)).multiFactor?.enrolledFactors ?? []
    if (enrolled.length > 0 && !hasSecondFactor(request.auth!.token)) throw new HttpError(403, "mfa_required")

    const salt = randomBytes(SALT_BYTES)
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode)
    const hashes: CodeHash[] = codes.map((c) => ({ hash: hashCode(salt, normaliseRecoveryCode(c)), used: false }))
    await adminDb().runTransaction(async (tx) => {
      await audit.stage(tx, "allow", "ok")
      tx.update(usersRef().doc(caller.uid), {
        recoveryCodeHashes: hashes,
        recoveryCodeSalt: salt.toString("base64"),
        recoveryCodesGeneratedAt: FieldValue.serverTimestamp(),
      })
    })
    audit.committed()
    return { codes }
  })
}

/**
 * approveMfaDisable({ firmId, uid }) → { approvalId, expiresAt }. A partner
 * other than the subject (self → 403 second_partner_required), same firm,
 * cleared at least as high as the subject, records a one-hour, single-use
 * `mfa_disable_approvals/{id}`. Not MFA-exempt.
 */
export async function approveMfaDisableHandler(
  request: CallableRequest<unknown>
): Promise<{ approvalId: string; expiresAt: string }> {
  const data = dataOf(request)
  const audit = new CallAudit("identity.approveMfaDisable", request, "users")
  return audited(audit, async () => {
    const caller = await callerFromCallable(request.auth, data.firmId as string)
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
  })
}

/**
 * disableMfa({ firmId, uid, recoveryCode, approvalId }) → { uid, mfaEnabled: false }.
 * Callable by the subject (MFA-exempt: a user who lost the device signs in with
 * the first factor only) or by a partner (403 partner_only otherwise).
 *
 * One transaction checks the approval (exists, same firm and subject, unused,
 * unexpired, approver ≠ subject and ≠ caller, approver still an active partner
 * of the firm; else 403 second_partner_required), then the recovery code
 * (no match → 403 invalid_code, already used → 409 code_used), and marks both
 * used. Failed checks consume nothing. After commit the Auth second factors
 * are removed, `users/{uid}.mfaEnabled` is set false and refresh tokens are
 * revoked; if that fails, an extra `mfa_disable_incomplete` deny row is written
 * (the failure itself is logged by `audited`).
 */
export async function disableMfaHandler(
  request: CallableRequest<unknown>
): Promise<{ uid: string; mfaEnabled: false }> {
  const data = dataOf(request)
  const audit = new CallAudit("identity.disableMfa", request, "users")
  return audited(audit, async () => {
    const caller = await callerFromCallable(request.auth, data.firmId as string, { mfaExempt: true })
    audit.firmId = caller.firmId
    const uid = parseUid(data.uid)
    audit.target = `users/${uid}`
    if (uid !== caller.uid && caller.role !== "partner") throw new HttpError(403, "partner_only")
    const approvalId = data.approvalId
    if (!isSafeDocId(approvalId)) throw new HttpError(403, "second_partner_required")
    const recoveryCode = typeof data.recoveryCode === "string" ? data.recoveryCode : ""

    const approvalRef = approvalsRef().doc(approvalId)
    await adminDb().runTransaction(async (tx) => {
      const subject = await readTargetDoc(tx, caller, uid)
      const approval = (await tx.get(approvalRef)).data()
      const approverUid: unknown = approval?.approverUid
      const valid =
        approval !== undefined &&
        approval.firmId === caller.firmId &&
        approval.subjectUid === uid &&
        approval.used === false &&
        approval.expiresAt instanceof Timestamp &&
        approval.expiresAt.toMillis() > Date.now() &&
        isSafeDocId(approverUid) &&
        approverUid !== uid &&
        approverUid !== caller.uid
      if (!valid) throw new HttpError(403, "second_partner_required")
      const approver = (await tx.get(usersRef().doc(approverUid as string))).data()
      if (approver?.firmId !== caller.firmId || approver.role !== "partner" || approver.active !== true) {
        throw new HttpError(403, "second_partner_required")
      }

      const index = matchCode(subject, recoveryCode)
      if (index === -1) throw new HttpError(403, "invalid_code")
      const hashes = subject.recoveryCodeHashes as CodeHash[]
      if (hashes[index].used !== false) throw new HttpError(409, "code_used")

      await audit.stage(tx, "allow", "ok")
      tx.update(usersRef().doc(uid), {
        recoveryCodeHashes: hashes.map((h, i) => (i === index ? { ...h, used: true } : h)),
      })
      tx.update(approvalRef, { used: true, usedBy: caller.uid, usedAt: FieldValue.serverTimestamp() })
    })
    audit.committed()

    try {
      await adminAuth().updateUser(uid, { multiFactor: { enrolledFactors: null } })
      await usersRef().doc(uid).update({ mfaEnabled: false, mfaDisabledAt: FieldValue.serverTimestamp() })
      await adminAuth().revokeRefreshTokens(uid)
    } catch (err) {
      await audit.incident("mfa_disable_incomplete")
      throw err
    }
    return { uid, mfaEnabled: false }
  })
}

export const enforceMfaForRole = onCall({ region: REGION }, enforceMfaForRoleHandler)
export const generateRecoveryCodes = onCall({ region: REGION }, generateRecoveryCodesHandler)
export const approveMfaDisable = onCall({ region: REGION }, approveMfaDisableHandler)
export const disableMfa = onCall({ region: REGION }, disableMfaHandler)
