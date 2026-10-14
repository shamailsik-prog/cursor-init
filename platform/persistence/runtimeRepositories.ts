import type { SpineStore } from "@/platform/spine/store"
import {
  createMemoryRepositories,
  type SpineRepositories,
} from "@/platform/persistence/spineRepositories"
import { getProductionFirestore } from "@/platform/persistence/adminFirestore"
import { PersistenceConfigurationError } from "@/platform/persistence/errors"

export { PersistenceConfigurationError } from "@/platform/persistence/errors"

let firestoreDbForTests: unknown = null

export function setFirestorePersistenceForTests(db: unknown | null): void {
  firestoreDbForTests = db
}

function isTestRunner(): boolean {
  return process.env.VITEST === "true" && process.env.NODE_ENV !== "production"
}

export async function getRuntimeRepositories(
  store: SpineStore
): Promise<SpineRepositories> {
  const raw = process.env.SIKANDER_PERSISTENCE_MODE
  const mode = raw?.trim().toLowerCase() ?? ""
  if (mode === "memory") {
    if (process.env.NODE_ENV === "production") {
      throw new PersistenceConfigurationError(
        "SIKANDER_PERSISTENCE_MODE=memory is non-durable (data is lost on restart) and is refused " +
          "when NODE_ENV=production."
      )
    }
    return createMemoryRepositories(store)
  }
  if (mode === "") {
    if (isTestRunner()) return createMemoryRepositories(store)
    throw new PersistenceConfigurationError(
      "SIKANDER_PERSISTENCE_MODE is not set. Set SIKANDER_PERSISTENCE_MODE=memory explicitly for " +
        "non-durable local development; there is no silent in-memory default."
    )
  }
  if (mode === "firestore") {
    const db = firestoreDbForTests ?? (await getProductionFirestore())
    const mod = await import("@/platform/persistence/firestoreSpineRepositories")
    return mod.createFirestoreRepositories(db as never)
  }
  throw new PersistenceConfigurationError(
    `Unknown SIKANDER_PERSISTENCE_MODE "${raw}"; expected "memory" or "firestore".`
  )
}
