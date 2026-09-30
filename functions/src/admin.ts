import { getApps, initializeApp, type App } from "firebase-admin/app"
import { getAuth, type Auth } from "firebase-admin/auth"
import { getFirestore, type Firestore } from "firebase-admin/firestore"

/** Lazily initialises the default Admin app on first use (no work at import time). */
export function adminApp(): App {
  return getApps()[0] ?? initializeApp()
}

export function adminDb(): Firestore {
  return getFirestore(adminApp())
}

export function adminAuth(): Auth {
  return getAuth(adminApp())
}
