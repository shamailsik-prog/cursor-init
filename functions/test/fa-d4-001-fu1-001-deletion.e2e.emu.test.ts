import { afterEach, describe, expect, it } from "vitest"
import { MATTER_TOMBSTONES } from "@/platform/retention/tombstone"
import { adminDb } from "../src/admin"
import { JobError } from "../src/p2/errors"
import { reachCourtOpsDeletion } from "../src/retention/courtOpsDeletionReach"
import { DELETION_REQUESTS_COLLECTION, LEGAL_HOLDS_COLLECTION } from "../src/retention/model"
import { EMULATORS, uniq } from "./emu"
import { deleteFirmScopedData } from "./firmCleanup"

/**
 * FA-D4-001-FU1-001: legacy follow-ups and court-ops acknowledgements stored with matterId null are
 * bound, or removed and reported, before F42 enqueues the purge. Firm-level workflow acknowledgements stay.
 */

describe.skipIf(!EMULATORS)("FA-D4-001-FU1-001 deletion reach", () => {
  const firms: string[] = []

  afterEach(async () => {
    if (firms.length === 0) return
    await deleteFirmScopedData(firms.splice(0))
  })

  async function opened() {
    const db = adminDb()
    const firmId = uniq("fu1001")
    firms.push(firmId)
    const matterId = uniq("m")
    const requestId = uniq("req")
    await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).set({ firmId, matterId, status: "in_progress" })
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

  it("deletes an unbound follow-up and records its id on the deletion request", async () => {
    const { db, firmId, matterId, requestId } = await opened()
    const id = uniq("loose")
    await db.collection("follow_ups").doc(id).set({ firmId, matterId: null, raw: "unbound" })
    const result = await reachCourtOpsDeletion({ db, firmId, deletingMatterId: matterId, requestId })
    expect(result.removed).toBe(1)
    expect((await db.collection("follow_ups").doc(id).get()).exists).toBe(false)
    const request = (await db.collection(DELETION_REQUESTS_COLLECTION).doc(requestId).get()).data()
    expect(request?.courtOpsUnlinked).toContain(id)
    expect(request?.courtOpsUnlinkedCount).toBe(1)
  })

  it("stamps an acknowledgement of another live matter and deletes one whose matter is already tombstoned", async () => {
    const { db, firmId, matterId, requestId } = await opened()
    const live = uniq("live")
    const gone = uniq("gone")
    const liveItem = uniq("doc")
    const goneItem = uniq("doc")
    await db.collection("document_workflow").doc(liveItem).set({ documentId: liveItem, firmId, matterId: live })
    await db.collection("document_workflow").doc(goneItem).set({ documentId: goneItem, firmId, matterId: gone })
    await db.collection(MATTER_TOMBSTONES).doc(gone).set({ firmId, matterId: gone })
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
})
