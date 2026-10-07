import { randomUUID } from "node:crypto"
import { adminApp, adminAuth, adminDb } from "../src/admin"

/** True when both Auth and Firestore emulators are wired (via `npm run test:emu`). */
export const EMULATORS =
  Boolean(process.env.FIRESTORE_EMULATOR_HOST) && Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST)

// Locally the emulator suites skip without emulators (`describe.skipIf(!EMULATORS)`). In CI a
// skip would turn `test:emu` into a vacuous green, so a missing emulator env fails the run instead.
const ON_CI = Boolean(process.env.CI) && !/^(false|0)$/i.test(process.env.CI ?? "")
if (ON_CI && !EMULATORS) {
  throw new Error(
    "functions emulator suites require FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST in CI " +
      "(run them through `npm --prefix functions run test:emu` or `npm run gate:g2`)"
  )
}

export function uniq(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

/**
 * Creates an emulator user with the given custom claims and returns a real
 * ID token minted by the Auth emulator (REST signInWithPassword).
 * When the claims carry a string firmId, a matching active `users/{uid}` doc
 * (authoritative for role/clearance) is written too, unless `userDoc: false`.
 */
export async function mintIdToken(
  claims: Record<string, unknown> | null,
  opts: { userDoc?: boolean; emailVerified?: boolean; email?: string } = {}
): Promise<{ uid: string; token: string; email: string }> {
  const email = opts.email ?? `${uniq("u")}@example.test`
  const password = "emulator-pass-123"
  const user = await adminAuth().createUser({ email, password, emailVerified: opts.emailVerified ?? false })
  if (claims) await adminAuth().setCustomUserClaims(user.uid, claims)
  if (claims && typeof claims.firmId === "string" && opts.userDoc !== false) {
    const { firmId, role, clearanceLevel } = claims
    await adminDb().collection("users").doc(user.uid).set({ firmId, role, clearanceLevel, active: true })
  }
  const res = await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  )
  if (!res.ok) throw new Error(`emulator sign-in failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { idToken: string }
  return { uid: user.uid, token: body.idToken, email }
}

/** What the onCall runtime hands a handler: a verified (not revocation-checked) token. */
export async function callableAuth(token: string) {
  const decoded = await adminAuth().verifyIdToken(token)
  return { uid: decoded.uid, token: decoded, rawToken: token } as never
}

const MFA_PHONE = "+15555550100"

async function emulatorPost(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/${path}?key=fake-api-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`emulator ${path} failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as Record<string, unknown>
}

/**
 * Like `mintIdToken`, then enrols a phone second factor (Admin SDK) and signs
 * in through the emulator's real MFA flow (password → mfaSignIn start/finalize
 * with the emulator's SMS code). Returns both tokens: `firstFactorToken` was
 * minted before enrolment (no `firebase.sign_in_second_factor`), `token`
 * carries `sign_in_second_factor: "phone"`.
 */
export async function mintMfaIdToken(
  claims: Record<string, unknown> | null,
  opts: { userDoc?: boolean } = {}
): Promise<{ uid: string; token: string; firstFactorToken: string; email: string }> {
  const first = await mintIdToken(claims, { ...opts, emailVerified: true })
  await adminAuth().updateUser(first.uid, {
    multiFactor: { enrolledFactors: [{ uid: randomUUID(), phoneNumber: MFA_PHONE, factorId: "phone" }] },
  })
  const signIn = await emulatorPost("v1/accounts:signInWithPassword", {
    email: first.email,
    password: "emulator-pass-123",
    returnSecureToken: true,
  })
  const pending = signIn.mfaPendingCredential as string
  const enrollmentId = (signIn.mfaInfo as { mfaEnrollmentId: string }[])[0].mfaEnrollmentId
  const start = await emulatorPost("v2/accounts/mfaSignIn:start", {
    mfaPendingCredential: pending,
    mfaEnrollmentId: enrollmentId,
    phoneSignInInfo: { recaptchaToken: "emulator" },
  })
  const sessionInfo = (start.phoneResponseInfo as { sessionInfo: string }).sessionInfo
  const codesRes = await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${adminApp().options.projectId ?? process.env.GCLOUD_PROJECT}/verificationCodes`
  )
  const { verificationCodes } = (await codesRes.json()) as { verificationCodes: { sessionInfo: string; code: string }[] }
  const code = verificationCodes.find((c) => c.sessionInfo === sessionInfo)?.code
  if (!code) throw new Error("emulator MFA code not found")
  const done = await emulatorPost("v2/accounts/mfaSignIn:finalize", {
    mfaPendingCredential: pending,
    phoneVerificationInfo: { sessionInfo, code },
  })
  return { uid: first.uid, token: done.idToken as string, firstFactorToken: first.token, email: first.email }
}

/** A minimal express-like response that records what a handler sent (status, headers lower-cased, JSON body). */
export function mockRes() {
  const out = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown }
  const res = {
    status(n: number) {
      out.status = n
      return res
    },
    set(name: string, value: string) {
      out.headers[name.toLowerCase()] = value
      return res
    },
    json(body: unknown) {
      out.body = body
      return res
    },
  }
  return { res, out }
}
