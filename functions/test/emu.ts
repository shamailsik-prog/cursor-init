import { randomUUID } from "node:crypto"
import { adminAuth } from "../src/admin"

/** True when both Auth and Firestore emulators are wired (via `npm run test:emu`). */
export const EMULATORS =
  Boolean(process.env.FIRESTORE_EMULATOR_HOST) && Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST)

export function uniq(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

/**
 * Creates an emulator user with the given custom claims and returns a real
 * ID token minted by the Auth emulator (REST signInWithPassword).
 */
export async function mintIdToken(claims: Record<string, unknown> | null): Promise<{ uid: string; token: string }> {
  const email = `${uniq("u")}@example.test`
  const password = "emulator-pass-123"
  const user = await adminAuth().createUser({ email, password })
  if (claims) await adminAuth().setCustomUserClaims(user.uid, claims)
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
  return { uid: user.uid, token: body.idToken }
}

/** What the onCall runtime hands a handler: a verified (not revocation-checked) token. */
export async function callableAuth(token: string) {
  const decoded = await adminAuth().verifyIdToken(token)
  return { uid: decoded.uid, token: decoded, rawToken: token } as never
}
