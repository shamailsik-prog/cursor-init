import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/admin", () => ({
  adminDb: vi.fn(() => {
    throw new Error("firestore read")
  }),
}))

import { adminDb } from "../src/admin"
import { addCustodyEvent, getCustodyTrail, verifyCustodyChain } from "../src/d1/evidence/custody"
import { exportEvidenceLog } from "../src/d1/evidence/export"
import { getEvidenceRegister, linkEvidenceToDocument, logEvidence } from "../src/d1/evidence/register"
import type { EvidenceActor } from "../src/d1/evidence/types"

/**
 * The flag is env-only and defaults off. A refusal has to happen before any
 * Firestore read, including when the input itself is garbage: validation is not
 * allowed to run first and a disabled module is not allowed to touch the store.
 */

const FLAG = "SIKANDER_FLAG_D1_EVIDENCE"
const actor: EvidenceActor = {
  uid: "user-1",
  firmId: "firm-1",
  role: "partner",
  clearanceLevel: "privileged-restricted",
}

const calls = [
  ["logEvidence", () => logEvidence(actor, { matterId: "", item: "", source: "", receiptDate: "", custodian: "", classification: "public" })],
  ["addCustodyEvent", () => addCustodyEvent(actor, { evidenceId: "", kind: "handling", note: "" })],
  ["getEvidenceRegister", () => getEvidenceRegister(actor, "")],
  ["getCustodyTrail", () => getCustodyTrail(actor, "")],
  ["linkEvidenceToDocument", () => linkEvidenceToDocument(actor, { evidenceId: "", documentId: "" })],
  ["exportEvidenceLog", () => exportEvidenceLog(actor, "")],
  ["verifyCustodyChain", () => verifyCustodyChain(actor, "")],
] as const

describe("D1 evidence flag", () => {
  beforeEach(() => {
    vi.mocked(adminDb).mockClear()
    delete process.env[FLAG]
  })

  afterEach(() => {
    delete process.env[FLAG]
  })

  it("flag off refuses every operation before any read", async () => {
    for (const [name, call] of calls) {
      await expect(call(), name).rejects.toMatchObject({ name: "EvidenceError", code: "feature_disabled" })
    }
    expect(adminDb).not.toHaveBeenCalled()
  })

  it.each(["false", "1", "yes", "trueish", ""])("value %j is off", async (value) => {
    process.env[FLAG] = value
    await expect(getEvidenceRegister(actor, "matter-1")).rejects.toMatchObject({ code: "feature_disabled" })
    expect(adminDb).not.toHaveBeenCalled()
  })

  it("a malformed caller or clock is invalid_input and does not reach the store", async () => {
    process.env[FLAG] = "true"
    const input = { matterId: "matter-1", item: "x", source: "y", receiptDate: "2026-01-15", custodian: "z", classification: "internal" as const }
    await expect(logEvidence(null as unknown as EvidenceActor, input)).rejects.toMatchObject({ name: "EvidenceError", code: "invalid_input" })
    await expect(logEvidence({ ...actor, clearanceLevel: "nope" as EvidenceActor["clearanceLevel"] }, input)).rejects.toMatchObject({ code: "invalid_input" })
    await expect(logEvidence(actor, input, { now: "nope" as unknown as () => number })).rejects.toMatchObject({ code: "invalid_input" })
    await expect(logEvidence(actor, input, { now: () => Number.POSITIVE_INFINITY })).rejects.toMatchObject({ code: "invalid_input" })
    await expect(logEvidence(actor, input, { now: () => { throw new RangeError("bad clock") } })).rejects.toMatchObject({ code: "invalid_input" })
    // A finite instant outside ±8.64e15 makes Date#toISOString throw RangeError. That is invalid_input, not a raw RangeError.
    await expect(logEvidence(actor, input, { now: () => 8.64e15 + 1 })).rejects.toMatchObject({ name: "EvidenceError", code: "invalid_input" })
    await expect(logEvidence(actor, input, { now: () => -8.64e15 - 1 })).rejects.toMatchObject({ name: "EvidenceError", code: "invalid_input" })
    await expect(logEvidence(actor, input, { now: () => Number.MAX_VALUE })).rejects.toMatchObject({ name: "EvidenceError", code: "invalid_input" })
    expect(adminDb).not.toHaveBeenCalled()
  })

  it("a client or an intern author is refused before any read", async () => {
    process.env[FLAG] = "true"
    const client = { ...actor, role: "client" as const }
    const intern = { ...actor, role: "intern" as const }
    await expect(getEvidenceRegister(client, "matter-1")).rejects.toMatchObject({ code: "not_staff" })
    await expect(logEvidence(client, { matterId: "matter-1", item: "x", source: "y", receiptDate: "2026-01-15", custodian: "z", classification: "internal" })).rejects.toMatchObject({ code: "not_author" })
    await expect(addCustodyEvent(intern, { evidenceId: "ev1", kind: "annotation", note: "no" })).rejects.toMatchObject({ code: "not_author" })
    expect(adminDb).not.toHaveBeenCalled()
  })

  it.each(["true", " true ", "TRUE", "TRUE "])("value %j is on and only then touches the store", async (value) => {
    process.env[FLAG] = value
    await expect(getEvidenceRegister(actor, "matter-1")).rejects.toThrow("firestore read")
    expect(adminDb).toHaveBeenCalled()
  })
})
