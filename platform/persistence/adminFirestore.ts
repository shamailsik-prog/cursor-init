import type { Firestore } from "firebase-admin/firestore"
import { PersistenceConfigurationError } from "@/platform/persistence/errors"

function isProductionRuntime(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production"
}

/** True when Admin Firestore can be initialised (emulator in non-prod, or ADC / service account). */
export function firestorePersistenceConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const emulator = env.FIRESTORE_EMULATOR_HOST?.trim()
  if (emulator) {
    if (isProductionRuntime(env)) return false
    return true
  }
  if (isProductionRuntime(env)) {
    // Cloud Run / GCE: firebase-admin initializeApp() + applicationDefault() resolve project via ADC.
    return true
  }
  if (env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) return true
  return false
}

let dbPromise: Promise<Firestore> | null = null

/**
 * Lazily initialises firebase-admin Firestore for production persistence.
 * Uses the Firestore emulator when FIRESTORE_EMULATOR_HOST is set (non-production only).
 */
export async function getProductionFirestore(): Promise<Firestore> {
  if (!firestorePersistenceConfigured()) {
    throw new PersistenceConfigurationError(
      "SIKANDER_PERSISTENCE_MODE=firestore but no Firestore database is configured. " +
        "Set FIRESTORE_EMULATOR_HOST for the emulator (non-production only), or configure " +
        "Application Default Credentials / GOOGLE_APPLICATION_CREDENTIALS for Admin SDK access."
    )
  }
  const emulator = process.env.FIRESTORE_EMULATOR_HOST?.trim()
  if (emulator && isProductionRuntime(process.env)) {
    throw new PersistenceConfigurationError(
      "FIRESTORE_EMULATOR_HOST is refused when NODE_ENV=production."
    )
  }
  if (!dbPromise) {
    dbPromise = (async () => {
      const { getApps, initializeApp, applicationDefault } = await import("firebase-admin/app")
      const { getFirestore } = await import("firebase-admin/firestore")
      const projectId =
        process.env.FIREBASE_PROJECT_ID?.trim() ||
        process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
        process.env.GCLOUD_PROJECT?.trim()
      const app =
        getApps()[0] ??
        initializeApp({
          ...(emulator ? {} : { credential: applicationDefault() }),
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
