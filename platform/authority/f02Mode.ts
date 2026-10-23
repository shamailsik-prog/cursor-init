import { firestorePersistenceConfigured } from "@/platform/persistence/adminFirestore"
import { isFirestoreInjectedForTests, resolvePersistenceMode } from "@/platform/persistence/runtimeRepositories"
import { inAuthorityFrame } from "@/platform/authority/f02Registry"

/**
 * Production Firestore (a configured database, no test-injected handle, not already
 * inside the authority frame) must enter through the Functions router. Memory mode,
 * `setFirestorePersistenceForTests`, and firestore mode with no database keep the
 * existing handlers: the last of those fails closed as PERSISTENCE_NOT_CONFIGURED
 * without opening the Functions router.
 */
export function mustDispatchF02(): boolean {
  if (inAuthorityFrame()) return false
  if (isFirestoreInjectedForTests()) return false
  if (resolvePersistenceMode() !== "firestore") return false
  return firestorePersistenceConfigured()
}
