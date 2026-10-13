import { resetDocumentObjectStoreForTests } from "@/platform/documents/documentObjectStore"
import { newStore, type SpineStore } from "@/platform/spine/store"

/**
 * SEC-5: the demo identities (partner_a … in firmA, partner_b in a second firm, firmB) exist only
 * outside production. A production process starts with an empty store, so a Firebase uid that
 * happens to be "partner_a" is never a provisioned partner and there is no second firm (R-5).
 */
function seedsDemoIdentities(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production"
}

function buildSeededStore(): SpineStore {
  const store = newStore()
  // R4-6: a dead-letter is written to the audit_dead_letter repository the moment it happens.
  store.audit.setDeadLetterWriter(async (letter) => {
    const { getRuntimeRepositories } = await import("@/platform/persistence/runtimeRepositories")
    const repos = await getRuntimeRepositories(store)
    await repos.auditDeadLetter.append(letter)
  })
  if (!seedsDemoIdentities()) return store
  store.users.set("partner_a", {
    id: "partner_a",
    firmId: "firmA",
    role: "partner",
    clearanceLevel: "privileged-restricted",
    active: true,
  })
  store.users.set("associate_a", {
    id: "associate_a",
    firmId: "firmA",
    role: "associate",
    clearanceLevel: "privileged",
    active: true,
  })
  store.users.set("clerk_a", {
    id: "clerk_a",
    firmId: "firmA",
    role: "clerk",
    clearanceLevel: "confidential",
    active: true,
  })
  store.users.set("client_a", {
    id: "client_a",
    firmId: "firmA",
    role: "client",
    clearanceLevel: "internal",
    active: true,
  })
  store.users.set("partner_b", {
    id: "partner_b",
    firmId: "firmB",
    role: "partner",
    clearanceLevel: "privileged-restricted",
    active: true,
  })
  return store
}

let runtimeStore = buildSeededStore()

export function getRuntimeStore(): SpineStore {
  return runtimeStore
}

export function resetRuntimeStoreForTests(): void {
  resetDocumentObjectStoreForTests()
  runtimeStore = buildSeededStore()
}
