import { randomUUID } from "node:crypto"
import { initializeApp, getApps } from "firebase-admin/app"
import { getAuth } from "firebase-admin/auth"
import { getFirestore } from "firebase-admin/firestore"

function adminApp() {
  return getApps()[0] ?? initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? "demo-sikander" })
}

export function adminDb() {
  return getFirestore(adminApp())
}

export function adminAuth() {
  return getAuth(adminApp())
}

export function uniq(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

export async function mintIdToken(
  claims: Record<string, unknown> | null,
  opts: { userDoc?: boolean; email?: string } = {}
): Promise<{ uid: string; token: string; email: string }> {
  const email = opts.email ?? `${uniq("u")}@example.test`
  const password = "emulator-pass-123"
  const user = await adminAuth().createUser({ email, password })
  if (claims) await adminAuth().setCustomUserClaims(user.uid, claims)
  if (claims && typeof claims.firmId === "string" && opts.userDoc !== false) {
    const { firmId, role, clearanceLevel } = claims
    await adminDb()
      .collection("users")
      .doc(user.uid)
      .set({ firmId, role, clearanceLevel, active: true })
  }
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST
  if (!host) throw new Error("FIREBASE_AUTH_EMULATOR_HOST is required to mint emulator tokens")
  const res = await fetch(
    `http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
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

export const EMULATORS =
  Boolean(process.env.FIRESTORE_EMULATOR_HOST) && Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST)
