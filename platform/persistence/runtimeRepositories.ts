import type { SpineStore } from "@/platform/spine/store"
import {
  createMemoryRepositories,
  type SpineRepositories,
} from "@/platform/persistence/spineRepositories"

let firestoreDbForTests: unknown = null

export function setFirestorePersistenceForTests(db: unknown | null): void {
  firestoreDbForTests = db
}

/** Persistence is misconfigured; requests fail closed instead of silently using memory. */
export class PersistenceConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PersistenceConfigurationError"
  }
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
    if (
      process.env.NODE_ENV === "production" &&
      process.env.SIKANDER_ALLOW_MEMORY_IN_PRODUCTION !== "true"
    ) {
      throw new PersistenceConfigurationError(
        "SIKANDER_PERSISTENCE_MODE=memory is non-durable (data is lost on restart) and is refused " +
          "when NODE_ENV=production. Set SIKANDER_ALLOW_MEMORY_IN_PRODUCTION=true to opt in " +
          "deliberately."
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
    if (!firestoreDbForTests) {
      throw new PersistenceConfigurationError(
        "SIKANDER_PERSISTENCE_MODE=firestore but no Firestore database is configured. " +
          "Production Firestore persistence (firebase-admin with firm service-account " +
          "credentials) is not wired yet — TODO(firm); only the test-injected emulator database " +
          "is supported. Refusing to fall back to in-memory storage."
      )
    }
    const mod = await import("@/platform/persistence/firestoreSpineRepositories")
    return mod.createFirestoreRepositories(firestoreDbForTests as never)
  }
  throw new PersistenceConfigurationError(
    `Unknown SIKANDER_PERSISTENCE_MODE "${raw}"; expected "memory" or "firestore".`
  )
}
