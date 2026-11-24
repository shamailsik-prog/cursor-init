import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Timestamp } from "firebase-admin/firestore"
import { afterEach, describe, expect, it, vi } from "vitest"
import shippedPolicy from "@/infra/retention/policy.json"
import { CourtOpsMatterUnboundError, recordCourtOpsAckFirestore, upsertFollowUpFirestore } from "@/platform/persistence/courtOpsMatterBinding"
import { canonicalMatterDocument } from "@/platform/d1/matterDocument"
import { MATTER_TOMBSTONES } from "@/platform/retention/tombstone"
import type { WorkflowOpsActivityRow } from "@/platform/spine/store"
import { adminDb } from "../src/admin"
import { enqueueJob } from "../src/p2/enqueue"
import { JobError } from "../src/p2/errors"
import { runJobTask } from "../src/p2/worker"
import { retentionTestSeam, storeKey, type RetentionPolicy } from "../src/retention/config"
import { courtOpsUnlinkedCollection, courtOpsUnlinkedSample, reachCourtOpsDeletion } from "../src/retention/courtOpsDeletionReach"
import { DELETION_REQUESTS_COLLECTION, LEGAL_HOLDS_COLLECTION, PREPARE_JOB_TYPE, PURGE_JOB_TYPE } from "../src/retention/model"
import { viaApi } from "./api"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { deleteFirmScopedData } from "./firmCleanup"
import { FakeClock, testDeps } from "./jobs"

vi.setConfig({ testTimeout: 120_000 })

const PURGE = {
  [storeKey("firestore:follow_ups")]: "purge",
  [storeKey("firestore:workflow_ops_activity")]: "purge",
}
const RETAIN = {
  [storeKey("firestore:follow_ups")]: "retained",
  [storeKey("firestore:workflow_ops_activity")]: "retained",
}

type Seam = typeof retentionTestSeam & {
  failCourtOpsReach?: boolean
  courtOpsReachMaxPages?: number
  afterCourtOpsReachPage?: (page: number) => Promise<void>
}
const seam = retentionTestSeam as Seam

/**
 * FA-D4-001-FU1-001: legacy follow-ups and court-ops acknowledgements stored with matterId null are
 * bound, or removed and reported, before F42 enqueues the purge. Firm-level workflow acknowledgements stay.
 */

describe.skipIf(!EMULATORS)("FA-D4-001-FU1-001 deletion reach", () => {
  const firms: string[] = []

  const uids: string[] = []

  afterEach(async () => {
    delete seam.failCourtOpsReach
    delete seam.courtOpsReachMaxPages
    delete seam.afterCourtOpsReachPage
    delete retentionTestSeam.policy
    if (firms.length > 0) {
      const db = adminDb()
      const reqs = await db.collection(DELETION_REQUESTS_COLLECTION).where("firmId", "in", firms.slice(0, 30)).get()
      for (const req of reqs.docs) {
        const chunks = await req.ref.collection(courtOpsUnlinkedCollection()).get()
        for (let start = 0; start < chunks.size; start += 400) {
          const batch = db.batch()
          for (const doc of chunks.docs.slice(start, start + 400)) batch.delete(doc.ref)
          await batch.commit()
        }
      }
    }
    if (firms.length === 0 && uids.length === 0) return
    await deleteFirmScopedData(firms.splice(0), uids.splice(0))
  })

  async function opened(plan: Record<string, string> = PURGE) {
    const db = adminDb()
    const firmId = uniq("fu1001")
    firms.push(firmId)
    const matterId = uniq("m")
    const requestId = uniq("req")
    await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).set({ firmId, matterId, status: "in_progress", plan })
    return { db, firmId, matterId, requestId }
  }

  it("stamps a null acknowledgement with its follow-up's matter so the matter query finds it", async () => {
    const { db, firmId, matterId, requestId } = await opened()
    const item = uniq("fu")
    await db.collection("follow_ups").doc(item).set({ firmId, matterId, raw: "CP 1" })
    const ackId = `ops:court_ops:ack:${firmId}:follow_up:${item}`
    await db.collection("workflow_ops_activity").doc(ackId).set({
      firmId, matterId: null, followUpId: item, queueType: "follow_up", action: "court_ops_acknowledge", source: "court_ops",
    })
    const result = await reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId })
    expect(result.stamped).toBe(1)
    expect((await db.collection("workflow_ops_activity").doc(ackId).get()).get("matterId")).toBe(matterId)
    const found = await db.collection("workflow_ops_activity").where("firmId", "==", firmId).where("matterId", "==", matterId).get()
    expect(found.docs.map((doc) => doc.id)).toContain(ackId)
  })

  it("leaves a firm-level workflow acknowledgement live and unreported", async () => {
    const { db, firmId, matterId, requestId } = await opened()
    const item = uniq("doc")
    await db.collection("document_workflow").doc(item).set({ documentId: item, firmId, matterId: null, status: "review_required" })
    const ackId = `ops:court_ops:ack:${firmId}:workflow:${item}`
    await db.collection("workflow_ops_activity").doc(ackId).set({
      firmId, matterId: null, documentId: item, queueType: "workflow", action: "court_ops_acknowledge", source: "court_ops",
    })
    const eventId = uniq("wfe")
    await db.collection("workflow_ops_activity").doc(eventId).set({
      firmId, matterId: null, source: "workflow_event", action: "workflow_transition",
    })
    await reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId })
    expect((await db.collection("workflow_ops_activity").doc(ackId).get()).get("matterId")).toBeNull()
    expect((await db.collection("workflow_ops_activity").doc(eventId).get()).exists).toBe(true)
    expect((await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).get()).get("courtOpsUnlinked")).toBeUndefined()
  })

  it("records an unbound follow-up and leaves it live", async () => {
    const { db, firmId, matterId, requestId } = await opened()
    const id = uniq("loose")
    await db.collection("follow_ups").doc(id).set({ firmId, matterId: null, raw: "unbound" })
    const result = await reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId })
    expect(result.removed).toBe(0)
    expect((await db.collection("follow_ups").doc(id).get()).exists).toBe(true)
    const request = (await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).get()).data()
    expect(request?.courtOpsUnlinked).toContain(id)
    expect(request?.courtOpsUnlinkedReasons?.[id]).toBe("matter_unbound")
    expect(request?.courtOpsUnlinkedCount).toBe(1)
    expect(request?.courtOpsUnlinkedTruncated).not.toBe(true)
  })

  it("stamps an acknowledgement of another live matter and deletes one whose matter is already tombstoned", async () => {
    const { db, firmId, matterId, requestId } = await opened()
    const live = uniq("live")
    const gone = uniq("gone")
    const liveItem = uniq("doc")
    const goneItem = uniq("doc")
    await db.collection("document_workflow").doc(liveItem).set({ documentId: liveItem, firmId, matterId: live })
    await db.collection("document_workflow").doc(goneItem).set({ documentId: goneItem, firmId, matterId: gone })
    const yRequest = uniq("yreq")
    await db.collection(DELETION_REQUESTS_COLLECTION).doc(yRequest).set({ firmId, matterId: gone, status: "in_progress", plan: PURGE })
    await db.collection(MATTER_TOMBSTONES).doc(gone).set({ firmId, matterId: gone, requestId: yRequest })
    const liveAck = `ops:court_ops:ack:${firmId}:workflow:${liveItem}`
    const goneAck = `ops:court_ops:ack:${firmId}:workflow:${goneItem}`
    await db.collection("workflow_ops_activity").doc(liveAck).set({
      firmId, matterId: null, documentId: liveItem, queueType: "workflow", action: "court_ops_acknowledge", source: "court_ops",
    })
    await db.collection("workflow_ops_activity").doc(goneAck).set({
      firmId, matterId: null, documentId: goneItem, queueType: "workflow", action: "court_ops_acknowledge", source: "court_ops",
    })
    await reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId })
    expect((await db.collection("workflow_ops_activity").doc(liveAck).get()).get("matterId")).toBe(live)
    expect((await db.collection("workflow_ops_activity").doc(goneAck).get()).exists).toBe(false)
    expect((await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).get()).get("courtOpsUnlinked")).toEqual([goneAck])
  })

  it("writes nothing when a legal hold is active on the matter being deleted", async () => {
    const { db, firmId, matterId, requestId } = await opened()
    await db.collection(LEGAL_HOLDS_COLLECTION).doc(matterId).set({ firmId, active: true })
    const id = uniq("held")
    await db.collection("follow_ups").doc(id).set({ firmId, matterId: null, raw: "held" })
    await expect(reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId })).rejects.toMatchObject({ code: "legal_hold_active" })
    expect((await db.collection("follow_ups").doc(id).get()).exists).toBe(true)
    expect((await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).get()).get("courtOpsUnlinked")).toBeUndefined()
  })

  it("rejects a missing deletion request before it changes a row", async () => {
    const { db, firmId, matterId } = await opened()
    const id = uniq("loose")
    await db.collection("follow_ups").doc(id).set({ firmId, matterId: null, raw: "x" })
    await expect(reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId: uniq("missing") })).rejects.toBeInstanceOf(JobError)
    expect((await db.collection("follow_ups").doc(id).get()).exists).toBe(true)
  })

  it("DEL-264-002: matter Y on hold keeps its legacy follow-up, and X's deletion only records the id", async () => {
    const { db, firmId, matterId, requestId } = await opened()
    const matterY = uniq("y")
    await db.collection(LEGAL_HOLDS_COLLECTION).doc(matterY).set({ firmId, active: true })
    const id = uniq("yfu")
    await db.collection("follow_ups").doc(id).set({ firmId, matterId: null, raw: "about Y" })
    const result = await reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId })
    expect(result.removed).toBe(0)
    expect((await db.collection("follow_ups").doc(id).get()).exists).toBe(true)
    const request = (await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).get()).data()
    expect(request?.courtOpsUnlinked).toContain(id)
    expect(request?.courtOpsUnlinkedReasons?.[id]).toBe("matter_unbound")
  })

  it("DEL-264-001: a retained plan stamps and records, and deletes nothing", async () => {
    const { db, firmId, matterId, requestId } = await opened(RETAIN)
    const loose = uniq("loose")
    await db.collection("follow_ups").doc(loose).set({ firmId, matterId: null, raw: "loose" })
    const orphan = `ops:court_ops:ack:${firmId}:workflow:${uniq("orphan")}`
    await db.collection("workflow_ops_activity").doc(orphan).set({
      firmId, matterId: null, documentId: uniq("missing"), queueType: "workflow", action: "court_ops_acknowledge", source: "court_ops",
    })
    const parent = uniq("doc")
    const gone = uniq("gone")
    await db.collection("document_workflow").doc(parent).set({ documentId: parent, firmId, matterId: gone })
    await db.collection(MATTER_TOMBSTONES).doc(gone).set({ firmId, matterId: gone })
    const tombAck = `ops:court_ops:ack:${firmId}:workflow:${parent}`
    await db.collection("workflow_ops_activity").doc(tombAck).set({
      firmId, matterId: null, documentId: parent, queueType: "workflow", action: "court_ops_acknowledge", source: "court_ops",
    })
    const liveParent = uniq("livefu")
    await db.collection("follow_ups").doc(liveParent).set({ firmId, matterId, raw: "bound" })
    const liveAck = `ops:court_ops:ack:${firmId}:follow_up:${liveParent}`
    await db.collection("workflow_ops_activity").doc(liveAck).set({
      firmId, matterId: null, followUpId: liveParent, queueType: "follow_up", action: "court_ops_acknowledge", source: "court_ops",
    })
    const result = await reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId })
    expect(result.removed).toBe(0)
    expect((await db.collection("follow_ups").doc(loose).get()).exists).toBe(true)
    expect((await db.collection("workflow_ops_activity").doc(orphan).get()).exists).toBe(true)
    expect((await db.collection("workflow_ops_activity").doc(tombAck).get()).get("matterId")).toBe(gone)
    expect((await db.collection("workflow_ops_activity").doc(liveAck).get()).get("matterId")).toBe(matterId)
    const request = (await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).get()).data()
    expect(request?.courtOpsUnlinked).toEqual(expect.arrayContaining([loose, orphan, tombAck]))
    expect(request?.courtOpsUnlinkedReasons?.[tombAck]).toBe("tombstoned")
  })

  it("QUERY-264-007: a missing matterId field and an empty string are recorded, not skipped", async () => {
    const { db, firmId, matterId, requestId } = await opened()
    const absent = uniq("abs")
    const empty = uniq("empty")
    await db.collection("follow_ups").doc(absent).set({ firmId, raw: "no field" })
    await db.collection("follow_ups").doc(empty).set({ firmId, matterId: "", raw: "blank" })
    const parent = uniq("pfu")
    await db.collection("follow_ups").doc(parent).set({ firmId, matterId, raw: "parent" })
    const ack = `ops:court_ops:ack:${firmId}:follow_up:${parent}`
    await db.collection("workflow_ops_activity").doc(ack).set({
      firmId, followUpId: parent, queueType: "follow_up", action: "court_ops_acknowledge", source: "court_ops",
    })
    await reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId })
    expect((await db.collection("follow_ups").doc(absent).get()).exists).toBe(true)
    expect((await db.collection("follow_ups").doc(empty).get()).exists).toBe(true)
    expect((await db.collection("workflow_ops_activity").doc(ack).get()).get("matterId")).toBe(matterId)
    const request = (await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).get()).data()
    expect(request?.courtOpsUnlinked).toEqual(expect.arrayContaining([absent, empty]))
  })

  it("AUDIT-264-006: every unlinked id is stored, including the 401st", async () => {
    const { db, firmId, matterId, requestId } = await opened()
    const ids = Array.from({ length: 401 }, (_, i) => `u${String(i).padStart(4, "0")}${firmId}`)
    for (let start = 0; start < ids.length; start += 400) {
      const batch = db.batch()
      for (const id of ids.slice(start, start + 400)) batch.set(db.collection("follow_ups").doc(id), { firmId, matterId: null, raw: "x" })
      await batch.commit()
    }
    await reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId })
    const request = (await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).get()).data()
    expect(request?.courtOpsUnlinked).toHaveLength(courtOpsUnlinkedSample())
    expect(request?.courtOpsUnlinkedCount).toBe(401)
    expect(request?.courtOpsUnlinkedTruncated).toBe(true)
    expect(request?.courtOpsUnlinked).toContain(ids[0])
    const stored = new Set<string>()
    const chunks = await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).collection(courtOpsUnlinkedCollection()).get()
    for (const doc of chunks.docs) for (const id of doc.get("ids") as string[]) stored.add(id)
    expect(stored.size).toBe(401)
    expect(stored.has(ids[400])).toBe(true)
    expect((await db.collection("follow_ups").doc(ids[400]).get()).exists).toBe(true)
  }, 120_000)

  it("A17: more than 100 null acknowledgements are stamped", async () => {
    const { db, firmId, matterId, requestId } = await opened()
    const n = 1003
    for (let start = 0; start < n; start += 400) {
      const batch = db.batch()
      for (let i = start; i < Math.min(n, start + 400); i++) {
        const item = `p${String(i).padStart(4, "0")}${firmId}`
        batch.set(db.collection("follow_ups").doc(item), { firmId, matterId, raw: "p" })
        batch.set(db.collection("workflow_ops_activity").doc(`ops:court_ops:ack:${firmId}:follow_up:${item}`), {
          firmId, matterId: null, followUpId: item, queueType: "follow_up", action: "court_ops_acknowledge", source: "court_ops",
        })
      }
      await batch.commit()
    }
    const result = await reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId })
    expect(result.stamped).toBe(n)
    const found = (await db.collection("workflow_ops_activity").where("firmId", "==", firmId).where("matterId", "==", matterId).count().get()).data().count
    expect(found).toBe(n)
  }, 120_000)

  it("CAP-264-005: hitting the page cap fails with a coded error", async () => {
    const { db, firmId, matterId, requestId } = await opened()
    for (let start = 0; start < 150; start += 100) {
      const batch = db.batch()
      for (let i = start; i < Math.min(150, start + 100); i++) {
        batch.set(db.collection("follow_ups").doc(`c${String(i).padStart(4, "0")}${firmId}`), { firmId, matterId: null, raw: "x" })
      }
      await batch.commit()
    }
    seam.courtOpsReachMaxPages = 1
    await expect(reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId })).rejects.toMatchObject({ code: "court_ops_reach_capped" })
  })

  it("CAP-264-005: bound rows after one absent candidate do not trip the cap", async () => {
    const { db, firmId, matterId, requestId } = await opened()
    const absent = `a-absent-${firmId}`
    await db.collection("follow_ups").doc(absent).set({ firmId, raw: "unbound" })
    for (let start = 0; start < 150; start += 100) {
      const batch = db.batch()
      for (let i = start; i < Math.min(150, start + 100); i++) {
        batch.set(db.collection("follow_ups").doc(`b${String(i).padStart(4, "0")}${firmId}`), { firmId, matterId, raw: "bound" })
      }
      await batch.commit()
    }
    seam.courtOpsReachMaxPages = 1
    const result = await reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId })
    expect(result.removed).toBe(0)
    expect((await db.collection("follow_ups").doc(absent).get()).exists).toBe(true)
    const request = (await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).get()).data()
    expect(request?.courtOpsUnlinked).toContain(absent)
  })

  it("A6: a tombstone of another firm does not delete the row", async () => {
    const { db, firmId, matterId, requestId } = await opened()
    const firmB = uniq("r2b")
    firms.push(firmB)
    const gone = uniq("mG")
    const item = uniq("doc")
    await db.collection("document_workflow").doc(item).set({ documentId: item, firmId, matterId: gone })
    await db.collection(MATTER_TOMBSTONES).doc(gone).set({ firmId: firmB, matterId: gone })
    const ackId = `ops:court_ops:ack:${firmId}:workflow:${item}`
    await db.collection("workflow_ops_activity").doc(ackId).set({
      firmId, matterId: null, documentId: item, queueType: "workflow", action: "court_ops_acknowledge", source: "court_ops",
    })
    await reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId })
    expect((await db.collection("workflow_ops_activity").doc(ackId).get()).get("matterId")).toBe(gone)
  })

  it("A14: the Firestore follow-up upsert refuses an empty matterId and writes nothing", async () => {
    const { db, firmId } = await opened()
    const id = uniq("fu")
    await expect(upsertFollowUpFirestore(db as never, {
      id, firmId, matterId: "", courtId: "SHC", raw: "x", kind: "case_number_reject",
    })).rejects.toBeInstanceOf(CourtOpsMatterUnboundError)
    expect((await db.collection("follow_ups").doc(id).get()).exists).toBe(false)
  })

  it("A28: a missing Firestore workflow parent is refused and nothing is written", async () => {
    const { db, firmId } = await opened()
    const item = uniq("doc")
    const row = {
      id: `ops:court_ops:ack:${firmId}:workflow:${item}`,
      firmId,
      source: "court_ops",
      action: "court_ops_acknowledge",
      actorId: "u",
      classification: "internal",
      matterId: null,
      documentId: item,
      followUpId: null,
      queueType: "workflow",
      status: "acknowledged",
      detail: "seen",
      tags: ["court"],
      createdAt: 100,
    } satisfies WorkflowOpsActivityRow
    await expect(recordCourtOpsAckFirestore(db as never, firmId, row)).rejects.toBeInstanceOf(CourtOpsMatterUnboundError)
    expect((await db.collection("workflow_ops_activity").doc(row.id).get()).exists).toBe(false)
  })

  it("FENCE-264-004: a crash between pages retries the rest of the reach", async () => {
    const { db, firmId, matterId, requestId } = await opened()
    const n = 150
    for (let start = 0; start < n; start += 100) {
      const batch = db.batch()
      for (let i = start; i < Math.min(n, start + 100); i++) {
        const item = `k${String(i).padStart(4, "0")}${firmId}`
        batch.set(db.collection("follow_ups").doc(item), { firmId, matterId, raw: "p" })
        batch.set(db.collection("workflow_ops_activity").doc(`ops:court_ops:ack:${firmId}:follow_up:${item}`), {
          firmId, matterId: null, followUpId: item, queueType: "follow_up", action: "court_ops_acknowledge", source: "court_ops",
        })
      }
      await batch.commit()
    }
    seam.afterCourtOpsReachPage = async () => {
      throw new Error("crash after first court-ops page")
    }
    await expect(reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId })).rejects.toThrow(/crash after first court-ops page/)
    const mid = (await db.collection("workflow_ops_activity").where("firmId", "==", firmId).where("matterId", "==", matterId).count().get()).data().count
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(n)
    delete seam.afterCourtOpsReachPage
    const result = await reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId })
    expect(result.stamped + mid).toBe(n)
    const found = (await db.collection("workflow_ops_activity").where("firmId", "==", firmId).where("matterId", "==", matterId).count().get()).data().count
    expect(found).toBe(n)
  }, 120_000)

  it("DEL-264-001 S1: a retained saga leaves the null rows live and acknowledges retained", async () => {
    const policy = structuredClone(shippedPolicy) as unknown as RetentionPolicy
    policy.policyVersion = "test-r2-retain-court-ops"
    for (const name of ["matter_access", "matter_content", "derived_index", "job_record", "legacy_matter_ops"]) {
      policy.classes[name] = { ...policy.classes[name], onMatterDeletion: "purge", legalHold: false }
    }
    policy.classes.matter_content = { ...policy.classes.matter_content, onMatterDeletion: "retain", legalHold: false }
    policy.classes.legacy_matter_ops = { ...policy.classes.legacy_matter_ops, onMatterDeletion: "retain", legalHold: false }
    policy.classes.matter_record = { ...policy.classes.matter_record, onMatterDeletion: "anonymise", legalHold: false }
    policy.classes.ai_record = { ...policy.classes.ai_record, onMatterDeletion: "anonymise", legalHold: false }
    policy.classes.vault_object = { ...policy.classes.vault_object, onMatterDeletion: "lock", legalHold: false }
    policy.classes.third_party_trace = { ...policy.classes.third_party_trace, onMatterDeletion: "external" }
    policy.classes.backup = { ...policy.classes.backup, onMatterDeletion: "expiry" }
    retentionTestSeam.policy = policy
    const db = adminDb()
    const firmId = uniq("s1")
    firms.push(firmId)
    await db.collection("firms").doc(firmId).set({ name: "S1", plan: "internal", rateLimits: { general: 1000 } })
    const claims = { firmId, clearanceLevel: "privileged-restricted" }
    const partner = await mintIdToken({ ...claims, role: "partner" })
    const approver = await mintIdToken({ ...claims, role: "partner" })
    uids.push(partner.uid, approver.uid)
    for (const uid of [partner.uid, approver.uid]) {
      await db.collection("users").doc(uid).set({ createdAt: Timestamp.fromMillis(Date.now() - 400 * 86_400_000), independentPartner: true }, { merge: true })
    }
    const matterId = uniq("s1m")
    await db.collection("matters").doc(matterId).set({
      ...canonicalMatterDocument({ firmId, clientId: `client-${firmId}`, title: "S1", classification: "internal", status: "live", stage: "pre_filing", courtId: "SHC", caseNumber: null, matterNo: null, conflictCheckId: null, createdBy: partner.uid }),
      createdAt: Timestamp.now(),
    })
    for (const uid of [partner.uid, approver.uid]) {
      await db.collection("matter_members").doc(`${matterId}_${uid}`).set({ firmId, matterId, userId: uid, addedBy: partner.uid, classification: "internal", createdAt: Timestamp.now() })
    }
    const loose = uniq("s1loose")
    const orphanItem = uniq("s1or")
    const orphan = `ops:court_ops:ack:${firmId}:workflow:${orphanItem}`
    await db.collection("follow_ups").doc(loose).set({ firmId, matterId: null, raw: "loose" })
    await db.collection("workflow_ops_activity").doc(orphan).set({
      firmId, matterId: null, documentId: orphanItem, queueType: "workflow", action: "court_ops_acknowledge", source: "court_ops",
    })
    const requestApi = viaApi<{ requestId: string; status: string }>("requestMatterDeletion")
    const approveApi = viaApi<{ requestId: string; status: string }>("approveMatterDeletion")
    const statusApi = viaApi<{ status: string; acks: Array<{ storeId: string; outcome: string }> }>("getDeletionRequest")
    const requested = await requestApi({ token: partner.token, data: { firmId, matterId, reasonCode: "client_instruction" } } as never)
    expect(requested.status).toBe("pending_approval")
    const approved = await approveApi({ token: approver.token, data: { firmId, requestId: requested.requestId } } as never)
    expect(approved.status).toBe("in_progress")
    const clock = new FakeClock(Date.now())
    const deps = testDeps(clock)
    for (let i = 0; i < 60; i++) {
      clock.set(Math.max(clock.now(), Date.now()))
      const snap = await db.collection("jobs").where("firmId", "==", firmId).where("status", "in", ["queued", "failed"]).get()
      const due = snap.docs.filter((d) => d.get("engine") === "p2" && String(d.get("jobType")).startsWith("retention."))
      if (due.length === 0) break
      for (const d of due) {
        const next = d.get("nextAttemptAt") as Timestamp | null
        if (next && next.toMillis() > clock.now()) clock.set(next.toMillis() + 1)
        await runJobTask({ jobId: d.id, seq: d.get("dispatchSeq") as number }, deps)
      }
      if (i === 59) throw new Error("retention jobs did not settle")
    }
    const view = await statusApi({ token: partner.token, data: { firmId, requestId: requested.requestId } } as never)
    expect(view.status).toBe("completed")
    expect(view.acks.find((ack) => ack.storeId === "firestore:follow_ups")?.outcome).toBe("retained")
    expect(view.acks.find((ack) => ack.storeId === "firestore:workflow_ops_activity")?.outcome).toBe("retained")
    expect((await db.collection("follow_ups").doc(loose).get()).exists).toBe(true)
    expect((await db.collection("workflow_ops_activity").doc(orphan).get()).exists).toBe(true)
    const stored = (await db.collection(DELETION_REQUESTS_COLLECTION).doc(requested.requestId).get()).data()
    expect(stored?.plan?.[storeKey("firestore:follow_ups")]).toBe("retained")
    expect(stored?.courtOpsUnlinked).toEqual(expect.arrayContaining([loose, orphan]))
  }, 120_000)

  it("DEL-264-R2-001: deleting X keeps Y's rows when Y is approved, held, and halted, and when Y's own plan is not purge", async () => {
    const { db, firmId, matterId, requestId } = await opened()
    const held = uniq("heldy")
    const retained = uniq("retny")
    const heldRequest = uniq("heldreq")
    const retainedRequest = uniq("retreq")
    await db.collection(DELETION_REQUESTS_COLLECTION).doc(heldRequest).set({
      firmId, matterId: held, status: "in_progress", plan: PURGE, halted: { code: "legal_hold_active" },
    })
    await db.collection(DELETION_REQUESTS_COLLECTION).doc(retainedRequest).set({
      firmId, matterId: retained, status: "in_progress", plan: RETAIN,
    })
    await db.collection(LEGAL_HOLDS_COLLECTION).doc(held).set({ firmId, active: true })
    await db.collection(MATTER_TOMBSTONES).doc(held).set({ firmId, matterId: held, requestId: heldRequest })
    await db.collection(MATTER_TOMBSTONES).doc(retained).set({ firmId, matterId: retained, requestId: retainedRequest })
    const heldItem = uniq("helddoc")
    const retainedItem = uniq("retdoc")
    await db.collection("document_workflow").doc(heldItem).set({ documentId: heldItem, firmId, matterId: held })
    await db.collection("document_workflow").doc(retainedItem).set({ documentId: retainedItem, firmId, matterId: retained })
    const heldAck = `ops:court_ops:ack:${firmId}:workflow:${heldItem}`
    const retainedAck = `ops:court_ops:ack:${firmId}:workflow:${retainedItem}`
    await db.collection("workflow_ops_activity").doc(heldAck).set({
      firmId, matterId: null, documentId: heldItem, queueType: "workflow", action: "court_ops_acknowledge", source: "court_ops",
    })
    await db.collection("workflow_ops_activity").doc(retainedAck).set({
      firmId, matterId: null, documentId: retainedItem, queueType: "workflow", action: "court_ops_acknowledge", source: "court_ops",
    })
    const result = await reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId })
    expect(result.removed).toBe(0)
    expect((await db.collection("workflow_ops_activity").doc(heldAck).get()).get("matterId")).toBe(held)
    expect((await db.collection("workflow_ops_activity").doc(retainedAck).get()).get("matterId")).toBe(retained)
    const request = (await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).get()).data()
    expect(request?.courtOpsUnlinkedReasons?.[heldAck]).toBe("tombstoned")
    expect(request?.courtOpsUnlinkedReasons?.[retainedAck]).toBe("tombstoned")
  })

  it("CAP-264-R2-003: eleven thousand unlinked ids are stored off the request and the reach finishes", async () => {
    const { db, firmId, matterId, requestId } = await opened()
    const n = 11_000
    const ids = Array.from({ length: n }, (_, i) => `k${String(i).padStart(5, "0")}${firmId}`)
    for (let start = 0; start < n; start += 400) {
      const batch = db.batch()
      for (const id of ids.slice(start, start + 400)) batch.set(db.collection("follow_ups").doc(id), { firmId, matterId: null, raw: "k" })
      await batch.commit()
    }
    const result = await reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId })
    expect(result.removed).toBe(0)
    expect(result.reported).toBe(n)
    const request = (await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).get()).data()
    expect(request?.courtOpsUnlinked).toHaveLength(courtOpsUnlinkedSample())
    expect(request?.courtOpsUnlinkedCount).toBe(n)
    expect(request?.courtOpsUnlinkedTruncated).toBe(true)
    const stored = new Set<string>()
    const chunks = await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).collection(courtOpsUnlinkedCollection()).get()
    for (const doc of chunks.docs) for (const id of doc.get("ids") as string[]) stored.add(id)
    expect(stored.size).toBe(n)
    expect(stored.has(ids[0])).toBe(true)
    expect(stored.has(ids[n - 1])).toBe(true)
    expect((await db.collection("follow_ups").doc(ids[n - 1]).get()).exists).toBe(true)
  }, 240_000)

  it("R2-004: a request with the wrong firm, matter, or status changes nothing", async () => {
    const { db, firmId, matterId, requestId } = await opened()
    const id = uniq("guard")
    await db.collection("follow_ups").doc(id).set({ firmId, matterId: null, raw: "x" })
    const reach = () => reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId })
    await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).set({ firmId: uniq("other"), matterId, status: "in_progress", plan: PURGE })
    await expect(reach()).rejects.toMatchObject({ code: "deletion_request_invalid" })
    await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).set({ firmId, matterId: uniq("other"), status: "in_progress", plan: PURGE })
    await expect(reach()).rejects.toMatchObject({ code: "deletion_request_invalid" })
    await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).set({ firmId, matterId, status: "completed", plan: PURGE })
    await expect(reach()).rejects.toMatchObject({ code: "deletion_request_invalid" })
    expect((await db.collection("follow_ups").doc(id).get()).get("matterId")).toBeNull()
    expect((await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).get()).get("courtOpsUnlinked")).toBeUndefined()
  })

  it("C2: an acknowledgement whose parent matterId is empty is recorded, not stamped", async () => {
    const { db, firmId, matterId, requestId } = await opened()
    const parent = uniq("blank")
    await db.collection("follow_ups").doc(parent).set({ firmId, matterId: "", raw: "blank parent" })
    const ack = `ops:court_ops:ack:${firmId}:follow_up:${parent}`
    await db.collection("workflow_ops_activity").doc(ack).set({
      firmId, matterId: null, followUpId: parent, queueType: "follow_up", action: "court_ops_acknowledge", source: "court_ops",
    })
    await reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId })
    expect((await db.collection("workflow_ops_activity").doc(ack).get()).get("matterId")).toBeNull()
    const request = (await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).get()).data()
    expect(request?.courtOpsUnlinkedReasons?.[ack]).toBe("matter_unbound")
  })

  it("A3: the deleting matter's hold is read inside the page transaction", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/retention/courtOpsDeletionReach.ts"), "utf8")
    const page = src.slice(src.indexOf("return input.db.runTransaction"), src.indexOf("function writeCourtOpsPage"))
    expect(page).toContain("const hold = await tx.get(input.db.collection(LEGAL_HOLDS_COLLECTION).doc(input.deletingMatterId))")
    expect(page).not.toContain(".doc(input.deletingMatterId).get()")
  })

  it("B9: prepare keeps the fenced court-ops-reach hold check", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/retention/saga.ts"), "utf8")
    const prep = src.slice(src.indexOf("async function prepareSteps"), src.indexOf("async function halt"))
    const step = prep.indexOf('"court-ops-reach"')
    expect(step).toBeGreaterThan(prep.indexOf("reachCourtOpsDeletion"))
    expect(prep.slice(step, step + 220)).toContain("assertNoHold(tx, firmId, req.matterId)")
  })

  it("A27: a reach failure fails the prepare job and enqueues no purge", async () => {
    const { db, firmId, matterId, requestId } = await opened()
    await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).set({
      firmId, matterId, status: "in_progress", approvedAt: Timestamp.now(), plan: PURGE, expected: [], acked: {},
    })
    const enqueued = await db.runTransaction((tx) => enqueueJob(tx, {
      firmId, jobType: PREPARE_JOB_TYPE, classification: "internal", matterId: null,
      payload: { requestId }, idempotencyKey: `${requestId}:prepare`, createdBy: "system",
    }, { now: Date.now() }))
    seam.failCourtOpsReach = true
    const queued = await db.collection("jobs").doc(enqueued.jobId).get()
    const outcome = await runJobTask({ jobId: enqueued.jobId, seq: queued.get("dispatchSeq") as number }, testDeps(new FakeClock(Date.now())))
    expect(outcome).not.toBe("done")
    const job = await db.collection("jobs").doc(enqueued.jobId).get()
    expect(job.get("lastError")?.code).toBe("court_ops_reach_failed")
    const purges = await db.collection("jobs").where("firmId", "==", firmId).where("jobType", "==", PURGE_JOB_TYPE).get()
    expect(purges.empty).toBe(true)
  })
})
