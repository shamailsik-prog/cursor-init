import { newStore, type SpineStore } from "@/platform/spine/store"

function buildSeededStore(): SpineStore {
  const store = newStore()
  // R4-6: a dead-letter is written to the audit_dead_letter repository the moment it happens.
  store.audit.setDeadLetterWriter(async (letter) => {
    const { getRuntimeRepositories } = await import("@/platform/persistence/runtimeRepositories")
    const repos = await getRuntimeRepositories(store)
    await repos.auditDeadLetter.append(letter)
  })
  store.users.set("partner_a", {
    id: "partner_a",
    firmId: "firmA",
    role: "partner",
    clearanceLevel: "privileged-restricted",
  })
  store.users.set("associate_a", {
    id: "associate_a",
    firmId: "firmA",
    role: "associate",
    clearanceLevel: "privileged",
  })
  store.users.set("clerk_a", {
    id: "clerk_a",
    firmId: "firmA",
    role: "clerk",
    clearanceLevel: "confidential",
  })
  store.users.set("client_a", {
    id: "client_a",
    firmId: "firmA",
    role: "client",
    clearanceLevel: "internal",
  })
  store.users.set("partner_b", {
    id: "partner_b",
    firmId: "firmB",
    role: "partner",
    clearanceLevel: "privileged-restricted",
  })
  return store
}

let runtimeStore = buildSeededStore()

export function getRuntimeStore(): SpineStore {
  return runtimeStore
}

export function resetRuntimeStoreForTests(): void {
  runtimeStore = buildSeededStore()
}
