import { getApps, initializeApp } from "firebase-admin/app"
import { getFirestore, type Firestore } from "firebase-admin/firestore"

/** Admin Firestore for repository tests (emulator or cloud credentials). */
export function testAdminFirestore(projectIdOverride?: string): Firestore {
  const projectId =
    projectIdOverride?.trim() ||
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    process.env.GCLOUD_PROJECT?.trim() ||
    "demo-sikander"
  if (!getApps().length) {
    initializeApp({ projectId })
  }
  return getFirestore()
}
