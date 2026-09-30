import { randomUUID } from "node:crypto"
import { adminAuth, adminDb } from "../src/admin"

/** True when both Auth and Firestore emulators are wired (via `npm run test:emu`). */
export const EMULATORS =
  Boolean(process.env.FIRESTORE_EMULATOR_HOST) && Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST)

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
