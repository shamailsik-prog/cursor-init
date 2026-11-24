import { afterEach, describe, expect, it } from "vitest"
import { adminDb } from "../src/admin"
import { addCustodyEvent, getCustodyTrail, verifyCustodyChain } from "../src/d1/evidence/custody"
import { exportEvidenceLog } from "../src/d1/evidence/export"
import { getEvidenceItem, getEvidenceRegister, linkEvidenceToDocument, logEvidence } from "../src/d1/evidence/register"
import { EVIDENCE_ITEMS, CUSTODY_EVENTS, type EvidenceActor } from "../src/d1/evidence/types"
import { EMULATORS, uniq } from "./emu"

/**
 * Module 4 acceptance tests against the Firestore emulator. The Admin SDK seeds
 * tampered events directly; the module itself never updates or deletes one.
 */

const FLAG = "SIKANDER_FLAG_D1_EVIDENCE"

function actor(over: Partial<EvidenceActor> = {}): EvidenceActor {
  return {
    uid: over.uid ?? uniq("user"),
    firmId: over.firmId ?? uniq("firm"),
    role: over.role ?? "partner",
    clearanceLevel: over.clearanceLevel ?? "privileged-restricted",
    ...over,
  }
}

async function seedMatter(caller: EvidenceActor, matterId: string, classification = "internal"): Promise<void> {
  const db = adminDb()
  await db.collection("matters").doc(matterId).set({
    firmId: caller.firmId,
    clientId: "client-1",
    title: "State v. Example",
    classification,
    status: "live",
  })
  await db.collection("matter_members").doc(`${matterId}_${caller.uid}`).set({
    firmId: caller.firmId,
    matterId,
    userId: caller.uid,
  })
}

function documentData(caller: EvidenceActor, matterId: string | null, classification: string) {
  return {
    firmId: caller.firmId,
    matterId,
    contentHash: "ab".repeat(32),
    sourceChannel: "web",
    classification,
    storagePath: `mem://${caller.firmId}/doc`,
    isImmutable: true,
    byteSize: 12,
    mimeType: "application/pdf",
    objectVersion: 1,
    uploadedBy: caller.uid,
    objectBytesStatus: "available",
  }
}

describe.skipIf(!EMULATORS)("D1 evidence register and custody chain", () => {
  afterEach(() => {
    delete process.env[FLAG]
  })

  it("flag off refuses before the register is read", async () => {
    delete process.env[FLAG]
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    await expect(getEvidenceRegister(caller, matterId)).rejects.toMatchObject({ code: "feature_disabled" })
    await expect(verifyCustodyChain(caller, "ev-missing")).rejects.toMatchObject({ code: "feature_disabled" })
  })

  it("two concurrent custody events take seq 1 and 2 with no gap and no duplicate", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    const item = await logEvidence(caller, {
      matterId,
      item: "seized handset",
      source: "recovery memo",
      receiptDate: "2026-01-15",
      custodian: "clerk A",
      classification: "internal",
    })
    const [left, right] = await Promise.all([
      addCustodyEvent(caller, { evidenceId: item.id, kind: "handling", note: "logged into the malkhana" }),
      addCustodyEvent(caller, { evidenceId: item.id, kind: "condition", note: "seal intact" }),
    ])
    expect([left.seq, right.seq].sort()).toEqual([1, 2])
    expect(left.hash).not.toBe(right.hash)
    const trail = await getCustodyTrail(caller, item.id)
    expect(trail.map((event) => event.seq)).toEqual([1, 2])
    expect(new Set(trail.map((event) => event.hash)).size).toBe(2)
    expect(trail[1]?.prevHash).toBe(trail[0]?.hash)
    expect(trail[0]?.prevHash).toBe("")
    expect(trail.every((event) => event.firmId === caller.firmId)).toBe(true)
    expect((await getEvidenceItem(caller, item.id)).firmId).toBe(caller.firmId)
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: true, eventCount: 2 })
    const db = adminDb()
    expect((await db.collection(EVIDENCE_ITEMS).doc(item.id).get()).exists).toBe(true)
    for (const event of trail) {
      const snap = await db.collection(CUSTODY_EVENTS).doc(event.id).get()
      expect(snap.createTime?.isEqual(snap.updateTime!)).toBe(true)
    }
  })

  it("five concurrent events stay dense", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    const item = await logEvidence(caller, {
      matterId,
      item: "title deed",
      source: "client",
      receiptDate: "2026-02-01",
      custodian: "associate B",
      classification: "confidential",
    })
    const wrote = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => addCustodyEvent(caller, { evidenceId: item.id, kind: "handling", note: `step ${n}` }))
    )
    expect(wrote.map((event) => event.seq).sort()).toEqual([1, 2, 3, 4, 5])
    const trail = await getCustodyTrail(caller, item.id)
    expect(trail.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5])
    for (let i = 1; i < trail.length; i++) expect(trail[i]?.prevHash).toBe(trail[i - 1]?.hash)
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: true, eventCount: 5 })
  })

  it.each([1, 2, 3])("tampering with stored event %i fails verify at that seq", async (seq) => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    const item = await logEvidence(caller, {
      matterId,
      item: "USB drive",
      source: "search",
      receiptDate: "2026-03-01",
      custodian: "clerk A",
      classification: "internal",
    })
    for (const note of ["received", "copied", "returned to the safe"]) {
      await addCustodyEvent(caller, { evidenceId: item.id, kind: "handling", note })
    }
    await adminDb().collection(CUSTODY_EVENTS).doc(`${item.id}_${seq}`).update({ note: "tampered by a direct write" })
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: false, brokenSeq: seq, reason: "hash" })
  })

  it("a seeded gap fails at the missing seq and the module will not extend a broken chain", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    const item = await logEvidence(caller, {
      matterId,
      item: "photograph",
      source: "site",
      receiptDate: "2026-03-02",
      custodian: "clerk A",
      classification: "internal",
    })
    const first = await addCustodyEvent(caller, { evidenceId: item.id, kind: "receipt", note: "taken" })
    const stored = await reload(first)
    await adminDb()
      .collection(CUSTODY_EVENTS)
      .doc(`${item.id}_3`)
      .set({ ...stored, seq: 3, note: "skipped a step" })
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: false, brokenSeq: 2, reason: "gap" })
    await expect(addCustodyEvent(caller, { evidenceId: item.id, kind: "annotation", note: "late note" })).rejects.toMatchObject({
      code: "chain_broken",
    })
  })

  it("a cross-matter or cross-firm document link is refused and the original is not written", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const other = actor({ role: "partner", clearanceLevel: "privileged-restricted" })
    const matterId = uniq("matter")
    const otherMatter = uniq("matter")
    await seedMatter(caller, matterId, "internal")
    await seedMatter(other, otherMatter, "internal")
    const item = await logEvidence(caller, {
      matterId,
      item: "agreement",
      source: "client file",
      receiptDate: "2026-04-01",
      custodian: "partner",
      classification: "internal",
    })
    const db = adminDb()
    const sameFirmOtherMatter = uniq("doc")
    const otherFirmDoc = uniq("doc")
    const same = documentData(caller, otherMatter, "internal")
    const foreign = documentData(other, otherMatter, "internal")
    await db.collection("documents").doc(sameFirmOtherMatter).set(same)
    await db.collection("documents").doc(otherFirmDoc).set(foreign)
    await expect(linkEvidenceToDocument(caller, { evidenceId: item.id, documentId: sameFirmOtherMatter })).rejects.toMatchObject({
      code: "cross_matter",
    })
    await expect(linkEvidenceToDocument(caller, { evidenceId: item.id, documentId: otherFirmDoc })).rejects.toMatchObject({
      code: "cross_firm",
    })
    expect((await db.collection("documents").doc(sameFirmOtherMatter).get()).data()).toEqual(same)
    expect((await db.collection("documents").doc(otherFirmDoc).get()).data()).toEqual(foreign)
    expect((await getEvidenceItem(caller, item.id)).documentId).toBeNull()
  })

  it("a document the caller cannot read is refused", async () => {
    process.env[FLAG] = "true"
    const caller = actor({ role: "associate", clearanceLevel: "internal" })
    const matterId = uniq("matter")
    await seedMatter(caller, matterId, "internal")
    const item = await logEvidence(caller, {
      matterId,
      item: "statement",
      source: "witness",
      receiptDate: "2026-04-02",
      custodian: "associate",
      classification: "internal",
    })
    const documentId = uniq("doc")
    await adminDb().collection("documents").doc(documentId).set(documentData(caller, matterId, "privileged"))
    await expect(linkEvidenceToDocument(caller, { evidenceId: item.id, documentId })).rejects.toMatchObject({ code: "not_permitted" })
  })

  it("linking raises the evidence classification to at least the document and does not modify the original", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId, "internal")
    const item = await logEvidence(caller, {
      matterId,
      item: "audio",
      source: "recording",
      receiptDate: "2026-04-03",
      custodian: "clerk A",
      classification: "internal",
    })
    const documentId = uniq("doc")
    const original = documentData(caller, matterId, "privileged")
    await adminDb().collection("documents").doc(documentId).set(original)
    const linked = await linkEvidenceToDocument(caller, { evidenceId: item.id, documentId })
    expect(linked.classification).toBe("privileged")
    expect(linked.documentId).toBe(documentId)
    const stored = await getEvidenceItem(caller, item.id)
    expect(stored.classification).toBe("privileged")
    expect((await adminDb().collection("documents").doc(documentId).get()).data()).toEqual(original)
    await addCustodyEvent(caller, { evidenceId: item.id, kind: "condition", note: "playback clear" })
    expect((await adminDb().collection("documents").doc(documentId).get()).data()).toEqual(original)
    const higher = await logEvidence(caller, {
      matterId,
      item: "brief",
      source: "counsel",
      receiptDate: "2026-04-04",
      custodian: "partner",
      classification: "privileged-restricted",
    })
    const lowDoc = uniq("doc")
    await adminDb().collection("documents").doc(lowDoc).set(documentData(caller, matterId, "internal"))
    const stayed = await linkEvidenceToDocument(caller, { evidenceId: higher.id, documentId: lowDoc })
    expect(stayed.classification).toBe("privileged-restricted")
  })

  it("the matter floor raises a lower requested classification", async () => {
    process.env[FLAG] = "true"
    const caller = actor({ clearanceLevel: "privileged" })
    const matterId = uniq("matter")
    await seedMatter(caller, matterId, "confidential")
    const item = await logEvidence(caller, {
      matterId,
      item: "map",
      source: "survey",
      receiptDate: "2026-05-01",
      custodian: "clerk A",
      classification: "internal",
    })
    expect(item.classification).toBe("confidential")
  })

  it("export is deterministic, ordered, and contains every hash", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    const item = await logEvidence(caller, {
      matterId,
      item: "letter",
      source: "opponent",
      receiptDate: "2026-05-02",
      custodian: "clerk A",
      classification: "internal",
    })
    await addCustodyEvent(caller, { evidenceId: item.id, kind: "receipt", note: "opened" })
    await addCustodyEvent(caller, { evidenceId: item.id, kind: "annotation", note: "page 2 marked" })
    await addCustodyEvent(caller, { evidenceId: item.id, kind: "transfer", note: "to the safe", custodian: "partner" })
    const first = await exportEvidenceLog(caller, item.id)
    const second = await exportEvidenceLog(caller, item.id)
    expect(Buffer.from(first.json, "utf8").equals(Buffer.from(second.json, "utf8"))).toBe(true)
    expect(Buffer.from(first.text, "utf8").equals(Buffer.from(second.text, "utf8"))).toBe(true)
    const trail = await getCustodyTrail(caller, item.id)
    const parsed = JSON.parse(first.json) as { events: { seq: number; hash: string }[] }
    expect(parsed.events.map((event) => event.seq)).toEqual(trail.map((event) => event.seq))
    for (const event of trail) {
      expect(first.json).toContain(event.hash)
      expect(first.text).toContain(event.hash)
    }
    expect((await getEvidenceRegister(caller, matterId)).map((row) => row.id)).toContain(item.id)
  })

  it("a stored evidence row without firmId is not served", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    const item = await logEvidence(caller, {
      matterId,
      item: "bundle",
      source: "client",
      receiptDate: "2026-06-03",
      custodian: "clerk A",
      classification: "internal",
    })
    const stored = (await adminDb().collection(EVIDENCE_ITEMS).doc(item.id).get()).data()
    if (!stored) throw new Error("missing evidence row")
    const { firmId: _firmId, ...withoutFirm } = stored
    await adminDb().collection(EVIDENCE_ITEMS).doc(item.id).set(withoutFirm)
    await expect(getEvidenceItem(caller, item.id)).rejects.toMatchObject({ code: "not_found" })
  })

  it("an intern may read and may not author", async () => {
    process.env[FLAG] = "true"
    const partner = actor()
    const intern = actor({ firmId: partner.firmId, role: "intern", clearanceLevel: "internal" })
    const matterId = uniq("matter")
    await seedMatter(partner, matterId, "internal")
    await adminDb().collection("matter_members").doc(`${matterId}_${intern.uid}`).set({
      firmId: partner.firmId,
      matterId,
      userId: intern.uid,
    })
    const item = await logEvidence(partner, {
      matterId,
      item: "notice",
      source: "court",
      receiptDate: "2026-06-01",
      custodian: "clerk A",
      classification: "internal",
    })
    await addCustodyEvent(partner, { evidenceId: item.id, kind: "receipt", note: "filed" })
    expect((await getCustodyTrail(intern, item.id)).map((event) => event.seq)).toEqual([1])
    await expect(
      logEvidence(intern, {
        matterId,
        item: "other",
        source: "x",
        receiptDate: "2026-06-02",
        custodian: "intern",
        classification: "internal",
      })
    ).rejects.toMatchObject({ code: "not_author" })
    await expect(addCustodyEvent(intern, { evidenceId: item.id, kind: "annotation", note: "no" })).rejects.toMatchObject({
      code: "not_author",
    })
  })
})

async function reload(event: { id: string }): Promise<Record<string, unknown>> {
  const data = (await adminDb().collection(CUSTODY_EVENTS).doc(event.id).get()).data()
  if (!data) throw new Error("missing event")
  return data
}
