import type { SpineStore } from "@/platform/spine/store"
import {
  createMemoryRepositories,
  type SpineRepositories,
} from "@/platform/persistence/spineRepositories"
import { getProductionFirestore } from "@/platform/persistence/adminFirestore"
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from "@/platform/persistence/firestoreDbModular"
import { PersistenceConfigurationError } from "@/platform/persistence/errors"

export { PersistenceConfigurationError } from "@/platform/persistence/errors"

let firestoreDbForTests: unknown = null

export function setFirestorePersistenceForTests(db: unknown | null): void {
  firestoreDbForTests = db
}

/** True when a test has replaced the production Firestore handle. F02 then keeps the repository path. */
export function isFirestoreInjectedForTests(): boolean {
  return firestoreDbForTests !== null
}

function isTestRunner(): boolean {
  return process.env.VITEST === "true" && process.env.NODE_ENV !== "production"
}

/**
 * The persistence mode the Next runtime runs in, from SIKANDER_PERSISTENCE_MODE (F01). `memory` is refused when
 * NODE_ENV=production; an unset mode means memory only under the test runner; anything else is refused. Shared by the
 * repositories and the idempotency store (audit F10), so the two can never disagree about durability.
 */
export function resolvePersistenceMode(): "memory" | "firestore" {
  const raw = process.env.SIKANDER_PERSISTENCE_MODE
  const mode = raw?.trim().toLowerCase() ?? ""
  if (mode === "memory") {
    if (process.env.NODE_ENV === "production") {
      throw new PersistenceConfigurationError(
        "SIKANDER_PERSISTENCE_MODE=memory is non-durable (data is lost on restart) and is refused " +
          "when NODE_ENV=production."
      )
    }
    return "memory"
  }
  if (mode === "") {
    if (isTestRunner()) return "memory"
    throw new PersistenceConfigurationError(
      "SIKANDER_PERSISTENCE_MODE is not set. Set SIKANDER_PERSISTENCE_MODE=memory explicitly for " +
        "non-durable local development; there is no silent in-memory default."
    )
  }
  if (mode === "firestore") return "firestore"
  throw new PersistenceConfigurationError(
    `Unknown SIKANDER_PERSISTENCE_MODE "${raw}"; expected "memory" or "firestore".`
  )
}

/**
 * The Firestore database of the `firestore` mode: the test override, else the production Admin Firestore (which throws
 * PersistenceConfigurationError when none is configured). The repositories and the idempotency store use this one
 * instance, because the idempotency write fence reads the claim inside each effect write's transaction (audit F10).
 */
export async function getRuntimeFirestore(): Promise<unknown> {
  return firestoreDbForTests ?? (await getProductionFirestore())
}

/**
 * Firestore handle for the WhatsApp outbound-key store. The store itself stays on the fenced helpers;
 * this selector is the file the write-fence guard allows to obtain the handle.
 */
export async function openWhatsAppOutboundKeyFirestore(): Promise<unknown> {
  const db = await getRuntimeFirestore()
  const { createFirestoreOutboundKeyStore } = await import("@/services/d2-1/outboundKeys")
  return createFirestoreOutboundKeyStore(db as never)
}

/** One document in a namespaced Firestore collection. The caller names the collection. */
export async function writeRuntimeDocument(collectionName: string, id: string, data: Record<string, unknown>): Promise<void> {
  const db = await getRuntimeFirestore()
  await setDoc(doc(db as never, collectionName, id), data)
}

/** Patches the named fields. A missing document is not created. */
export async function patchRuntimeDocument(collectionName: string, id: string, data: Record<string, unknown>): Promise<void> {
  const db = await getRuntimeFirestore()
  await updateDoc(doc(db as never, collectionName, id), data)
}

export async function deleteRuntimeDocument(collectionName: string, id: string): Promise<void> {
  const db = await getRuntimeFirestore()
  await deleteDoc(doc(db as never, collectionName, id))
}

export async function readRuntimeDocument(collectionName: string, id: string): Promise<Record<string, unknown> | null> {
  const db = await getRuntimeFirestore()
  const snap = await getDoc(doc(db as never, collectionName, id))
  if (!snap.exists()) return null
  const data = snap.data()
  if (!data || typeof data !== "object") return null
  return data as Record<string, unknown>
}

export async function getRuntimeRepositories(
  store: SpineStore
): Promise<SpineRepositories> {
  if (resolvePersistenceMode() === "memory") return createMemoryRepositories(store)
  const db = await getRuntimeFirestore()
  const mod = await import("@/platform/persistence/firestoreSpineRepositories")
  return mod.createFirestoreRepositories(db as never)
}
