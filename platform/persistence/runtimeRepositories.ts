import type { SpineStore } from "@/platform/spine/store"
import {
  createMemoryRepositories,
  type SpineRepositories,
} from "@/platform/persistence/spineRepositories"

let firestoreDbForTests: unknown = null

export function setFirestorePersistenceForTests(db: unknown | null): void {
  firestoreDbForTests = db
}

export async function getRuntimeRepositories(
  store: SpineStore
): Promise<SpineRepositories> {
  const mode = (process.env.SIKANDER_PERSISTENCE_MODE ?? "memory").toLowerCase()
  if (mode !== "firestore") {
    return createMemoryRepositories(store)
  }
  if (!firestoreDbForTests) {
    return createMemoryRepositories(store)
  }
  const mod = await import("@/platform/persistence/firestoreSpineRepositories")
  return mod.createFirestoreRepositories(firestoreDbForTests as never)
}
