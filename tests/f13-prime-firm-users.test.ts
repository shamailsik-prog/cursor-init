// Audit F13 slice 5 (mutant S4-001d): primeFirmUsers keeps its own `row.firmId === firmId` check. The users repository
// trims the firm it is given (requireCallerFirmId), so a padded firmId reaches the trimmed firm's rows; only that check
// keeps them out of the session cache.
import { describe, expect, it } from "vitest"
import { primeFirmUsers } from "@/platform/d1/primeFirmUsers"
import { requireCallerFirmId } from "@/platform/persistence/callerFirm"
import { newStore } from "@/platform/spine/store"
import type { User } from "@/platform/spine/store"

const row = (id: string, firmId: string, active = true) => ({ id, firmId, active, role: "client", clearanceLevel: "internal" }) as unknown as User

/** A users repository scoped the way the real ones are: by the trimmed caller firm. */
function repoWith(rows: User[]) {
  return {
    users: {
      async get(id: string, firmId: string) {
        const firm = requireCallerFirmId(firmId, "users.get")
        return rows.find((r) => r.id === id && r.firmId === firm) ?? null
      },
    },
  } as never
}

describe("F13 slice 5: primeFirmUsers (S4-001d)", () => {
  it("a padded firmId caches none of the trimmed firm's users", async () => {
    const store = newStore()
    await primeFirmUsers(store, repoWith([row("u1", "firmA")]), " firmA ", ["u1"])
    expect(store.users.has("u1")).toBe(false)
  })

  it("the exact firm caches its active user, and never an inactive one", async () => {
    const store = newStore()
    await primeFirmUsers(store, repoWith([row("u1", "firmA"), row("u2", "firmA", false)]), "firmA", ["u1", "u2"])
    expect(store.users.get("u1")?.firmId).toBe("firmA")
    expect(store.users.has("u2")).toBe(false)
  })
})
