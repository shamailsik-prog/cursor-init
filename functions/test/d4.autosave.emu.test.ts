import { createHash } from "node:crypto"
import { FieldPath, Timestamp, type DocumentData } from "firebase-admin/firestore"
import { afterEach, describe, expect, it } from "vitest"
import type { Classification } from "@/platform/p1/types"
import { CLASSIFICATION_RANKS } from "@/platform/p1/types"
import { adminDb } from "../src/admin"
import {
  AUTOSAVE_OWNER_KEY,
  AUTOSAVE_POINT_CAP,
  autosaveDraft,
  getRecoveryTimeline,
  restorePoint,
  type AutosavePointMeta,
  type AutosaveResult,
} from "../src/d4/autosave"
import { createDraftOp, saveDraftVersionOp, type DraftView } from "../src/d4/drafts"
import { HttpError } from "../src/http/errors"
import type { Caller } from "../src/p5/auth"
import { CallAudit, runAudited } from "../src/p5/common"
import { EMULATORS, uniq } from "./emu"

/**
 * L5.1 autosave points (W1-L51). The functions are not on the HTTP router (wave 2 wires routes).
 * These tests call them on the Firestore emulator and read every write back with the Admin SDK.
 * The flag is off unless a test turns `SIKANDER_FLAG_D4_AUTOSAVE` on.
 */

const FLAG = "SIKANDER_FLAG_D4_AUTOSAVE"
const TYPE = "constitutional_petition_199"
const TITLE = "Petition against the impugned order"
const BODY = "IN THE HIGH COURT. The petitioner submits as follows."
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

const savedFlag = process.env[FLAG]
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG]
  else process.env[FLAG] = savedFlag
})

function enable(): void {
  process.env[FLAG] = "true"
}

type Member = Caller

async function audited<T>(caller: Caller, action: string, run: (audit: CallAudit) => Promise<T>): Promise<T> {
  const audit = new CallAudit(action, caller.uid, "drafts")
  return runAudited(audit, () => run(audit))
}

async function seedMatter(firmId: string, classification: Classification, courtId = "SHC"): Promise<string> {
  const matterId = uniq("matter")
  await adminDb()
    .collection("matters")
    .doc(matterId)
    .set({ firmId, classification, title: "Recovery suit", stage: "pre_filing", status: "open", courtId, createdAt: Timestamp.now() })
  return matterId
}

async function addMember(firmId: string, matterId: string, uid: string): Promise<void> {
  await adminDb().collection("matter_members").doc(`${matterId}_${uid}`).set({ firmId, matterId, userId: uid, classification: "internal" })
}

function caller(firmId: string, role: Caller["role"], clearanceLevel: Classification = "privileged-restricted"): Member {
  return { uid: uniq("user"), firmId, role, clearanceLevel }
}

async function newMatter(o: { classification?: Classification; courtId?: string } = {}): Promise<{ firmId: string; matterId: string; partner: Member }> {
  const firmId = uniq("firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal" })
  const matterId = await seedMatter(firmId, o.classification ?? "internal", o.courtId)
  const partner = caller(firmId, "partner")
  await addMember(firmId, matterId, partner.uid)
  return { firmId, matterId, partner }
}

async function createDraft(caller: Caller, matterId: string, body = BODY): Promise<DraftView> {
  return audited(caller, "draft.create", (audit) =>
    createDraftOp.run({ caller, secondFactor: true }, { matterId, documentTypeId: TYPE, title: TITLE, body }, audit)
  )
}

const save = (caller: Caller, draftId: string, baseVersion: number, title: string, body: string) =>
  audited(caller, "draft.edit", (audit) => saveDraftVersionOp.run({ caller, secondFactor: true }, { draftId, baseVersion, title, body }, audit))

const autosave = (caller: Caller, draftId: string, body: string, clientSeq: number, baseVersion: number) =>
  audited(caller, "draft.edit", (audit) => autosaveDraft(caller, audit, draftId, body, clientSeq, baseVersion))

const timeline = (caller: Caller, draftId: string, cursor: string | null = null, limit = 20) =>
  audited(caller, "draft.edit", (audit) => getRecoveryTimeline(caller, audit, draftId, cursor, limit))

const restore = (caller: Caller, draftId: string, pointSeq: number) =>
  audited(caller, "draft.edit", (audit) => restorePoint(caller, audit, draftId, pointSeq))

const pointsOf = async (draftId: string): Promise<Array<{ id: string; data: DocumentData }>> => {
  const prefix = `${draftId}_`
  const snap = await adminDb()
    .collection("draft_autosave_points")
    .where(FieldPath.documentId(), ">=", prefix)
    .where(FieldPath.documentId(), "<", `${prefix}\uf8ff`)
    .orderBy(FieldPath.documentId(), "asc")
    .get()
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }))
}

const draftDoc = async (id: string) => (await adminDb().collection("drafts").doc(id).get()).data()
const versionDoc = async (id: string, n: number) => (await adminDb().collection("draft_versions").doc(`${id}_${n}`).get()).data()

/** The fields a version row is not allowed to change. Timestamps are compared by their instant. */
function versionShape(d: DocumentData | undefined): Record<string, unknown> {
  return {
    firmId: d?.firmId ?? null,
    matterId: d?.matterId ?? null,
    draftId: d?.draftId ?? null,
    version: d?.version ?? null,
    title: d?.title ?? null,
    body: d?.body ?? null,
    bodySha256: d?.bodySha256 ?? null,
    classification: d?.classification ?? null,
    kind: d?.kind ?? null,
    createdBy: d?.createdBy ?? null,
    restoredFrom: d?.restoredFrom ?? null,
    createdAt: d?.createdAt instanceof Timestamp ? d.createdAt.toMillis() : null,
  }
}

function expectErr(err: unknown, status: number, code: string): void {
  expect(err).toBeInstanceOf(HttpError)
  const http = err as HttpError
  expect({ status: http.status, code: http.code }).toEqual({ status, code })
}

async function refusal(run: Promise<unknown>): Promise<HttpError> {
  try {
    await run
  } catch (err) {
    return err as HttpError
  }
  throw new Error("expected a refusal")
}

describe.skipIf(!EMULATORS)("L5.1 autosave points", () => {
  it("50 rapid autosaves with duplicate and out-of-order clientSeq stay monotonic and have no duplicates", async () => {
    enable()
    const { matterId, partner } = await newMatter()
    const draft = await createDraft(partner, matterId)
    // 40 new points, then duplicates, out-of-order seqs, a same-hash replay, and further new points. 50 calls.
    const plan: Array<{ seq: number; body: string; expect: "write" | "stale_seq" | "duplicate_body" }> = []
    for (let i = 1; i <= 40; i++) plan.push({ seq: i, body: `point-${i}`, expect: "write" })
    plan.push({ seq: 10, body: "dup-10", expect: "stale_seq" })
    plan.push({ seq: 40, body: "dup-40", expect: "stale_seq" })
    plan.push({ seq: 7, body: "ooo-7", expect: "stale_seq" })
    plan.push({ seq: 1, body: "ooo-1", expect: "stale_seq" })
    plan.push({ seq: 40, body: "dup-40b", expect: "stale_seq" })
    plan.push({ seq: 41, body: "point-41", expect: "write" })
    plan.push({ seq: 42, body: "point-41", expect: "duplicate_body" })
    plan.push({ seq: 43, body: "point-43", expect: "write" })
    plan.push({ seq: 42, body: "stale-after-43", expect: "stale_seq" })
    plan.push({ seq: 44, body: "point-44", expect: "write" })
    expect(plan).toHaveLength(50)

    const results: AutosaveResult[] = []
    for (const step of plan) results.push(await autosave(partner, draft.draftId, step.body, step.seq, 1))

    expect(results.map((r) => (r.written ? "write" : r.reason))).toEqual(plan.map((s) => s.expect))
    const stored = await pointsOf(draft.draftId)
    const seqs = stored.map((p) => p.data.clientSeq as number)
    const pointSeqs = stored.map((p) => p.data.pointSeq as number)
    expect(seqs).toEqual([...Array(41).keys()].map((i) => i + 1).concat([43, 44]))
    expect(pointSeqs).toEqual(seqs.map((_, i) => i + 1))
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(stored.map((p) => p.data.bodyHash)).toEqual(stored.map((p) => sha(p.data.body as string)))
    // A later seq may repeat an older body. Only the last point's hash is a no-write.
    const again = await autosave(partner, draft.draftId, "point-1", 45, 1)
    expect(again.written).toBe(true)
    const page = await timeline(partner, draft.draftId, null, 100)
    expect(page.items.map((p: AutosavePointMeta) => p.clientSeq)).toEqual([45, 44, 43, 41, ...[...Array(40).keys()].map((i) => 40 - i)])
    expect(page.nextCursor).toBeNull()
    expect(page.items.every((p) => p.classification === "internal")).toBe(true)
  }, 120_000)

  it("a concurrent burst of duplicate and out-of-order seqs commits a monotonic timeline", async () => {
    enable()
    const { matterId, partner } = await newMatter()
    const draft = await createDraft(partner, matterId)
    const batch: number[] = []
    for (let i = 1; i <= 30; i++) batch.push(i)
    batch.push(5, 5, 1, 12, 30, 8, 31, 2, 31, 16)
    expect(batch).toHaveLength(40)
    const once = async (seq: number, n: number): Promise<void> => {
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          await autosave(partner, draft.draftId, `burst-${seq}-${n}`, seq, draft.currentVersion)
          return
        } catch (err) {
          if (err instanceof HttpError && err.code === "draft_changed" && attempt < 7) continue
          throw err
        }
      }
    }
    await Promise.all(batch.map((seq, n) => once(seq, n)))
    const stored = await pointsOf(draft.draftId)
    const seqs = stored.map((p) => p.data.clientSeq as number)
    const pointSeqs = stored.map((p) => p.data.pointSeq as number)
    expect(seqs.length).toBeGreaterThan(0)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(pointSeqs).toEqual(pointSeqs.map((_, i) => i + 1))
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
    expect(seqs.every((s) => batch.includes(s))).toBe(true)
  }, 120_000)

  it("restore makes version n+1 with the restored body, leaves old versions, and resets the gate like an edit", async () => {
    enable()
    const { firmId, matterId, partner } = await newMatter()
    const left = await createDraft(partner, matterId, "Original body.")
    const right = await createDraft(partner, matterId, "Original body.")
    const gate = { version: 1, bodySha256: left.currentBodySha256, status: "OK", gatedAt: Timestamp.now(), overridden: false }
    await adminDb().collection("drafts").doc(left.draftId).update({ gateResult: gate, approvedBy: partner.uid, approvedVersion: 1 })
    await adminDb().collection("drafts").doc(right.draftId).update({ gateResult: gate, approvedBy: partner.uid, approvedVersion: 1 })
    const beforeLeft = await versionDoc(left.draftId, 1)
    const beforeRight = await versionDoc(right.draftId, 1)

    const edited = await save(partner, left.draftId, 1, TITLE, "Restored body.")
    const point = await autosave(partner, right.draftId, "Restored body.", 1, 1)
    expect(point.written).toBe(true)
    if (!point.written) return
    const restored = await restore(partner, right.draftId, point.pointSeq)
    expect(restored.restored).toBe(true)
    if (!restored.restored) return
    expect(restored.saved).toBe(true)
    expect(restored.draft.currentVersion).toBe(2)
    expect(restored.draft.currentBodySha256).toBe(sha("Restored body."))
    expect(restored.draft.gateResult).toBeNull()

    const editedDoc = await draftDoc(left.draftId)
    const restoredDoc = await draftDoc(right.draftId)
    const gateShape = (d: DocumentData | undefined) => ({
      status: d?.status,
      locked: d?.locked,
      gateResult: d?.gateResult ?? null,
      approvedBy: d?.approvedBy ?? null,
      approvedVersion: d?.approvedVersion ?? null,
      currentVersion: d?.currentVersion,
      currentBodySha256: d?.currentBodySha256,
      title: d?.title,
    })
    expect(gateShape(restoredDoc)).toEqual(gateShape(editedDoc))
    expect(edited.draft.gateResult).toBeNull()
    expect(versionShape(await versionDoc(right.draftId, 1))).toEqual(versionShape(beforeRight))
    expect(versionShape(await versionDoc(left.draftId, 1))).toEqual(versionShape(beforeLeft))
    const v2 = await versionDoc(right.draftId, 2)
    expect(v2).toMatchObject({ version: 2, body: "Restored body.", bodySha256: sha("Restored body."), kind: "save", draftId: right.draftId })
    expect(v2).not.toHaveProperty("restoredFrom")
    expect(await versionDoc(right.draftId, 3)).toBeUndefined()
    const event = (await adminDb().collection("events").doc(`${right.draftId}_2_autosaved`).get()).data()
    const editedEvent = (await adminDb().collection("events").doc(`${left.draftId}_2_autosaved`).get()).data()
    expect(event).toMatchObject({
      name: "draft.autosaved",
      firmId,
      payload: { draftId: right.draftId, matterId, documentTypeId: TYPE, version: 2, gateResult: null, masterVersion: null },
    })
    expect(event?.name).toBe(editedEvent?.name)
    expect(event?.payload.gateResult).toBe(editedEvent?.payload.gateResult)
    expect(event?.payload.masterVersion).toBeNull()
    const marked = (await pointsOf(right.draftId))[0]
    expect(marked.data.referencedByRestore).toBe(true)
  })

  it("refuses restore on an approved draft and on a locked draft, and writes no version", async () => {
    enable()
    const { matterId, partner } = await newMatter()
    const approved = await createDraft(partner, matterId, "Approved body.")
    const locked = await createDraft(partner, matterId, "Locked body.")
    const approvedOnly = await createDraft(partner, matterId, "Approved unlocked body.")
    const a = await autosave(partner, approved.draftId, "later approved", 1, 1)
    const l = await autosave(partner, locked.draftId, "later locked", 1, 1)
    const u = await autosave(partner, approvedOnly.draftId, "later approved unlocked", 1, 1)
    expect(a.written && l.written && u.written).toBe(true)
    await adminDb().collection("drafts").doc(approved.draftId).update({ status: "approved", locked: true })
    await adminDb().collection("drafts").doc(locked.draftId).update({ locked: true })
    await adminDb().collection("drafts").doc(approvedOnly.draftId).update({ status: "approved", locked: false })

    expectErr(await refusal(restore(partner, approved.draftId, 1)), 409, "draft_approved")
    expectErr(await refusal(restore(partner, locked.draftId, 1)), 409, "draft_locked")
    expectErr(await refusal(restore(partner, approvedOnly.draftId, 1)), 409, "draft_approved")
    for (const id of [approved.draftId, locked.draftId, approvedOnly.draftId]) {
      expect(await versionDoc(id, 2)).toBeUndefined()
      expect((await draftDoc(id))?.currentVersion).toBe(1)
    }
    // The working text is still kept. Restore is what the lock refuses.
    expect(await pointsOf(locked.draftId)).toHaveLength(1)
    const extra = await autosave(partner, locked.draftId, "typed after lock", 2, 1)
    expect(extra.written).toBe(true)
    expect(await versionDoc(locked.draftId, 2)).toBeUndefined()
  })

  it("refuses a cross-firm caller and a non-member with the same not_found as a missing draft", async () => {
    enable()
    const { firmId, matterId, partner } = await newMatter()
    const draft = await createDraft(partner, matterId, "Secret body that must not leak.")
    await autosave(partner, draft.draftId, "Secret point body.", 1, 1)
    const other = await newMatter()
    const stranger = other.partner
    const nonMember = caller(firmId, "partner")
    const missing = "does-not-exist-draft"

    const cross = await refusal(autosave(stranger, draft.draftId, "nope", 1, 1))
    const outsider = await refusal(autosave(nonMember, draft.draftId, "nope", 2, 1))
    const absent = await refusal(autosave(partner, missing, "nope", 1, 1))
    for (const err of [cross, outsider, absent]) expectErr(err, 404, "not_found")
    expect(cross.code).toBe(absent.code)
    expect(outsider.code).toBe(absent.code)
    for (const err of [cross, outsider, absent]) {
      expect(err.message).not.toContain("Secret")
      expect(err.message).not.toContain(draft.draftId)
    }

    const crossTimeline = await refusal(timeline(stranger, draft.draftId))
    const outsiderTimeline = await refusal(timeline(nonMember, draft.draftId))
    const absentTimeline = await refusal(timeline(partner, missing))
    for (const err of [crossTimeline, outsiderTimeline, absentTimeline]) expectErr(err, 404, "not_found")

    const crossRestore = await refusal(restore(stranger, draft.draftId, 1))
    const outsiderRestore = await refusal(restore(nonMember, draft.draftId, 1))
    const absentRestore = await refusal(restore(partner, missing, 1))
    for (const err of [crossRestore, outsiderRestore, absentRestore]) expectErr(err, 404, "not_found")

    expect(await pointsOf(draft.draftId)).toHaveLength(1)
    expect((await pointsOf(draft.draftId))[0].data.body).toBe("Secret point body.")
    expect(await versionDoc(draft.draftId, 2)).toBeUndefined()
    const strangerPoints = await adminDb().collection("draft_autosave_points").where("firmId", "==", other.firmId).get()
    expect(strangerPoints.size).toBe(0)
  })

  it("paginates the timeline newest first and never returns another draft", async () => {
    enable()
    const { matterId, partner } = await newMatter()
    const a = await createDraft(partner, matterId, "A")
    const b = await createDraft(partner, matterId, "B")
    for (let i = 1; i <= 5; i++) {
      expect((await autosave(partner, a.draftId, `A-${i}`, i, 1)).written).toBe(true)
      expect((await autosave(partner, b.draftId, `B-${i}`, i, 1)).written).toBe(true)
    }
    const first = await timeline(partner, a.draftId, null, 2)
    expect(first.items.map((p) => p.clientSeq)).toEqual([5, 4])
    expect(first.nextCursor).toBeTruthy()
    const second = await timeline(partner, a.draftId, first.nextCursor, 2)
    expect(second.items.map((p) => p.clientSeq)).toEqual([3, 2])
    const third = await timeline(partner, a.draftId, second.nextCursor, 2)
    expect(third.items.map((p) => p.clientSeq)).toEqual([1])
    expect(third.nextCursor).toBeNull()
    const all = [...first.items, ...second.items, ...third.items]
    expect(all.every((p) => !String(p.pointSeq).includes("B"))).toBe(true)
    const bodies = (await pointsOf(a.draftId)).map((p) => p.data.body)
    expect(bodies).toEqual(["A-1", "A-2", "A-3", "A-4", "A-5"])
    expect((await pointsOf(b.draftId)).map((p) => p.data.body)).toEqual(["B-1", "B-2", "B-3", "B-4", "B-5"])
  })

  it("prunes to the newest cap inside one draft and keeps a restored point and the other draft", async () => {
    enable()
    expect(AUTOSAVE_POINT_CAP).toBe(200)
    const { matterId, partner } = await newMatter()
    const keep = await createDraft(partner, matterId, "Keep.")
    const other = await createDraft(partner, matterId, "Other.")
    for (let i = 1; i <= 3; i++) expect((await autosave(partner, other.draftId, `other-${i}`, i, 1)).written).toBe(true)
    const pointShape = (rows: Array<{ id: string; data: DocumentData }>) =>
      rows.map((r) => ({ id: r.id, body: r.data.body, clientSeq: r.data.clientSeq, pointSeq: r.data.pointSeq, firmId: r.data.firmId }))
    const otherBefore = pointShape(await pointsOf(other.draftId))

    for (let i = 1; i <= AUTOSAVE_POINT_CAP; i++) {
      const wrote = await autosave(partner, keep.draftId, `cap-${i}`, i, 1)
      expect(wrote.written).toBe(true)
    }
    expect(await pointsOf(keep.draftId)).toHaveLength(AUTOSAVE_POINT_CAP)
    const restored = await restore(partner, keep.draftId, 1)
    expect(restored.restored && restored.saved).toBe(true)
    // Point 1 is now referenced. Two further points push the window past it and past point 2.
    const n1 = await autosave(partner, keep.draftId, "cap-next-1", AUTOSAVE_POINT_CAP + 1, 2)
    const n2 = await autosave(partner, keep.draftId, "cap-next-2", AUTOSAVE_POINT_CAP + 2, 2)
    expect(n1.written && n2.written).toBe(true)
    const kept = await pointsOf(keep.draftId)
    const seqs = kept.map((p) => p.data.pointSeq as number)
    expect(seqs[0]).toBe(1)
    expect(kept[0].data.referencedByRestore).toBe(true)
    expect(kept[0].data.body).toBe("cap-1")
    expect(seqs).not.toContain(2)
    expect(seqs[seqs.length - 1]).toBe(AUTOSAVE_POINT_CAP + 2)
    expect(seqs.slice(1)).toEqual(Array.from({ length: AUTOSAVE_POINT_CAP }, (_, i) => i + 3))
    expect(pointShape(await pointsOf(other.draftId))).toEqual(otherBefore)
    expect((await versionDoc(other.draftId, 1))?.body).toBe("Other.")
    expect(await versionDoc(other.draftId, 2)).toBeUndefined()
  }, 180_000)

  it("stores a point at or above the draft's classification and never lowers one", async () => {
    enable()
    const high = await newMatter({ classification: "privileged" })
    const highDraft = await createDraft(high.partner, high.matterId, "Privileged text.")
    expect(highDraft.classification).toBe("privileged")
    const highPoint = await autosave(high.partner, highDraft.draftId, "Privileged point.", 1, 1)
    expect(highPoint.written).toBe(true)
    if (!highPoint.written) return
    expect(highPoint.classification).toBe("privileged")
    expect(CLASSIFICATION_RANKS[highPoint.classification]).toBeGreaterThanOrEqual(CLASSIFICATION_RANKS[highDraft.classification])
    expect((await pointsOf(highDraft.draftId))[0].data.classification).toBe("privileged")

    const { matterId, partner } = await newMatter({ classification: "internal" })
    const draft = await createDraft(partner, matterId, "Internal text.")
    expect((await autosave(partner, draft.draftId, "first", 1, 1)).written).toBe(true)
    await adminDb().collection("matters").doc(matterId).update({ classification: "confidential" })
    const raised = await autosave(partner, draft.draftId, "second", 2, 1)
    expect(raised.written).toBe(true)
    if (!raised.written) return
    expect(CLASSIFICATION_RANKS[raised.classification]).toBeGreaterThanOrEqual(CLASSIFICATION_RANKS.confidential)
    const afterMatter = await pointsOf(draft.draftId)
    for (const point of afterMatter) {
      expect(CLASSIFICATION_RANKS[point.data.classification as Classification]).toBeGreaterThanOrEqual(CLASSIFICATION_RANKS.confidential)
    }

    await adminDb().collection("drafts").doc(draft.draftId).update({ classification: "privileged" })
    const lifted = await autosave(partner, draft.draftId, "third", 3, 1)
    expect(lifted.written).toBe(true)
    const afterDraft = await pointsOf(draft.draftId)
    const draftNow = await draftDoc(draft.draftId)
    for (const point of afterDraft) {
      expect(CLASSIFICATION_RANKS[point.data.classification as Classification]).toBeGreaterThanOrEqual(
        CLASSIFICATION_RANKS[draftNow?.classification as Classification]
      )
    }
    expect(afterDraft.map((p) => p.data.classification)).toEqual(["privileged", "privileged", "privileged"])

    // A later lower label on the draft must not pull an existing point down.
    await adminDb().collection("drafts").doc(draft.draftId).update({ classification: "internal" })
    await adminDb().collection("matters").doc(matterId).update({ classification: "internal" })
    expect((await autosave(partner, draft.draftId, "fourth", 4, 1)).written).toBe(true)
    const labels = (await pointsOf(draft.draftId)).map((p) => p.data.classification)
    expect(labels.slice(0, 3)).toEqual(["privileged", "privileged", "privileged"])
    expect(CLASSIFICATION_RANKS[labels[3] as Classification]).toBeGreaterThanOrEqual(CLASSIFICATION_RANKS.internal)
  })

  it("writes nothing when the flag is off, and the flag accepts only true", async () => {
    const { matterId, partner } = await newMatter()
    const draft = await createDraft(partner, matterId)
    const beforeVersions = await versionDoc(draft.draftId, 1)
    const auditsBefore = (await adminDb().collection("audit_log").where("actorId", "==", partner.uid).get()).size

    delete process.env[FLAG]
    const off = await autosave(partner, draft.draftId, "should not store", 1, 1)
    expect(off).toEqual({ written: false, reason: "disabled" })
    expect(await timeline(partner, draft.draftId)).toEqual({ items: [], nextCursor: null })
    const offRestore = await restore(partner, draft.draftId, 1)
    expect(offRestore).toEqual({ restored: false, reason: "disabled" })
    expect(await pointsOf(draft.draftId)).toHaveLength(0)
    expect(versionShape(await versionDoc(draft.draftId, 1))).toEqual(versionShape(beforeVersions))
    expect(await versionDoc(draft.draftId, 2)).toBeUndefined()
    expect((await adminDb().collection("audit_log").where("actorId", "==", partner.uid).get()).size).toBe(auditsBefore)

    for (const value of ["false", "yes", "on", "1", ""]) {
      process.env[FLAG] = value
      const result = await autosave(partner, draft.draftId, `nope-${value}`, 1, 1)
      expect(result.written).toBe(false)
    }
    // A surrounding space is trimmed. Only the exact word true enables a write.
    process.env[FLAG] = " TRUE "
    const on = await autosave(partner, draft.draftId, "stored while on", 1, 1)
    expect(on.written).toBe(true)
    expect(await pointsOf(draft.draftId)).toHaveLength(1)

    process.env[FLAG] = "false"
    const after = (await pointsOf(draft.draftId)).map((p) => ({ id: p.id, body: p.data.body, clientSeq: p.data.clientSeq }))
    await autosave(partner, draft.draftId, "not stored", 2, 1)
    await timeline(partner, draft.draftId)
    await restore(partner, draft.draftId, 1)
    expect((await pointsOf(draft.draftId)).map((p) => ({ id: p.id, body: p.data.body, clientSeq: p.data.clientSeq }))).toEqual(after)
    expect(await versionDoc(draft.draftId, 2)).toBeUndefined()
  })

  it("refuses a bad body, a future baseVersion, and a missing point without a new version", async () => {
    enable()
    const { matterId, partner } = await newMatter()
    const draft = await createDraft(partner, matterId)
    expectErr(await refusal(autosave(partner, draft.draftId, `bad\u202e`, 1, 1)), 422, "unsupported_characters")
    expectErr(await refusal(autosave(partner, draft.draftId, "x", 1, 9)), 409, "draft_changed")
    expectErr(await refusal(autosave(partner, draft.draftId, "x", 0, 1)), 400, "invalid_client_seq")
    expect(await pointsOf(draft.draftId)).toHaveLength(0)
    const point = await autosave(partner, draft.draftId, "kept", 1, 1)
    expect(point.written).toBe(true)
    expectErr(await refusal(restore(partner, draft.draftId, 9)), 404, "point_not_found")
    expect(await versionDoc(draft.draftId, 2)).toBeUndefined()
    expect((await draftDoc(draft.draftId))?.currentVersion).toBe(1)
  })

  it("puts firmId on every row, and finds a null matterId by firmId plus the owner key", async () => {
    enable()
    const { firmId, matterId, partner } = await newMatter()
    const draft = await createDraft(partner, matterId)
    expect((await autosave(partner, draft.draftId, "keyed", 1, 1)).written).toBe(true)
    for (const row of await pointsOf(draft.draftId)) {
      expect(row.data.firmId).toBe(firmId)
      expect(row.data[AUTOSAVE_OWNER_KEY]).toBe(partner.uid)
    }
    const head = (await adminDb().collection("draft_autosave_points").doc(`${draft.draftId}~head`).get()).data()
    expect(head?.firmId).toBe(firmId)
    expect(head?.[AUTOSAVE_OWNER_KEY]).toBe(partner.uid)
    expect(head?.matterId).toBe(matterId)

    const owner = caller(firmId, "partner")
    const preId = uniq("draft")
    await adminDb().collection("drafts").doc(preId).set({
      firmId,
      matterId: null,
      createdBy: owner.uid,
      classification: "internal",
      currentVersion: 1,
      title: TITLE,
      status: "draft",
      locked: false,
      documentTypeId: TYPE,
    })
    expectErr(await refusal(autosave(caller(uniq("firm"), "partner"), preId, "no", 1, 1)), 404, "not_found")
    expectErr(await refusal(autosave(caller(firmId, "partner"), preId, "no", 1, 1)), 404, "not_found")
    const intern: Caller = { ...owner, role: "intern" }
    expectErr(await refusal(autosave(intern, preId, "no", 1, 1)), 403, "intern_channel_denied")

    expect((await autosave(owner, preId, "pre-matter text", 1, 1)).written).toBe(true)
    const preRows = await pointsOf(preId)
    expect(preRows).toHaveLength(1)
    expect(preRows[0].data.firmId).toBe(firmId)
    expect(preRows[0].data[AUTOSAVE_OWNER_KEY]).toBe(owner.uid)
    expect(preRows[0].data.matterId).toBeNull()
    const preHead = (await adminDb().collection("draft_autosave_points").doc(`${preId}~head`).get()).data()
    expect(preHead).toMatchObject({ firmId, [AUTOSAVE_OWNER_KEY]: owner.uid, matterId: null, draftId: preId })

    const byOwner = await adminDb().collection("draft_autosave_points").where("firmId", "==", firmId).where(AUTOSAVE_OWNER_KEY, "==", owner.uid).get()
    const preMatter = byOwner.docs.filter((d) => d.data().matterId === null)
    expect(preMatter.map((d) => d.get("draftId")).sort()).toEqual([preId, preId])
    const byMatter = await adminDb().collection("draft_autosave_points").where("firmId", "==", firmId).where("matterId", "==", matterId).get()
    expect(byMatter.docs.some((d) => d.get("draftId") === preId)).toBe(false)

    expect(await timeline(owner, preId)).toMatchObject({ items: [{ pointSeq: 1 }], nextCursor: null })
    expectErr(await refusal(restore(owner, preId, 1)), 409, "matter_required")
    expect(await versionDoc(preId, 1)).toBeUndefined()
  })
})
