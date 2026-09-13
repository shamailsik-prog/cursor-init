import { describe, expect, it } from "vitest"
import { newStore } from "@/platform/spine/store"
import { seedUser } from "@/platform/p5/checkPermission"
import { uploadDocument, ocrJobsFor } from "@/services/d1-6/uploadDocument"
import {
  addMember,
  confirmEngagement,
  createMatter,
} from "@/services/d1-2/matters"
import { escalateSilence } from "@/platform/p4/intimation"
import {
  checkTemporalConsistency,
  seedSection,
} from "@/services/d4-2/draftingIntelligence"
import { declassify, setClassification } from "@/platform/classification/declassify"
import { IdempotencyError, requireIdempotencyKey } from "@/platform/http/idempotency"

describe("G-1 spine hardening", () => {
  it("same-hash reuse inherits the higher classification and does not add a second OCR job", () => {
    const store = newStore()
    const bytes = Buffer.from("%PDF-same-hash-class%")
    const first = uploadDocument(store, {
      firmId: "firmA",
      matterId: null,
      bytes,
      sourceChannel: "web",
      classification: "internal",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    })
    const second = uploadDocument(store, {
      firmId: "firmA",
      matterId: null,
      bytes,
      sourceChannel: "bulk",
      classification: "privileged",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    })
    expect(second.reused).toBe(true)
    expect(second.docId).toBe(first.docId)
    expect(store.documents.get(first.docId)?.classification).toBe("privileged")
    expect(ocrJobsFor(store, first.docId)).toHaveLength(1)
    expect(ocrJobsFor(store, first.docId)[0]?.classification).toBe("privileged")
  })

  it("same-hash reuse never downgrades classification", () => {
    const store = newStore()
    const bytes = Buffer.from("%PDF-no-downgrade%")
    const first = uploadDocument(store, {
      firmId: "firmA",
      matterId: null,
      bytes,
      sourceChannel: "web",
      classification: "privileged",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    })
    uploadDocument(store, {
      firmId: "firmA",
      matterId: null,
      bytes,
      sourceChannel: "bulk",
      classification: "internal",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    })
    expect(store.documents.get(first.docId)?.classification).toBe("privileged")
  })

  it("intern cannot downgrade by passing a fake reason into setClassification", () => {
    const store = newStore()
    seedUser(store, {
      id: "intern1",
      firmId: "firmA",
      role: "intern",
      clearanceLevel: "confidential",
    })
    const up = uploadDocument(store, {
      firmId: "firmA",
      matterId: null,
      bytes: Buffer.from("privileged-memo"),
      sourceChannel: "web",
      classification: "privileged",
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
    })
    expect(() =>
      setClassification(
        store,
        up.docId,
        "internal",
        "intern1",
        "I made up a reason"
      )
    ).toThrow(/declassify/)
    expect(store.documents.get(up.docId)?.classification).toBe("privileged")
  })

  it("partner declassify still succeeds after the partner-only check", () => {
    const store = newStore()
    seedUser(store, {
      id: "partner1",
      firmId: "firmA",
      role: "partner",
      clearanceLevel: "privileged-restricted",
    })
    const up = uploadDocument(store, {
      firmId: "firmA",
      matterId: null,
      bytes: Buffer.from("privileged-memo-2"),
      sourceChannel: "web",
      classification: "privileged",
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
    })
    declassify(store, up.docId, "internal", "partner1", "Client waived for filing")
    expect(store.documents.get(up.docId)?.classification).toBe("internal")
  })

  it("L4.10 silence follow-up is idempotent across repeated escalations", () => {
    const store = newStore()
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "c1",
      title: "New brief",
      courtId: "SHC",
      classification: "internal",
    })
    addMember(store, matter.id, "clerk1", "firmA")
    const t0 = Date.parse("2026-09-01T00:00:00Z")
    confirmEngagement(store, matter.id, t0)
    escalateSilence(store, matter.id, t0 + 24 * 60 * 60 * 1000)
    escalateSilence(store, matter.id, t0 + 25 * 60 * 60 * 1000)
    expect(store.followUps.filter((f) => f.kind === "l4_10_silence")).toHaveLength(1)
  })

  it("unknown statute section is a TEMPORAL-MISMATCH, not a silent OK", () => {
    const store = newStore()
    seedSection(store, "ppc_302", [
      {
        versionNo: 1,
        effectiveFrom: "1860-10-06",
        effectiveTo: null,
        text: "PPC 302 text",
      },
    ])
    const missing = checkTemporalConsistency(
      store,
      "ppc_999",
      "2015-06-01",
      "whatever counsel typed"
    )
    expect(missing.status).toBe("TEMPORAL-MISMATCH")
  })

  it("Idempotency-Key must be UUID v4", () => {
    expect(() =>
      requireIdempotencyKey(new Request("http://local", { headers: {} }))
    ).toThrow(IdempotencyError)
    expect(() =>
      requireIdempotencyKey(
        new Request("http://local", { headers: { "Idempotency-Key": "not-a-uuid" } })
      )
    ).toThrow(/UUID v4/)
    const key = "11111111-1111-4111-8111-111111111111"
    expect(
      requireIdempotencyKey(
        new Request("http://local", { headers: { "Idempotency-Key": key } })
      )
    ).toBe(key)
  })
})
