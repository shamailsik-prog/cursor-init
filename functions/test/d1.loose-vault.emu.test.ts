import path from "node:path"
import { readFileSync, readdirSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FieldValue, Timestamp } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { CLASSIFICATION_RANKS } from "@/platform/p1/types"
import { adminDb } from "../src/admin"
import type { Caller } from "../src/p5/auth"
import { HttpError } from "../src/http/errors"
import { acknowledgeLooseHold, isLooseUploadBlocked, looseVaultEscalations } from "../src/d1/looseVault/escalation"
import { LOOSE_VAULT_PAGE } from "../src/d1/looseVault/flag"
import { convertToMatter } from "../src/d1/looseVault/convert"
import { listHeldFiles, searchLooseFiles } from "../src/d1/looseVault/search"
import { tagLooseFile } from "../src/d1/looseVault/tags"
import { EMULATORS, uniq } from "./emu"
import { registryRecorder } from "./setup/registryWriteRecorder"

/**
 * L4.5 loose vault, as overridden by Erratum E-18. Ages are hardcoded milliseconds
 * (not the module's constant) so a wrong threshold fails here.
 * 29d23h = 719h, 30d00h = 720h.
 */
const FLAG = "SIKANDER_FLAG_L4_LOOSE_VAULT"
const HOUR = 60 * 60 * 1000
const AGE_29D23H = 29 * 24 * HOUR + 23 * HOUR
const AGE_30D = 30 * 24 * HOUR
const CROSS_FIRM_TAG = "cross-firm-sentinel-tag"
const CROSS_MATTER_TITLE = "cross-firm-matter-title-sentinel"

let savedFlag: string | undefined

beforeEach(() => {
  savedFlag = process.env[FLAG]
  process.env[FLAG] = "true"
})

afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG]
  else process.env[FLAG] = savedFlag
})

function user(firmId: string, role: Caller["role"], clearanceLevel: Classification = "confidential", uid = uniq(role)): Caller {
  return { uid, firmId, role, clearanceLevel }
}

function looseRow(firmId: string, uploadedBy: string, extra: Record<string, unknown> = {}) {
  return {
    firmId,
    matterId: null,
    contentHash: "ab".repeat(32),
    sourceChannel: "bulk",
    classification: "confidential",
    storagePath: `fs://${firmId}/loose/${uploadedBy}`,
    isImmutable: true,
    byteSize: 12,
    mimeType: "application/pdf",
    objectVersion: 1,
    uploadedBy,
    objectBytesStatus: "available",
    createdAt: Timestamp.fromMillis(0),
    ...extra,
  }
}

async function seedDoc(firmId: string, uploadedBy: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = uniq("doc")
  await adminDb().collection("documents").doc(id).set(looseRow(firmId, uploadedBy, extra))
  return id
}

async function seedMatter(firmId: string, memberUid: string | null, classification: Classification = "confidential", title = "Recovery"): Promise<string> {
  const id = uniq("matter")
  await adminDb().collection("matters").doc(id).set({
    firmId,
    clientId: "client-1",
    title,
    classification,
    status: "live",
  })
  if (memberUid) {
    await adminDb().collection("matter_members").doc(`${id}_${memberUid}`).set({ firmId, matterId: id, userId: memberUid })
  }
  return id
}

const docRef = (id: string) => adminDb().collection("documents").doc(id)

async function catchHttp(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError)
    return err as HttpError
  }
  throw new Error("expected HttpError")
}

function publicText(err: HttpError): string {
  return JSON.stringify({ message: err.message, code: err.code, status: err.status })
}

type Op = () => Promise<unknown>

function actorOps(actor: Caller, docId: string, matterId: string, firmId: string): Op[] {
  const now = new Date(AGE_30D)
  return [
    () => tagLooseFile(actor, docId, { clientName: "Khan" }),
    () => searchLooseFiles(actor, "khan"),
    () => listHeldFiles(actor),
    () => convertToMatter(actor, docId, matterId),
    () => looseVaultEscalations(actor, firmId, now),
    () => acknowledgeLooseHold(actor, docId, now),
  ]
}

async function expectRefuse(op: Op, status: number, code: string): Promise<void> {
  const reads = await registryRecorder.readsDuring(async () => {
    await expect(op()).rejects.toMatchObject({ status, code })
  })
  expect([...reads]).toEqual([])
}

describe.skipIf(!EMULATORS)("loose vault (emulator)", () => {
  it("the read recorder sees a document read when the vault is on, so an empty read set is meaningful", async () => {
    const firmId = uniq("firm")
    const clerk = user(firmId, "clerk")
    const reads = await registryRecorder.readsDuring(async () => {
      expect(await listHeldFiles(clerk)).toEqual({ items: [] })
    })
    expect(reads.has("documents")).toBe(true)
  })

  it("refuses associate, intern, accounts and client, and a clerk or partner below confidential, before any read", async () => {
    const firmId = uniq("firm")
    const docId = await seedDoc(firmId, "holder")
    const matterId = await seedMatter(firmId, null)
    const denied: Caller[] = [
      user(firmId, "associate", "privileged-restricted"),
      user(firmId, "intern", "privileged-restricted"),
      user(firmId, "accounts", "privileged-restricted"),
      user(firmId, "client", "privileged-restricted"),
      user(firmId, "clerk", "internal"),
      user(firmId, "clerk", "public"),
      user(firmId, "partner", "internal"),
    ]
    for (const actor of denied) {
      for (const op of actorOps(actor, docId, matterId, firmId)) {
        await expectRefuse(op, 403, "loose_vault_denied")
      }
    }
    expect((await docRef(docId).get()).data()?.matterId).toBeNull()
  })

  it("flag off refuses every op, including the upload-block predicate, before any read", async () => {
    const firmId = uniq("firm")
    const clerk = user(firmId, "clerk", "privileged-restricted")
    const docId = await seedDoc(firmId, clerk.uid, { looseTags: { clientName: "secret-while-off", reference: null, phone: null, keys: [] } })
    const matterId = await seedMatter(firmId, clerk.uid)
    delete process.env[FLAG]
    for (const op of actorOps(clerk, docId, matterId, firmId)) {
      await expectRefuse(op, 404, "feature_disabled")
    }
    await expectRefuse(() => isLooseUploadBlocked(firmId, clerk.uid, new Date(AGE_30D)), 404, "feature_disabled")
    process.env[FLAG] = "yes"
    await expectRefuse(() => listHeldFiles(clerk), 404, "feature_disabled")
    expect((await docRef(docId).get()).data()?.looseTags).toEqual({ clientName: "secret-while-off", reference: null, phone: null, keys: [] })
  })

  it("tags only a loose row, normalises client, reference, phone and free key, and audits", async () => {
    const firmId = uniq("firm")
    const clerk = user(firmId, "clerk")
    const docId = await seedDoc(firmId, clerk.uid)
    const tagged = await tagLooseFile(clerk, docId, {
      clientName: "  Ahmad   KHAN ",
      reference: " C.P.  12/2026 ",
      phone: "0300 1112223",
      keys: ["Court File", "court file", "  Bundle A "],
    })
    expect(tagged.looseTags).toEqual({
      clientName: "ahmad khan",
      reference: "c.p. 12/2026",
      phone: "+923001112223",
      keys: ["bundle a", "court file"],
    })
    const phoneOnly = await tagLooseFile(clerk, docId, { phone: "+92 300 1112223" })
    expect(phoneOnly.looseTags.clientName).toBe("ahmad khan")
    expect(phoneOnly.looseTags.phone).toBe("+923001112223")

    const found = await searchLooseFiles(clerk, "KHAN")
    expect(found.items.map((row) => row.docId)).toEqual([docId])
    expect(await searchLooseFiles(clerk, "0300 1112223")).toMatchObject({ items: [expect.objectContaining({ docId })] })
    expect(await searchLooseFiles(clerk, "C.P. 12")).toMatchObject({ items: [expect.objectContaining({ docId })] })
    expect(await searchLooseFiles(clerk, "BUNDLE")).toMatchObject({ items: [expect.objectContaining({ docId })] })
    expect((await searchLooseFiles(clerk, "no-such-tag")).items).toEqual([])

    const held = await listHeldFiles(clerk)
    expect(held.items).toEqual([
      expect.objectContaining({ docId, holderId: clerk.uid, classification: "confidential", looseTags: phoneOnly.looseTags }),
    ])
    expect(held.items[0]).not.toHaveProperty("storagePath")

    const audit = (await adminDb().collection("audit_log").where("target", "==", `documents/${docId}`).get()).docs.map((d) => d.data())
    expect(audit.filter((row) => row.action === "loose_vault.tag").length).toBeGreaterThanOrEqual(2)
    expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: "loose_vault.tag", decision: "allow", actorId: clerk.uid, firmId, classification: "confidential" })]))

    await expect(tagLooseFile(clerk, docId, { phone: "not-a-phone" })).rejects.toMatchObject({ status: 400, code: "invalid_phone" })
    expect((await docRef(docId).get()).data()?.looseTags.phone).toBe("+923001112223")
  })

  it("refuses to tag a matter-bound row and does not show it as held", async () => {
    const firmId = uniq("firm")
    const clerk = user(firmId, "clerk")
    const matterId = await seedMatter(firmId, clerk.uid)
    const bound = await seedDoc(firmId, clerk.uid, { matterId })
    await expect(tagLooseFile(clerk, bound, { clientName: "Khan" })).rejects.toMatchObject({ status: 409, code: "not_loose" })
    expect((await docRef(bound).get()).data()?.looseTags).toBeUndefined()
    const outsider = user(firmId, "clerk")
    await expect(tagLooseFile(outsider, bound, { clientName: "Khan" })).rejects.toMatchObject({ status: 404, code: "not_found" })
    expect((await listHeldFiles(clerk)).items.map((row) => row.docId)).not.toContain(bound)
  })

  it("converts loose to matter once, refuses a second matter, and cannot move a matter back to loose", async () => {
    const firmId = uniq("firm")
    const partner = user(firmId, "partner", "privileged-restricted")
    const matterA = await seedMatter(firmId, partner.uid, "internal")
    const matterB = await seedMatter(firmId, partner.uid, "internal")
    const docId = await seedDoc(firmId, partner.uid, { classification: "privileged", looseTags: { clientName: "keep", reference: null, phone: null, keys: [] } })
    const before = (await docRef(docId).get()).data()
    const first = await convertToMatter(partner, docId, matterA)
    expect(first).toMatchObject({ docId, matterId: matterA, alreadyConverted: false, classification: "privileged" })
    const after = (await docRef(docId).get()).data()
    expect(after?.matterId).toBe(matterA)
    expect(after?.classification).toBe("privileged")
    expect(CLASSIFICATION_RANKS.privileged).toBeGreaterThan(CLASSIFICATION_RANKS.internal)
    expect(after?.contentHash).toBe(before?.contentHash)
    expect(after?.storagePath).toBe(before?.storagePath)
    expect(after?.byteSize).toBe(before?.byteSize)
    expect(after?.uploadedBy).toBe(before?.uploadedBy)
    expect(after?.looseTags).toEqual(before?.looseTags)
    expect(after?.isImmutable).toBe(true)

    const again = await convertToMatter(partner, docId, matterA)
    expect(again.alreadyConverted).toBe(true)
    expect((await docRef(docId).get()).data()?.classification).toBe("privileged")
    expect((await docRef(docId).get()).data()?.matterId).toBe(matterA)

    await expect(convertToMatter(partner, docId, matterB)).rejects.toMatchObject({ status: 409, code: "convert_target_conflict" })
    expect((await docRef(docId).get()).data()?.matterId).toBe(matterA)
    expect((await docRef(docId).get()).data()?.classification).toBe("privileged")

    const stillLoose = await seedDoc(firmId, partner.uid)
    await expect(convertToMatter(partner, stillLoose, null as unknown as string)).rejects.toMatchObject({ status: 400, code: "invalid_query" })
    expect((await docRef(stillLoose).get()).data()?.matterId).toBeNull()

    const born = await seedDoc(firmId, partner.uid, { matterId: matterA, classification: "privileged" })
    await expect(convertToMatter(partner, born, matterB)).rejects.toMatchObject({ status: 409, code: "convert_target_conflict" })
    expect((await docRef(born).get()).data()?.matterId).toBe(matterA)
    expect((await docRef(born).get()).data()?.classification).toBe("privileged")

    const audit = (await adminDb().collection("audit_log").where("target", "==", `documents/${docId}`).get()).docs.map((d) => d.data())
    const converts = audit.filter((row) => row.action === "loose_vault.convert")
    expect(converts.map((row) => row.reason).sort()).toEqual(["already_converted", "ok"])
    expect(converts.every((row) => row.decision === "allow" && row.actorId === partner.uid)).toBe(true)
  })

  it("a same-firm non-member is refused and a caller below the matter label is refused, without moving the file", async () => {
    const firmId = uniq("firm")
    const owner = user(firmId, "partner")
    const outsider = user(firmId, "clerk")
    const matterId = await seedMatter(firmId, owner.uid, "privileged")
    const docId = await seedDoc(firmId, outsider.uid, { classification: "confidential" })
    await expect(convertToMatter(outsider, docId, matterId)).rejects.toMatchObject({ status: 403, code: "not_a_member" })
    const low = user(firmId, "clerk", "confidential")
    const lowMatter = await seedMatter(firmId, low.uid, "privileged")
    const lowDoc = await seedDoc(firmId, low.uid)
    await expect(convertToMatter(low, lowDoc, lowMatter)).rejects.toMatchObject({ status: 403, code: "exceeds_own_clearance" })
    expect((await docRef(docId).get()).data()?.matterId).toBeNull()
    expect((await docRef(lowDoc).get()).data()?.matterId).toBeNull()
  })

  it("a cross-firm document or matter is not found and the error carries no other-firm data", async () => {
    const firmId = uniq("firm")
    const otherFirm = uniq("firm")
    const clerk = user(firmId, "clerk", "privileged-restricted")
    const otherDoc = await seedDoc(otherFirm, "other-user", {
      classification: "internal",
      looseTags: { clientName: CROSS_FIRM_TAG, reference: null, phone: null, keys: [] },
    })
    const tagErr = await catchHttp(tagLooseFile(clerk, otherDoc, { clientName: "Local" }))
    expect(tagErr.status).toBe(404)
    expect(tagErr.code).toBe("not_found")
    expect(publicText(tagErr)).not.toContain(CROSS_FIRM_TAG)
    expect(publicText(tagErr)).not.toContain(otherFirm)
    expect((await docRef(otherDoc).get()).data()?.looseTags.clientName).toBe(CROSS_FIRM_TAG)

    const otherMatter = uniq("matter")
    await adminDb().collection("matters").doc(otherMatter).set({
      firmId: otherFirm,
      title: CROSS_MATTER_TITLE,
      classification: "internal",
      clientId: "secret-client",
    })
    const own = await seedDoc(firmId, clerk.uid)
    const convertErr = await catchHttp(convertToMatter(clerk, own, otherMatter))
    expect(convertErr.status).toBe(404)
    expect(convertErr.code).toBe("not_found")
    expect(publicText(convertErr)).not.toContain(CROSS_MATTER_TITLE)
    expect(publicText(convertErr)).not.toContain(otherFirm)
    expect(publicText(convertErr)).not.toContain("secret-client")
    expect((await docRef(own).get()).data()?.matterId).toBeNull()

    await seedDoc(otherFirm, "other-user", { looseTags: { clientName: CROSS_FIRM_TAG, reference: null, phone: null, keys: [] } })
    const listed = JSON.stringify(await listHeldFiles(clerk))
    const found = JSON.stringify(await searchLooseFiles(clerk, CROSS_FIRM_TAG))
    expect(listed).not.toContain(CROSS_FIRM_TAG)
    expect(found).not.toContain(CROSS_FIRM_TAG)
    expect(found).not.toContain(otherFirm)
  })

  it("escalates at 30d00h and not at 29d23h, and the query writes nothing", async () => {
    const firmId = uniq("firm")
    const clerk = user(firmId, "clerk")
    const young = await seedDoc(firmId, clerk.uid, { createdAt: Timestamp.fromMillis(0) })
    const old = await seedDoc(firmId, "other-holder", { createdAt: Timestamp.fromMillis(0) })
    const undated = await seedDoc(firmId, clerk.uid, { createdAt: null })
    const now29 = new Date(AGE_29D23H)
    const now30 = new Date(AGE_30D)
    const beforeYoung = (await docRef(young).get()).updateTime?.toMillis()
    const auditsBefore = (await adminDb().collection("audit_log").where("firmId", "==", firmId).get()).size

    const early = await looseVaultEscalations(clerk, firmId, now29)
    expect(early.items.map((row) => row.docId).sort()).toEqual([undated].sort())
    expect(early.items.find((row) => row.docId === young)).toBeUndefined()
    expect(early.items.find((row) => row.docId === old)).toBeUndefined()

    const due = await looseVaultEscalations(clerk, firmId, now30)
    const dueIds = due.items.map((row) => row.docId).sort()
    expect(dueIds).toEqual([old, undated, young].sort())
    expect(due.items.find((row) => row.docId === young)).toMatchObject({ holderId: clerk.uid, ageMs: AGE_30D, acknowledged: false })
    expect(due.items.find((row) => row.docId === old)).toMatchObject({ holderId: "other-holder", ageMs: AGE_30D })
    expect(due.items.find((row) => row.docId === undated)?.ageMs).toBeNull()

    expect((await docRef(young).get()).updateTime?.toMillis()).toBe(beforeYoung)
    expect((await adminDb().collection("audit_log").where("firmId", "==", firmId).get()).size).toBe(auditsBefore)

    const other = user(uniq("firm"), "partner")
    const reads = await registryRecorder.readsDuring(async () => {
      await expect(looseVaultEscalations(clerk, other.firmId, now30)).rejects.toMatchObject({ status: 404, code: "not_found" })
    })
    expect(reads.has("documents")).toBe(false)
  })

  it("blocks the uploader at 30d00h, not at 29d23h, not for a colleague, and not after convert or a partner acknowledgement", async () => {
    const firmId = uniq("firm")
    const clerk = user(firmId, "clerk", "confidential")
    const partner = user(firmId, "partner", "confidential")
    const colleague = user(firmId, "clerk", "confidential")
    const docId = await seedDoc(firmId, clerk.uid, { createdAt: Timestamp.fromMillis(0) })
    const now29 = new Date(AGE_29D23H)
    const now30 = new Date(AGE_30D)

    expect(await isLooseUploadBlocked(firmId, clerk.uid, now29)).toBe(false)
    expect(await isLooseUploadBlocked(firmId, clerk.uid, now30)).toBe(true)
    expect(await isLooseUploadBlocked(firmId, colleague.uid, now30)).toBe(false)

    const matterId = await seedMatter(firmId, clerk.uid, "confidential")
    await convertToMatter(clerk, docId, matterId)
    expect(await isLooseUploadBlocked(firmId, clerk.uid, now30)).toBe(false)
    expect((await looseVaultEscalations(partner, firmId, now30)).items.map((row) => row.docId)).not.toContain(docId)

    const held = await seedDoc(firmId, clerk.uid, { createdAt: Timestamp.fromMillis(0) })
    expect(await isLooseUploadBlocked(firmId, clerk.uid, now30)).toBe(true)
    await expectRefuse(() => acknowledgeLooseHold(clerk, held, now30), 403, "partner_only")
    expect(await isLooseUploadBlocked(firmId, clerk.uid, now30)).toBe(true)
    await acknowledgeLooseHold(partner, held, now30)
    expect(await isLooseUploadBlocked(firmId, clerk.uid, now30)).toBe(false)
    const row = (await docRef(held).get()).data()
    expect(row?.matterId).toBeNull()
    expect(row?.classification).toBe("confidential")
    expect(row?.loosePartnerAck).toMatchObject({ partnerId: partner.uid })
    const ackAudit = await adminDb().collection("audit_log").where("firmId", "==", firmId).get()
    expect(ackAudit.docs.map((entry) => entry.data())).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "loose_vault.acknowledge", actorId: partner.uid, target: `documents/${held}` })])
    )
    const escalated = await looseVaultEscalations(partner, firmId, now30)
    expect(escalated.items.find((item) => item.docId === held)).toMatchObject({ holderId: clerk.uid, acknowledged: true, ageMs: AGE_30D })

    const still = await seedDoc(firmId, clerk.uid, { createdAt: Timestamp.fromMillis(0) })
    expect(await isLooseUploadBlocked(firmId, clerk.uid, now30)).toBe(true)
    expect((await docRef(still).get()).exists).toBe(true)
  })

  it("a spoiled loose row stays overdue for the uploader and stays on the partner escalation list", async () => {
    const firmId = uniq("firm")
    const clerk = user(firmId, "clerk", "confidential")
    const partner = user(firmId, "partner", "confidential")
    const now30 = new Date(AGE_30D)
    const spoil: Record<string, unknown>[] = [
      { sourceChannel: "evil" },
      { byteSize: -1 },
      { mimeType: 1 },
      { objectVersion: 1.5 },
      { objectBytesStatus: "gone" },
    ]
    const ids: string[] = []
    for (const patch of spoil) {
      const id = await seedDoc(firmId, clerk.uid, { createdAt: Timestamp.fromMillis(0) })
      ids.push(id)
      expect(await isLooseUploadBlocked(firmId, clerk.uid, now30)).toBe(true)
      await adminDb().collection("documents").doc(id).update(patch)
    }
    expect(await isLooseUploadBlocked(firmId, clerk.uid, now30)).toBe(true)
    expect(await isLooseUploadBlocked(firmId, partner.uid, now30)).toBe(false)
    const listed = await looseVaultEscalations(partner, firmId, now30)
    for (const id of ids) {
      expect(listed.items.find((row) => row.docId === id)).toMatchObject({
        holderId: clerk.uid,
        acknowledged: false,
        malformed: true,
      })
    }
    expect(listed.items.every((row) => ids.includes(row.docId) && row.malformed)).toBe(true)
  })

  it("a partner acknowledgement of a malformed loose row lifts the block and keeps the row listed", async () => {
    const firmId = uniq("firm")
    const clerk = user(firmId, "clerk", "confidential")
    const partner = user(firmId, "partner", "confidential")
    const outsider = user(uniq("firm"), "partner", "privileged-restricted")
    const now30 = new Date(AGE_30D)
    const id = await seedDoc(firmId, clerk.uid, { createdAt: Timestamp.fromMillis(0), sourceChannel: "evil" })
    expect(await isLooseUploadBlocked(firmId, clerk.uid, now30)).toBe(true)
    await expectRefuse(() => acknowledgeLooseHold(clerk, id, now30), 403, "partner_only")
    await expect(acknowledgeLooseHold(outsider, id, now30)).rejects.toMatchObject({ status: 404, code: "not_found" })
    expect(await isLooseUploadBlocked(firmId, clerk.uid, now30)).toBe(true)
    await acknowledgeLooseHold(partner, id, now30)
    expect(await isLooseUploadBlocked(firmId, clerk.uid, now30)).toBe(false)
    const row = (await docRef(id).get()).data()
    expect(row?.sourceChannel).toBe("evil")
    expect(row?.matterId).toBeNull()
    expect(row?.classification).toBe("confidential")
    expect(row?.loosePartnerAck).toMatchObject({ partnerId: partner.uid })
    const listed = await looseVaultEscalations(partner, firmId, now30)
    expect(listed.items.find((item) => item.docId === id)).toMatchObject({
      holderId: clerk.uid,
      malformed: true,
      acknowledged: true,
    })
    await acknowledgeLooseHold(partner, id, now30)
    expect((await docRef(id).get()).data()?.loosePartnerAck.partnerId).toBe(partner.uid)
    const ackAudit = await adminDb().collection("audit_log").where("firmId", "==", firmId).get()
    expect(ackAudit.docs.map((entry) => entry.data())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "loose_vault.acknowledge", actorId: partner.uid, classification: "confidential", reason: "ok" }),
      ])
    )
  })

  it("a confidential clerk's escalations omit privileged, restricted and unlabelled malformed rows", async () => {
    const firmId = uniq("firm")
    const clerk = user(firmId, "clerk", "confidential")
    const lowPartner = user(firmId, "partner", "confidential")
    const partner = user(firmId, "partner", "privileged-restricted")
    const now30 = new Date(AGE_30D)
    const own = await seedDoc(firmId, clerk.uid, { sourceChannel: "evil", createdAt: Timestamp.fromMillis(0) })
    const privileged = await seedDoc(firmId, "partner-holder", { sourceChannel: "evil", classification: "privileged", createdAt: Timestamp.fromMillis(0) })
    const restricted = await seedDoc(firmId, "partner-holder", {
      sourceChannel: "evil",
      classification: "privileged-restricted",
      createdAt: Timestamp.fromMillis(0),
    })
    const unlabelled = await seedDoc(firmId, "partner-holder", { sourceChannel: "evil", createdAt: Timestamp.fromMillis(0) })
    await docRef(unlabelled).update({ classification: FieldValue.delete() })

    const clerkItems = await looseVaultEscalations(clerk, firmId, now30)
    expect(clerkItems.items.map((row) => row.docId)).toEqual([own])
    for (const hidden of [privileged, restricted, unlabelled]) {
      expect(clerkItems.items.map((row) => row.docId)).not.toContain(hidden)
    }
    const partnerItems = await looseVaultEscalations(partner, firmId, now30)
    expect(partnerItems.items.map((row) => row.docId).sort()).toEqual([own, privileged, restricted, unlabelled].sort())
    for (const hidden of [privileged, restricted, unlabelled]) {
      expect(partnerItems.items.find((row) => row.docId === hidden)).toMatchObject({ malformed: true, acknowledged: false })
    }

    await expect(acknowledgeLooseHold(lowPartner, privileged, now30)).rejects.toMatchObject({ status: 404, code: "not_found" })
    expect(await isLooseUploadBlocked(firmId, "partner-holder", now30)).toBe(true)
    expect((await docRef(privileged).get()).data()?.loosePartnerAck).toBeUndefined()
  })

  it("a confidential clerk's escalations omit a privileged overdue row", async () => {
    const firmId = uniq("firm")
    const clerk = user(firmId, "clerk", "confidential")
    const partner = user(firmId, "partner", "privileged")
    const secret = await seedDoc(firmId, "partner-holder", { classification: "privileged", createdAt: Timestamp.fromMillis(0) })
    const own = await seedDoc(firmId, clerk.uid, { createdAt: Timestamp.fromMillis(0) })
    const now30 = new Date(AGE_30D)
    const clerkItems = await looseVaultEscalations(clerk, firmId, now30)
    expect(clerkItems.items.map((row) => row.docId)).toEqual([own])
    expect(clerkItems.items.map((row) => row.docId)).not.toContain(secret)
    const partnerItems = await looseVaultEscalations(partner, firmId, now30)
    expect(partnerItems.items.map((row) => row.docId).sort()).toEqual([own, secret].sort())
    expect(partnerItems.items.find((row) => row.docId === secret)).toMatchObject({ malformed: false, acknowledged: false })
  })

  it("a confidential clerk does not see or tag a privileged loose file", async () => {
    const firmId = uniq("firm")
    const clerk = user(firmId, "clerk", "confidential")
    const secret = await seedDoc(firmId, "partner-holder", { classification: "privileged", looseTags: { clientName: "hidden-client", reference: null, phone: null, keys: [] } })
    await expect(tagLooseFile(clerk, secret, { clientName: "x" })).rejects.toMatchObject({ status: 404, code: "not_found" })
    expect(JSON.stringify(await listHeldFiles(clerk))).not.toContain("hidden-client")
    expect(JSON.stringify(await searchLooseFiles(clerk, "hidden"))).not.toContain(secret)
    expect((await docRef(secret).get()).data()?.looseTags.clientName).toBe("hidden-client")
  })

  it("reads loose rows past the first page and does not list a matter-bound row", async () => {
    const firmId = uniq("firm")
    const clerk = user(firmId, "clerk")
    const now30 = new Date(AGE_30D)
    const stem = uniq("pg")
    const count = LOOSE_VAULT_PAGE + 1
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const id = `${stem}-${String(i).padStart(4, "0")}`
      ids.push(id)
      const last = i === count - 1
      await adminDb().collection("documents").doc(id).set(
        looseRow(firmId, clerk.uid, { createdAt: last ? Timestamp.fromMillis(0) : Timestamp.fromMillis(AGE_30D) })
      )
    }
    const bound = `${stem}-bound`
    await adminDb().collection("documents").doc(bound).set(looseRow(firmId, clerk.uid, { matterId: `${stem}-matter`, createdAt: Timestamp.fromMillis(0) }))
    const lastId = ids[ids.length - 1]
    expect(await isLooseUploadBlocked(firmId, clerk.uid, now30)).toBe(true)
    const listed = await listHeldFiles(clerk)
    expect(listed.items).toHaveLength(count)
    expect(listed.items.map((row) => row.docId)).not.toContain(bound)
    expect((await looseVaultEscalations(clerk, firmId, now30)).items.map((row) => row.docId)).toEqual([lastId])
  })

  it("search, list and the upload-block predicate do not write", async () => {
    const firmId = uniq("firm")
    const clerk = user(firmId, "clerk")
    const docId = await seedDoc(firmId, clerk.uid, { looseTags: { clientName: "ahmad", reference: null, phone: null, keys: [] } })
    const before = (await docRef(docId).get()).updateTime?.toMillis()
    const auditsBefore = (await adminDb().collection("audit_log").where("firmId", "==", firmId).get()).size
    await searchLooseFiles(clerk, "ahmad")
    await listHeldFiles(clerk)
    await isLooseUploadBlocked(firmId, clerk.uid, new Date(AGE_29D23H))
    expect((await docRef(docId).get()).updateTime?.toMillis()).toBe(before)
    expect((await adminDb().collection("audit_log").where("firmId", "==", firmId).get()).size).toBe(auditsBefore)
  })

  it("the module source on disk has no delete", () => {
    const dir = path.resolve(__dirname, "../src/d1/looseVault")
    const files = readdirSync(dir).filter((name) => name.endsWith(".ts"))
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) {
      const src = readFileSync(path.join(dir, name), "utf8")
      expect(src.includes(".delete("), name).toBe(false)
      expect(src.includes("recursiveDelete"), name).toBe(false)
    }
  })
})
