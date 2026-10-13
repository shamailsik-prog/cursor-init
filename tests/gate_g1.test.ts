import { describe, expect, it } from "vitest"
import { newStore } from "@/platform/spine/store"
import { seedUser } from "@/platform/p5/checkPermission"
import { uploadDocument, ocrJobsFor } from "@/services/d1-6/uploadDocument"
import { createClient, conflictCheck } from "@/services/d1-1/clients"
import {
  addMember,
  confirmEngagement,
  createMatter,
} from "@/services/d1-2/matters"
import { escalateSilence, intimationsFor } from "@/platform/p4/intimation"
import { handleWhatsApp } from "@/services/d2-1/whatsapp"
import {
  checkTemporalConsistency,
  getSectionAsAt,
  seedJudgment,
  seedSection,
  seedTreatment,
  verifyCitations,
} from "@/services/d4-2/draftingIntelligence"
import { followUpsFor, recordCaseNumber } from "@/services/d6-1/caseNumber"
import {
  changeEmbeddingModel,
  reembedCorpus,
  searchCorpus,
} from "@/services/d5-1/research"
import { declassify, setClassification } from "@/platform/classification/declassify"
import { requestTranslation } from "@/platform/p1/translate"
import { setTransportForTests } from "@/platform/p1/internalAICaller"

describe("Gate G-1 forensic spine", () => {
  it("G1-1 triple upload same hash, three idempotency keys -> one document, reused:true, one OCR job", async () => {
    const store = newStore()
    const bytes = Buffer.from("%PDF-same-hash%")
    const a = await uploadDocument(store, {
      firmId: "firmA",
      matterId: null,
      bytes,
      sourceChannel: "web",
      classification: "internal",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      uploadedBy: "partner_a",
    })
    const b = await uploadDocument(store, {
      firmId: "firmA",
      matterId: null,
      bytes,
      sourceChannel: "team_portal",
      classification: "internal",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      uploadedBy: "partner_a",
    })
    const c = await uploadDocument(store, {
      firmId: "firmA",
      matterId: null,
      bytes,
      sourceChannel: "bulk",
      classification: "internal",
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
      uploadedBy: "partner_a",
    })
    expect(a.reused).toBe(false)
    expect(b.reused).toBe(true)
    expect(c.reused).toBe(true)
    expect(b.docId).toBe(a.docId)
    expect(c.docId).toBe(a.docId)
    expect(store.documents.size).toBe(1)
    expect(ocrJobsFor(store, a.docId)).toHaveLength(1)
  })

  it("G1-2 WhatsApp /matters as clerk with two memberships -> two matters; client number -> own matters; client /research -> denied", () => {
    const store = newStore()
    seedUser(store, {
      id: "clerk1",
      firmId: "firmA",
      role: "clerk",
      clearanceLevel: "confidential",
    })
    seedUser(store, {
      id: "client1",
      firmId: "firmA",
      role: "client",
      clearanceLevel: "internal",
    })
    const m1 = createMatter(store, {
      firmId: "firmA",
      clientId: "client1",
      title: "Matter one",
      courtId: "SHC",
      classification: "internal",
    })
    const m2 = createMatter(store, {
      firmId: "firmA",
      clientId: "other-client",
      title: "Matter two",
      courtId: "SHC",
      classification: "internal",
    })
    addMember(store, m1.id, "clerk1", "firmA")
    addMember(store, m2.id, "clerk1", "firmA")
    addMember(store, m1.id, "client1", "firmA")

    const clerkMatters = handleWhatsApp(store, "clerk1", "/matters")
    expect(clerkMatters.denied).toBeFalsy()
    expect(clerkMatters.matters).toHaveLength(2)

    const clientMatters = handleWhatsApp(store, "client1", "/matters")
    expect(clientMatters.matters).toHaveLength(1)
    expect(clientMatters.matters?.[0]?.id).toBe(m1.id)

    const research = handleWhatsApp(store, "client1", "/research PPC 302")
    expect(research.denied).toBe(true)
    expect(research.ok).toBe(false)
  })

  it("G1-3 two 'Muhammad Ali' same CNIC -> candidate link; conflict -> POSSIBLE_CANDIDATE_REVIEW never CLEAR", () => {
    const store = newStore()
    const a = createClient(store, {
      firmId: "firmA",
      canonicalName: "Muhammad Ali",
      cnic: "4210112345671",
      phone: "03001111111",
      classification: "internal",
    })
    const b = createClient(store, {
      firmId: "firmA",
      canonicalName: "Muhammad Ali",
      cnic: "4210112345671",
      phone: "03002222222",
      classification: "internal",
    })
    expect(store.links).toHaveLength(1)
    expect(store.links[0]?.identityBasis).toBe("cnic")
    expect(store.links[0]?.band).toBe("confirmed-candidate")
    const check = conflictCheck(store, "firmA", a.id)
    expect(check.status).toBe("POSSIBLE_CANDIDATE_REVIEW")
    expect(check.status).not.toBe("CLEAR")
    expect(check.identityBasis).toBe("cnic")
    expect(conflictCheck(store, "firmA", b.id).status).not.toBe("CLEAR")
  })

  it("G1-4 authority overruled by larger bench (treatment seeded) -> OVERRULED block; partner reason to override", () => {
    const store = newStore()
    seedUser(store, {
      id: "partner1",
      firmId: "firmA",
      role: "partner",
      clearanceLevel: "privileged-restricted",
    })
    seedJudgment(store, "j-old", "Cited authority", "single")
    seedJudgment(store, "j-later", "Larger bench", "larger")
    seedTreatment(store, "j-later", "j-old", "overruled", "larger")
    const blocked = verifyCitations(store, ["j-old"])
    expect(blocked.status).toBe("OVERRULED")
    if (blocked.status === "OVERRULED") expect(blocked.blocked).toBe(true)
    const internAttempt = verifyCitations(
      store,
      ["j-old"],
      { partnerId: "intern1", reason: "because I said so" },
      { actorId: "intern1", firmId: "firmA" }
    )
    expect(internAttempt.status).toBe("OVERRULED")
    const spoofed = verifyCitations(
      store,
      ["j-old"],
      { partnerId: "partner1", reason: "named someone else" },
      { actorId: "associate1", firmId: "firmA" }
    )
    expect(spoofed.status).toBe("OVERRULED")
    const crossFirm = verifyCitations(
      store,
      ["j-old"],
      { partnerId: "partner1", reason: "other firm matter" },
      { actorId: "partner1", firmId: "firmB" }
    )
    expect(crossFirm.status).toBe("OVERRULED")
    const overridden = verifyCitations(
      store,
      ["j-old"],
      { partnerId: "partner1", reason: "Partner recorded reason" },
      { actorId: "partner1", firmId: "firmA" }
    )
    expect(overridden.status).toBe("OK")
  })

  it("G1-5 PPC section amended 2018, offence 2015 -> getSectionAsAt returns 2015 text; current text -> TEMPORAL-MISMATCH block", () => {
    const store = newStore()
    seedSection(store, "ppc_302", [
      {
        versionNo: 1,
        effectiveFrom: "1860-10-06",
        effectiveTo: "2018-01-01",
        text: "PPC 302 text as in 2015",
      },
      {
        versionNo: 2,
        effectiveFrom: "2018-01-01",
        effectiveTo: null,
        text: "PPC 302 text as amended 2018",
      },
    ])
    const asAt = getSectionAsAt(store, "ppc_302", "2015-06-01")
    expect(asAt?.text).toBe("PPC 302 text as in 2015")
    const mismatch = checkTemporalConsistency(
      store,
      "ppc_302",
      "2015-06-01",
      "PPC 302 text as amended 2018"
    )
    expect(mismatch.status).toBe("TEMPORAL-MISMATCH")
    const ok = checkTemporalConsistency(
      store,
      "ppc_302",
      "2015-06-01",
      "PPC 302 text as in 2015"
    )
    expect(ok.status).toBe("OK")
  })

  it("G1-6 matter without engagement confirmed -> no intimation row; after confirmation -> accounts notified; silence 24h -> L4.10", () => {
    const store = newStore()
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "c1",
      title: "New brief",
      courtId: "SHC",
      classification: "internal",
    })
    expect(intimationsFor(store, matter.id)).toHaveLength(0)
    const t0 = Date.parse("2026-09-01T00:00:00Z")
    confirmEngagement(store, matter.id, t0)
    expect(intimationsFor(store, matter.id)).toHaveLength(1)
    escalateSilence(store, matter.id, t0 + 23 * 60 * 60 * 1000)
    expect(store.followUps.filter((f) => f.kind === "l4_10_silence")).toHaveLength(0)
    escalateSilence(store, matter.id, t0 + 24 * 60 * 60 * 1000)
    expect(store.followUps.filter((f) => f.kind === "l4_10_silence")).toHaveLength(1)
  })

  it("G1-7 privileged document -> translation request -> P1 blocks provider without DPA (ai.call.blocked) or requires partner reason", async () => {
    let sent = false
    setTransportForTests({
      async send() {
        sent = true
        return { text: "no" }
      },
    })
    try {
      const result = await requestTranslation({
        text: "Privileged opinion for the client",
        classification: "privileged",
      })
      expect(result.blocked).toBe(true)
      expect(result.event).toBe("ai.call.blocked")
      expect(sent).toBe(false)
      expect(result.classification).toBe("privileged")
    } finally {
      setTransportForTests(null)
    }
  })

  it("G1-8 classification downgrade without declassify() -> trigger exception; with partner declassify -> succeeds, audit logged", async () => {
    const store = newStore()
    seedUser(store, {
      id: "partner1",
      firmId: "firmA",
      role: "partner",
      clearanceLevel: "privileged-restricted",
    })
    const up = await uploadDocument(store, {
      firmId: "firmA",
      matterId: null,
      bytes: Buffer.from("privileged-memo"),
      sourceChannel: "web",
      classification: "privileged",
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
      uploadedBy: "partner_a",
    })
    expect(() =>
      setClassification(store, up.docId, "internal", "partner1")
    ).toThrow(/declassify/)
    declassify(store, up.docId, "internal", "partner1", "Client waived for filing")
    expect(store.documents.get(up.docId)?.classification).toBe("internal")
    expect(store.audit.some((a) => a.action === "declassify" && a.target === up.docId)).toBe(
      true
    )
  })

  it("G1-9 'C.P. No. D-1234 of 2025' on SHC -> CP D-1234/2025 recorded; 'CP 1234' -> rejected, follow-up opened", () => {
    const store = newStore()
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "c1",
      title: "SHC petition",
      courtId: "SHC",
      classification: "internal",
    })
    const ok = recordCaseNumber(store, matter.id, "C.P. No. D-1234 of 2025", "SHC")
    expect(ok.status).toBe("OK")
    expect(ok.canonical).toBe("CP D-1234/2025")
    expect(store.matters.get(matter.id)?.caseNumber).toBe("CP D-1234/2025")

    const matter2 = createMatter(store, {
      firmId: "firmA",
      clientId: "c1",
      title: "Bad number",
      courtId: "SHC",
      classification: "internal",
    })
    const bad = recordCaseNumber(store, matter2.id, "CP 1234", "SHC")
    expect(bad.status).toBe("REJECT")
    expect(followUpsFor(store, matter2.id).some((f) => f.kind === "case_number_reject")).toBe(
      true
    )
  })

  it("G1-10 corpus_metadata.embedding_model changed while embeddings exist -> search refuses; reembedCorpus keeps old vectors until confirmed", () => {
    const store = newStore()
    store.embeddings.push({
      entityId: "j1",
      model: "text-embedding-3-small",
      vector: new Array(1536).fill(0),
    })
    changeEmbeddingModel(store, "text-embedding-3-large")
    expect(() => searchCorpus(store, "text-embedding-3-large")).toThrow(/refuses/)
    expect(() => searchCorpus(store, "text-embedding-3-small")).toThrow(/refuses/)
    const held = reembedCorpus(store, "text-embedding-3-large", false)
    expect(held.keptOld).toBe(true)
    expect(store.embeddings[0]?.model).toBe("text-embedding-3-small")
    const done = reembedCorpus(store, "text-embedding-3-large", true)
    expect(done.keptOld).toBe(false)
    expect(store.embeddings[0]?.model).toBe("text-embedding-3-large")
    expect(searchCorpus(store, "text-embedding-3-large").items).toHaveLength(1)
  })
})
