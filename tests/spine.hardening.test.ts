import { describe, expect, it } from "vitest"
import { newStore } from "@/platform/spine/store"
import { seedUser, checkPermission } from "@/platform/p5/checkPermission"
import { handleWhatsApp } from "@/services/d2-1/whatsapp"
import { IdempotencyError, IdempotencyCache, requireIdempotencyKey } from "@/platform/http/idempotency"
import { uploadDocument, ocrJobsFor } from "@/services/d1-6/uploadDocument"
import {
  addMember,
  confirmEngagement,
  createMatter,
} from "@/services/d1-2/matters"
import { escalateSilence } from "@/platform/p4/intimation"
import { createClient, conflictCheck } from "@/services/d1-1/clients"
import { searchCorpus } from "@/services/d5-1/research"
import {
  checkTemporalConsistency,
  seedSection,
  seedJudgment,
  seedTreatment,
  verifyCitations,
} from "@/services/d4-2/draftingIntelligence"
import { declassify, setClassification } from "@/platform/classification/declassify"
import { proposeChange } from "@/platform/p6/proposeChange"
import { requestTranslation } from "@/platform/p1/translate"
import { setTransportForTests } from "@/platform/p1/internalAICaller"

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
    const cache = new IdempotencyCache<string>(50, 2)
    cache.set("a", "one")
    cache.set("b", "two")
    cache.set("c", "three")
    expect(cache.size).toBe(2)
    expect(cache.get("a")).toBeUndefined()
    expect(cache.get("c")).toBe("three")
  })

  it("refuses cross-firm matter membership and does not list the other firm's matter", () => {
    const store = newStore()
    seedUser(store, {
      id: "partnerB",
      firmId: "firmB",
      role: "partner",
      clearanceLevel: "privileged-restricted",
    })
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "c1",
      title: "secret",
      courtId: "SHC",
      classification: "privileged",
    })
    expect(() => addMember(store, matter.id, "partnerB", "firmB")).toThrow(
      /cross-firm/
    )
    expect(store.members.size).toBe(0)
  })

  it("refuses unknown classification on upload instead of storing it", () => {
    const store = newStore()
    expect(() =>
      uploadDocument(store, {
        firmId: "firmA",
        matterId: null,
        bytes: Buffer.from("x"),
        sourceChannel: "web",
        classification: "super-secret" as never,
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
      })
    ).toThrow(/classification/)
  })

  it("search refuses embeddings whose vector length is not 1536", () => {
    const store = newStore()
    store.embeddings.push({
      entityId: "j1",
      model: "text-embedding-3-small",
      vector: [0, 1, 2],
    })
    expect(() => searchCorpus(store, "text-embedding-3-small")).toThrow(/refuses/)
  })

  it("citation OVERRULED override is partner-only", () => {
    const store = newStore()
    seedUser(store, {
      id: "intern1",
      firmId: "firmA",
      role: "intern",
      clearanceLevel: "internal",
    })
    seedJudgment(store, "j-old", "Cited authority", "single")
    seedJudgment(store, "j-later", "Larger bench", "larger")
    seedTreatment(store, "j-later", "j-old", "overruled", "larger")
    const blocked = verifyCitations(store, ["j-old"], {
      partnerId: "intern1",
      reason: "because I said so",
    })
    expect(blocked.status).toBe("OVERRULED")
  })

  it("createClient refuses a write without a known classification", () => {
    const store = newStore()
    expect(() =>
      createClient(store, {
        firmId: "firmA",
        canonicalName: "A",
        cnic: "4210112345671",
        phone: "03001111111",
        classification: "nope" as never,
      })
    ).toThrow(/classification/)
  })

  it("intern cannot /research; clerk below clearance cannot research a privileged matter", () => {
    const store = newStore()
    seedUser(store, {
      id: "intern1",
      firmId: "firmA",
      role: "intern",
      clearanceLevel: "internal",
    })
    seedUser(store, {
      id: "clerk1",
      firmId: "firmA",
      role: "clerk",
      clearanceLevel: "internal",
    })
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "c1",
      title: "secret",
      courtId: "SHC",
      classification: "privileged",
    })
    addMember(store, matter.id, "clerk1", "firmA")
    expect(handleWhatsApp(store, "intern1", "/research PPC 302").denied).toBe(true)
    expect(checkPermission(store, "clerk1", "research", matter.id).allow).toBe(false)
    expect(checkPermission(store, "clerk1", "research", matter.id).reason).toBe("clearance")
  })

  it("conflictCheck does not report CLEAR for an unknown or cross-firm id", () => {
    const store = newStore()
    expect(() => conflictCheck(store, "firmA", "missing")).toThrow(/unknown entity/)
  })

  it("createMatter refuses an unknown classification label", () => {
    const store = newStore()
    expect(() =>
      createMatter(store, {
        firmId: "firmA",
        clientId: "c1",
        title: "secret",
        courtId: "SHC",
        classification: "super-secret" as never,
      })
    ).toThrow(/classification/)
  })

  it("setClassification refuses an unknown next rank instead of storing it", () => {
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
      bytes: Buffer.from("memo"),
      sourceChannel: "web",
      classification: "internal",
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
    })
    expect(() =>
      setClassification(store, up.docId, "super-secret" as never, "partner1")
    ).toThrow(/classification/)
    expect(store.documents.get(up.docId)?.classification).toBe("internal")
  })

  it("proposeChange and seedUser refuse unknown classification", () => {
    const store = newStore()
    expect(() =>
      seedUser(store, {
        id: "u1",
        firmId: "firmA",
        role: "clerk",
        clearanceLevel: "nope" as never,
      })
    ).toThrow(/classification/)
    expect(() =>
      proposeChange({
        firmId: "firmA",
        sourceModule: "d4-2",
        classification: "nope" as never,
        payload: {},
        proposedBy: "partner1",
      })
    ).toThrow(/classification/)
  })

  it("requestTranslation forwards partyNames into P1 so they never leave", async () => {
    const party = "Ayesha Siddiqui"
    setTransportForTests({
      async send(request) {
        expect(request.body).not.toContain(party)
        expect(request.body).toContain("[PARTY]")
        return { text: `Translated for ${party}` }
      },
    })
    try {
      const result = await requestTranslation({
        text: `Opinion for ${party}`,
        classification: "public",
        partyNames: [party],
      })
      expect(result.blocked).toBe(false)
      expect(result.text).not.toContain(party)
      expect(result.text).toContain("[PARTY]")
    } finally {
      setTransportForTests(null)
    }
  })
})
