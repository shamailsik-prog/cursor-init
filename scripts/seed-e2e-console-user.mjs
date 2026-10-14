/**
 * Creates a Firebase Auth emulator user + Firestore users/{uid} doc for browser e2e.
 * Prints shell exports for E2E_CONSOLE_EMAIL and E2E_CONSOLE_PASSWORD.
 */
import { randomUUID } from "node:crypto"
import { initializeApp, getApps } from "firebase-admin/app"
import { getAuth } from "firebase-admin/auth"
import { getFirestore } from "firebase-admin/firestore"

const projectId = process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID ?? "demo-sikander"
const app = getApps()[0] ?? initializeApp({ projectId })
const auth = getAuth(app)
const db = getFirestore(app)

const email = `e2e-${randomUUID().slice(0, 8)}@example.test`
const password = `emu-${randomUUID().slice(0, 12)}`
const firmId = "firmA"
const role = "partner"
const clearanceLevel = "privileged-restricted"

const user = await auth.createUser({ email, password })
await auth.setCustomUserClaims(user.uid, { firmId, role, clearanceLevel })
await db.collection("users").doc(user.uid).set({
  id: user.uid,
  firmId,
  role,
  clearanceLevel,
  active: true,
})
await db.collection("firms").doc(firmId).set({
  id: firmId,
  name: "E2E firm",
  mfaEnforcedRoles: [],
})

process.stdout.write(`export E2E_CONSOLE_EMAIL='${email}'\n`)
process.stdout.write(`export E2E_CONSOLE_PASSWORD='${password}'\n`)
