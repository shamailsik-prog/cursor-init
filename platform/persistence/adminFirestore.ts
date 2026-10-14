import type { Firestore } from "firebase-admin/firestore"
import { PersistenceConfigurationError } from "@/platform/persistence/errors"

/** True when Admin Firestore can be initialised (emulator or explicit service-account credentials). */
export function firestorePersistenceConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.FIRESTORE_EMULATOR_HOST?.trim()) return true
  const creds = env.GOOGLE_APPLICATION_CREDENTIALS?.trim()
  if (!creds) return false
  return true
}

let dbPromise: Promise<Firestore> | null = null

/**
 * Lazily initialises firebase-admin Firestore for production persistence.
 * Uses the Firestore emulator when FIRESTORE_EMULATOR_HOST is set.
 */
export async function getProductionFirestore(): Promise<Firestore> {
  if (!firestorePersistenceConfigured()) {
    throw new PersistenceConfigurationError(
      "SIKANDER_PERSISTENCE_MODE=firestore but no Firestore database is configured. " +
        "Set FIRESTORE_EMULATOR_HOST for the emulator, or GOOGLE_APPLICATION_CREDENTIALS for Admin SDK access. " +
        "A project id alone is not sufficient."
    )
  }
  if (!dbPromise) {
    dbPromise = (async () => {
      const { getApps, initializeApp, applicationDefault } = await import("firebase-admin/app")
      const { getFirestore } = await import("firebase-admin/firestore")
      const projectId =
        process.env.FIREBASE_PROJECT_ID?.trim() || process.env.GOOGLE_CLOUD_PROJECT?.trim()
      const app =
        getApps()[0] ??
        initializeApp({
          ...(process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()
            ? { credential: applicationDefault() }
            : {}),
          ...(projectId ? { projectId } : {}),
        })
      return getFirestore(app)
    })().catch((err) => {
      dbPromise = null
      throw err
    })
  }
  return dbPromise
}

/** Test hook: forget the cached Admin Firestore instance. */
export function resetProductionFirestoreForTests(): void {
  dbPromise = null
}
