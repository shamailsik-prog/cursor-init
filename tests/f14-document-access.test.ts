import { describe, expect, it } from "vitest"
import { canReadDocument } from "@/platform/p5/documentAccess"
import { newStore, type DocumentRecord, type User } from "@/platform/spine/store"
import { addMember, createMatter } from "@/services/d1-2/matters"

/**
 * Audit F14, Copilot C2: `canReadDocument` mirrors firestore.rules `match /documents`, where only an explicit
 * `matterId == null` is the loose vault. Firestore rows reach the Next routes cast, not validated, so a malformed row
 * (an empty, missing or non-string matterId) must fail closed, not read as a loose-vault document.
 */

type Row = Pick<DocumentRecord, "firmId" | "classification" | "matterId">

function setup() {
  const store = newStore()
  const clerk: User = { id: "clerk_x", firmId: "firmA", role: "clerk", clearanceLevel: "confidential", active: true }
  const partner: User = { id: "partner_x", firmId: "firmA", role: "partner", clearanceLevel: "privileged-restricted", active: true }
  const associate: User = { id: "associate_x", firmId: "firmA", role: "associate", clearanceLevel: "privileged", active: true }
  for (const user of [clerk, partner, associate]) store.users.set(user.id, user)
  const matter = createMatter(store, { firmId: "firmA", clientId: "client_x", title: "C2", courtId: "SHC", classification: "internal" })
  for (const user of [clerk, partner, associate]) addMember(store, matter.id, user.id, "firmA")
  return { store, clerk, partner, associate, matterId: matter.id }
}

/** A row as a Firestore read hands it over: cast, so `matterId` may hold anything, or be absent. */
const rowWith = (matterId: unknown): Row => ({ firmId: "firmA", classification: "internal", matterId }) as unknown as Row
const rowWithout = (): Row => ({ firmId: "firmA", classification: "internal" }) as unknown as Row

describe("Audit F14 C2: canReadDocument treats only an explicit null matterId as the loose vault", () => {
  it("an empty, missing, non-string or unknown matterId denies every role; an explicit null and a real matter read as before", () => {
    const { store, clerk, partner, associate, matterId } = setup()
    for (const user of [clerk, partner]) {
      // Explicit null: the loose vault (clerk and partner cleared confidential, E-18), as before.
      expect(canReadDocument(store, user, rowWith(null))).toBe(true)
      // A real matter the user is a member of: read, as before.
      expect(canReadDocument(store, user, rowWith(matterId))).toBe(true)
      for (const malformed of ["", 0, false, 42, {}, [], "m_unknown"]) {
        expect({ matterId: malformed, allowed: canReadDocument(store, user, rowWith(malformed)) }).toEqual({ matterId: malformed, allowed: false })
      }
      expect(canReadDocument(store, user, rowWith(undefined))).toBe(false)
      expect(canReadDocument(store, user, rowWithout())).toBe(false)
    }
    // An associate never reads the loose vault, and a malformed row no more.
    expect(canReadDocument(store, associate, rowWith(null))).toBe(false)
    expect(canReadDocument(store, associate, rowWith(matterId))).toBe(true)
    expect(canReadDocument(store, associate, rowWith(""))).toBe(false)
  })
})
