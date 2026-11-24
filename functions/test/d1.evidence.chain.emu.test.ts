import { afterEach, describe, expect, it, vi } from "vitest"
import { adminDb } from "../src/admin"
import { addCustodyEvent, getCustodyTrail, verifyCustodyChain } from "../src/d1/evidence/custody"
import { exportEvidenceLog } from "../src/d1/evidence/export"
import { getEvidenceItem, getEvidenceRegister, linkEvidenceToDocument, logEvidence } from "../src/d1/evidence/register"
import { EVIDENCE_ITEMS, CUSTODY_EVENTS, type EvidenceActor } from "../src/d1/evidence/types"
import { MATTER_TOMBSTONES } from "@/platform/retention/tombstone"
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

/**
 * The first logEvidence transaction commits, then the answer is lost as already-exists.
 * `reenter` lets the retry run the writer again. `blind` throws on every later attempt
 * before the writer runs. `poison` and `drop-genesis` change the committed row first.
 */
function lostCommit(
  db: ReturnType<typeof adminDb>,
  mode: "reenter" | "blind" | "poison" | "drop-genesis",
  code: number | string
): { count: number; restore: () => void } {
  const real = db.runTransaction.bind(db)
  const state = { count: 0 }
  const spy = vi.spyOn(db, "runTransaction").mockImplementation((async (fn: (tx: unknown) => Promise<unknown>, opts?: { maxAttempts?: number }) => {
    state.count += 1
    if (state.count > 1 && mode === "blind") {
      throw Object.assign(new Error("6 ALREADY_EXISTS: document already exists"), { code })
    }
    const result = await real(fn, opts)
    if (state.count === 1 && result && typeof result === "object" && "headerHash" in result && "id" in result) {
      const id = (result as { id: string }).id
      if (mode === "poison") await db.collection(EVIDENCE_ITEMS).doc(id).update({ item: "forged-body" })
      if (mode === "drop-genesis") await db.collection(CUSTODY_EVENTS).doc(`${id}_0`).delete()
      throw Object.assign(new Error("6 ALREADY_EXISTS: document already exists"), { code })
    }
    return result
  }) as typeof db.runTransaction)
  return {
    get count() {
      return state.count
    },
    restore: () => spy.mockRestore(),
  }
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
    expect(trail.events.map((event) => event.seq)).toEqual([1, 2])
    expect(new Set(trail.events.map((event) => event.hash)).size).toBe(2)
    expect(trail.events[1]?.prevHash).toBe(trail.events[0]?.hash)
    expect(trail.events[0]?.prevHash).toBe(trail.genesis?.hash)
    expect(trail.genesis?.prevHash).toBe("")
    expect(trail.verdict).toEqual({ ok: true, eventCount: 2 })
    expect(trail.events.every((event) => event.firmId === caller.firmId)).toBe(true)
    expect(trail.genesis?.firmId).toBe(caller.firmId)
    expect((await getEvidenceItem(caller, item.id)).firmId).toBe(caller.firmId)
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: true, eventCount: 2 })
    const db = adminDb()
    expect((await db.collection(EVIDENCE_ITEMS).doc(item.id).get()).exists).toBe(true)
    for (const event of [...trail.events, trail.genesis]) {
      if (!event) throw new Error("missing genesis")
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
    expect(trail.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5])
    for (let i = 1; i < trail.events.length; i++) expect(trail.events[i]?.prevHash).toBe(trail.events[i - 1]?.hash)
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
    const parsed = JSON.parse(first.json) as {
      events: { seq: number; hash: string }[]
      genesis: { hash: string; evidenceId: string; actorId: string; at: string; custodian: string; note: string }
    }
    expect(parsed.events.map((event) => event.seq)).toEqual(trail.events.map((event) => event.seq))
    expect(parsed.genesis.evidenceId).toBe(item.id)
    expect(parsed.genesis.actorId).toBe(caller.uid)
    expect(parsed.genesis.at).toBe(item.createdAt)
    expect(parsed.genesis.custodian).toBe("clerk A")
    expect(parsed.genesis.note).toBe("")
    expect(first.json).toContain(trail.genesis?.hash)
    expect(first.text).toContain(trail.genesis?.hash)
    expect(first.text).toContain(`actorId: ${caller.uid}`)
    for (const event of trail.events) {
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
    expect((await getCustodyTrail(intern, item.id)).events.map((event) => event.seq)).toEqual([1])
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

  it("a deleted tail fails verify at that seq and the next append does not reuse it", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    const item = await logEvidence(caller, {
      matterId,
      item: "cassette",
      source: "search",
      receiptDate: "2026-07-01",
      custodian: "clerk A",
      classification: "internal",
    })
    await addCustodyEvent(caller, { evidenceId: item.id, kind: "receipt", note: "bagged" })
    await addCustodyEvent(caller, { evidenceId: item.id, kind: "handling", note: "logged" })
    const db = adminDb()
    const before = (await db.collection(EVIDENCE_ITEMS).doc(item.id).get()).data()
    if (!before) throw new Error("missing evidence row")
    await db.collection(EVIDENCE_ITEMS).doc(item.id).update({ lastHash: item.headerHash })
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: false, brokenSeq: 2, reason: "hash" })
    await db.collection(EVIDENCE_ITEMS).doc(item.id).update({ lastHash: before.lastHash })
    await db.collection(CUSTODY_EVENTS).doc(`${item.id}_2`).delete()
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: false, brokenSeq: 2, reason: "gap" })
    await expect(addCustodyEvent(caller, { evidenceId: item.id, kind: "annotation", note: "would reuse seq 2" })).rejects.toMatchObject({
      code: "chain_broken",
    })
    expect((await db.collection(EVIDENCE_ITEMS).doc(item.id).get()).data()?.eventCount).toBe(2)
    expect((await db.collection(CUSTODY_EVENTS).doc(`${item.id}_2`).get()).exists).toBe(false)
    expect((await db.collection(CUSTODY_EVENTS).doc(`${item.id}_3`).get()).exists).toBe(false)
  })

  it("a malformed event stays in the verdict and the export is refused", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    const item = await logEvidence(caller, {
      matterId,
      item: "disk",
      source: "client",
      receiptDate: "2026-07-02",
      custodian: "clerk A",
      classification: "internal",
    })
    await addCustodyEvent(caller, { evidenceId: item.id, kind: "receipt", note: "received" })
    await addCustodyEvent(caller, { evidenceId: item.id, kind: "condition", note: "intact" })
    await adminDb().collection(CUSTODY_EVENTS).doc(`${item.id}_2`).update({ kind: "forged" })
    const trail = await getCustodyTrail(caller, item.id)
    expect(trail.events.map((event) => event.seq)).toEqual([1])
    expect(trail.malformed).toEqual([{ id: `${item.id}_2`, seq: 2 }])
    expect(trail.verdict).toEqual({ ok: false, brokenSeq: 2, reason: "malformed" })
    await expect(exportEvidenceLog(caller, item.id)).rejects.toMatchObject({
      code: "chain_broken",
      verdict: { ok: false, brokenSeq: 2, reason: "malformed" },
    })
  })

  it("an export taken while an append commits is one snapshot", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    const item = await logEvidence(caller, {
      matterId,
      item: "bundle",
      source: "chambers",
      receiptDate: "2026-07-03",
      custodian: "clerk A",
      classification: "internal",
    })
    await addCustodyEvent(caller, { evidenceId: item.id, kind: "receipt", note: "opened" })
    for (let n = 0; n < 12; n++) {
      const [log] = await Promise.all([
        exportEvidenceLog(caller, item.id),
        addCustodyEvent(caller, { evidenceId: item.id, kind: "handling", note: `move ${n}` }),
      ])
      const parsed = JSON.parse(log.json) as {
        evidence: { eventCount: number; lastHash: string; custodian: string; classification: string; item: string; headerHash: string }
        genesis: { hash: string; item: string }
        events: { seq: number; hash: string; custodian: string; classification: string }[]
      }
      const tip = parsed.events[parsed.events.length - 1]
      expect(parsed.evidence.eventCount).toBe(parsed.events.length)
      expect(parsed.events.map((event) => event.seq)).toEqual(parsed.events.map((_, index) => index + 1))
      expect(parsed.evidence.lastHash).toBe(tip?.hash)
      expect(parsed.evidence.custodian).toBe(tip?.custodian)
      expect(parsed.evidence.classification).toBe(tip?.classification)
      expect(parsed.evidence.item).toBe(parsed.genesis.item)
      expect(parsed.evidence.headerHash).toBe(parsed.genesis.hash)
      expect(log.verdict).toEqual({ ok: true, eventCount: parsed.evidence.eventCount })
    }
  })

  it("a direct edit of a bound header field fails verify", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    const item = await logEvidence(caller, {
      matterId,
      item: "watch",
      source: "complainant",
      receiptDate: "2026-07-04",
      custodian: "clerk A",
      classification: "internal",
    })
    await addCustodyEvent(caller, { evidenceId: item.id, kind: "receipt", note: "sealed" })
    const db = adminDb()
    await db.collection(EVIDENCE_ITEMS).doc(item.id).update({ item: "substituted exhibit" })
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: false, brokenSeq: 0, reason: "header" })
    await db.collection(EVIDENCE_ITEMS).doc(item.id).update({ item: "watch", classification: "public" })
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: false, brokenSeq: 0, reason: "header" })
    await db.collection(EVIDENCE_ITEMS).doc(item.id).update({ classification: "internal" })
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: true, eventCount: 1 })
  })

  it("a same-firm author who is not a member is refused", async () => {
    process.env[FLAG] = "true"
    const owner = actor()
    const outsider = actor({ firmId: owner.firmId, role: "associate" })
    const matterId = uniq("matter")
    await seedMatter(owner, matterId)
    await expect(
      logEvidence(outsider, {
        matterId,
        item: "bundle",
        source: "desk",
        receiptDate: "2026-08-01",
        custodian: "associate",
        classification: "internal",
      })
    ).rejects.toMatchObject({ code: "not_member" })
  })

  it("a tombstoned matter is refused", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    const item = await logEvidence(caller, {
      matterId,
      item: "file",
      source: "client",
      receiptDate: "2026-08-02",
      custodian: "clerk A",
      classification: "internal",
    })
    await adminDb().collection(MATTER_TOMBSTONES).doc(matterId).set({ firmId: caller.firmId, matterId })
    await expect(getEvidenceItem(caller, item.id)).rejects.toMatchObject({ code: "matter_deleted" })
    await expect(
      logEvidence(caller, {
        matterId,
        item: "another",
        source: "client",
        receiptDate: "2026-08-03",
        custodian: "clerk A",
        classification: "internal",
      })
    ).rejects.toMatchObject({ code: "matter_deleted" })
  })

  it("a matter filed under another firm is not found", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    await adminDb().collection("matters").doc(matterId).update({ firmId: uniq("firm") })
    await expect(
      logEvidence(caller, {
        matterId,
        item: "file",
        source: "client",
        receiptDate: "2026-08-04",
        custodian: "clerk A",
        classification: "internal",
      })
    ).rejects.toMatchObject({ code: "not_found" })
  })

  it("an item above the caller's clearance is refused even when the matter is not", async () => {
    process.env[FLAG] = "true"
    const partner = actor()
    const reader = actor({ firmId: partner.firmId, role: "associate", clearanceLevel: "internal" })
    const matterId = uniq("matter")
    await seedMatter(partner, matterId, "internal")
    await adminDb().collection("matter_members").doc(`${matterId}_${reader.uid}`).set({
      firmId: partner.firmId,
      matterId,
      userId: reader.uid,
    })
    const visible = await logEvidence(partner, {
      matterId,
      item: "letter",
      source: "court",
      receiptDate: "2026-08-05",
      custodian: "clerk A",
      classification: "internal",
    })
    const hidden = await logEvidence(partner, {
      matterId,
      item: "opinion",
      source: "counsel",
      receiptDate: "2026-08-06",
      custodian: "partner",
      classification: "internal",
    })
    await adminDb().collection(EVIDENCE_ITEMS).doc(hidden.id).update({ classification: "privileged" })
    await expect(getEvidenceItem(reader, hidden.id)).rejects.toMatchObject({ code: "clearance" })
    const register = await getEvidenceRegister(reader, matterId)
    expect(register.map((row) => row.id)).toEqual([visible.id])
    expect(register.some((row) => row.id === hidden.id)).toBe(false)
  })

  it("a second document link is already_linked and the link event keeps the previous hash", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    const item = await logEvidence(caller, {
      matterId,
      item: "deed",
      source: "registry",
      receiptDate: "2026-08-07",
      custodian: "clerk A",
      classification: "internal",
    })
    const firstDoc = uniq("doc")
    const secondDoc = uniq("doc")
    await adminDb().collection("documents").doc(firstDoc).set(documentData(caller, matterId, "internal"))
    await adminDb().collection("documents").doc(secondDoc).set(documentData(caller, matterId, "internal"))
    const linked = await linkEvidenceToDocument(caller, { evidenceId: item.id, documentId: firstDoc })
    expect(linked.documentId).toBe(firstDoc)
    const again = await linkEvidenceToDocument(caller, { evidenceId: item.id, documentId: firstDoc })
    expect(again.documentId).toBe(firstDoc)
    await expect(linkEvidenceToDocument(caller, { evidenceId: item.id, documentId: secondDoc })).rejects.toMatchObject({
      code: "already_linked",
    })
    const trail = await getCustodyTrail(caller, item.id)
    expect(trail.events[0]?.kind).toBe("link")
    expect(trail.events[0]?.prevHash).toBe(trail.genesis?.hash)
    expect(trail.events[0]?.documentId).toBe(firstDoc)
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: true, eventCount: 1 })
    const stored = await getEvidenceItem(caller, item.id)
    expect(stored.documentId).toBe(firstDoc)
    expect(stored.createdBy).toBe(caller.uid)
    expect(stored.createdAt).toBe(item.createdAt)
  })

  it("a transfer without a custodian is invalid and a transfer moves the header custodian", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    const item = await logEvidence(caller, {
      matterId,
      item: "seal",
      source: "court",
      receiptDate: "2026-08-08",
      custodian: "clerk A",
      classification: "internal",
    })
    await expect(addCustodyEvent(caller, { evidenceId: item.id, kind: "transfer", note: "handed over" })).rejects.toMatchObject({
      code: "invalid_input",
    })
    await addCustodyEvent(caller, { evidenceId: item.id, kind: "transfer", note: "handed over", custodian: "partner" })
    const stored = await getEvidenceItem(caller, item.id)
    expect(stored.custodian).toBe("partner")
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: true, eventCount: 1 })
  })

  it("a second genesis or a second copy of the same seq breaks the chain", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    const item = await logEvidence(caller, {
      matterId,
      item: "disk",
      source: "client",
      receiptDate: "2026-08-09",
      custodian: "clerk A",
      classification: "internal",
    })
    const db = adminDb()
    const genesis = (await db.collection(CUSTODY_EVENTS).doc(`${item.id}_0`).get()).data()
    if (!genesis) throw new Error("missing genesis")
    await db.collection(CUSTODY_EVENTS).doc(`${item.id}_0b`).set({ ...genesis, note: "second genesis" })
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: false, brokenSeq: 0, reason: "duplicate" })
    await db.collection(CUSTODY_EVENTS).doc(`${item.id}_0b`).delete()
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: true, eventCount: 0 })
    await addCustodyEvent(caller, { evidenceId: item.id, kind: "receipt", note: "logged" })
    const seq1 = (await db.collection(CUSTODY_EVENTS).doc(`${item.id}_1`).get()).data()
    if (!seq1) throw new Error("missing seq 1")
    await db.collection(CUSTODY_EVENTS).doc(`${item.id}_1b`).set(seq1)
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: false, brokenSeq: 1, reason: "duplicate" })
    await db.collection(CUSTODY_EVENTS).doc(`${item.id}_1b`).delete()
    const next = { ...seq1, seq: 2 }
    await db.collection(CUSTODY_EVENTS).doc(`${item.id}_2`).set(next)
    await expect(addCustodyEvent(caller, { evidenceId: item.id, kind: "annotation", note: "would reuse seq 2" })).rejects.toMatchObject({
      code: "chain_broken",
    })
    expect((await db.collection(EVIDENCE_ITEMS).doc(item.id).get()).data()?.eventCount).toBe(1)
  })

  it("editing createdBy, createdAt, documentId, or headerHash fails verify", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    const item = await logEvidence(caller, {
      matterId,
      item: "photo",
      source: "site",
      receiptDate: "2026-08-10",
      custodian: "clerk A",
      classification: "internal",
    })
    const db = adminDb()
    await db.collection(EVIDENCE_ITEMS).doc(item.id).update({ createdBy: "other-user" })
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: false, brokenSeq: 0, reason: "header" })
    await db.collection(EVIDENCE_ITEMS).doc(item.id).update({ createdBy: caller.uid, createdAt: "2020-01-01T00:00:00.000Z" })
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: false, brokenSeq: 0, reason: "header" })
    await db.collection(EVIDENCE_ITEMS).doc(item.id).update({ createdAt: item.createdAt, documentId: uniq("doc") })
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: false, brokenSeq: 0, reason: "header" })
    await db.collection(EVIDENCE_ITEMS).doc(item.id).update({ documentId: null, headerHash: "ab".repeat(32) })
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: false, brokenSeq: 0, reason: "header" })
    await db.collection(EVIDENCE_ITEMS).doc(item.id).update({ headerHash: item.headerHash })
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: true, eventCount: 0 })
  })

  it("a lost logEvidence commit replays the written item and does not open a second one", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    const db = adminDb()
    const attempts = lostCommit(db, "reenter", 6)
    const input = {
      matterId,
      item: "seized handset",
      source: "recovery memo",
      receiptDate: "2026-09-01",
      custodian: "clerk A",
      classification: "internal" as const,
    }
    let item: Awaited<ReturnType<typeof logEvidence>>
    try {
      item = await logEvidence(caller, input)
    } finally {
      attempts.restore()
    }
    expect(attempts.count).toBe(2)
    expect(item.eventCount).toBe(0)
    expect(item.item).toBe("seized handset")
    const rows = await db.collection(EVIDENCE_ITEMS).where("matterId", "==", matterId).get()
    expect(rows.docs.map((doc) => doc.id)).toEqual([item.id])
    const events = await db.collection(CUSTODY_EVENTS).where("evidenceId", "==", item.id).get()
    expect(events.docs.map((doc) => doc.id)).toEqual([`${item.id}_0`])
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: true, eventCount: 0 })
    const second = await logEvidence(caller, { ...input, item: "second handset" })
    expect(second.id).not.toBe(item.id)
    expect((await db.collection(EVIDENCE_ITEMS).where("matterId", "==", matterId).get()).size).toBe(2)
  })

  it("a lost logEvidence commit is returned when every retry throws already-exists", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    const db = adminDb()
    const attempts = lostCommit(db, "blind", "already-exists")
    let item: Awaited<ReturnType<typeof logEvidence>>
    try {
      item = await logEvidence(caller, {
        matterId,
        item: "bundle",
        source: "client",
        receiptDate: "2026-09-02",
        custodian: "clerk A",
        classification: "internal",
      })
    } finally {
      attempts.restore()
    }
    expect(attempts.count).toBe(8)
    expect(item.item).toBe("bundle")
    expect(item.eventCount).toBe(0)
    expect((await db.collection(EVIDENCE_ITEMS).where("matterId", "==", matterId).get()).size).toBe(1)
    expect((await db.collection(CUSTODY_EVENTS).where("evidenceId", "==", item.id).get()).size).toBe(1)
    expect(await verifyCustodyChain(caller, item.id)).toEqual({ ok: true, eventCount: 0 })
  })

  it("a lost logEvidence commit whose stored body differs is conflict and adds nothing", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    const db = adminDb()
    const attempts = lostCommit(db, "poison", 6)
    try {
      await expect(
        logEvidence(caller, {
          matterId,
          item: "original",
          source: "desk",
          receiptDate: "2026-09-03",
          custodian: "clerk A",
          classification: "internal",
        })
      ).rejects.toMatchObject({ name: "EvidenceError", code: "conflict" })
    } finally {
      attempts.restore()
    }
    expect(attempts.count).toBe(2)
    const rows = await db.collection(EVIDENCE_ITEMS).where("matterId", "==", matterId).get()
    expect(rows.size).toBe(1)
    expect(rows.docs[0]?.get("item")).toBe("forged-body")
    const evidenceId = rows.docs[0]?.id
    const events = await db.collection(CUSTODY_EVENTS).where("evidenceId", "==", evidenceId).get()
    expect(events.size).toBe(1)
    expect(events.docs[0]?.get("item")).toBe("original")
  })

  it("a lost logEvidence commit with no genesis is conflict and does not append one", async () => {
    process.env[FLAG] = "true"
    const caller = actor()
    const matterId = uniq("matter")
    await seedMatter(caller, matterId)
    const db = adminDb()
    const attempts = lostCommit(db, "drop-genesis", 6)
    try {
      await expect(
        logEvidence(caller, {
          matterId,
          item: "tape",
          source: "interview",
          receiptDate: "2026-09-04",
          custodian: "clerk A",
          classification: "internal",
        })
      ).rejects.toMatchObject({ name: "EvidenceError", code: "conflict" })
    } finally {
      attempts.restore()
    }
    expect(attempts.count).toBe(2)
    const rows = await db.collection(EVIDENCE_ITEMS).where("matterId", "==", matterId).get()
    expect(rows.size).toBe(1)
    const evidenceId = rows.docs[0]?.id ?? ""
    expect((await db.collection(CUSTODY_EVENTS).where("evidenceId", "==", evidenceId).get()).size).toBe(0)
    expect((await db.collection(CUSTODY_EVENTS).doc(`${evidenceId}_0`).get()).exists).toBe(false)
  })
})

async function reload(event: { id: string }): Promise<Record<string, unknown>> {
  const data = (await adminDb().collection(CUSTODY_EVENTS).doc(event.id).get()).data()
  if (!data) throw new Error("missing event")
  return data
}
