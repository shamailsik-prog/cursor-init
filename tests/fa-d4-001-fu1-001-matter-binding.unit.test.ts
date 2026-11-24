// FA-D4-001-FU1-001: a follow-up or court-ops acknowledgement that belongs to a matter must not persist
// with matterId null, and a legacy null row is reachable by F42 only when deletion can link it to its parent.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CourtOpsAckRefusedError, courtOpsAckId } from "@/platform/persistence/courtOpsAcknowledgement"
import {
  CourtOpsMatterUnboundError,
  courtOpsParentRef,
  decideCourtOpsReach,
  deriveCourtOpsAckMatter,
} from "@/platform/persistence/courtOpsMatterBinding"
import { createMemoryRepositories } from "@/platform/persistence/spineRepositories"
import { SpineStore, type WorkflowOpsActivityRow } from "@/platform/spine/store"

const F = "firmA"
const MATTER = "matter_a"
const OTHER = "matter_b"
const X = "doc_1"
const FU = "fu_1"

function ackRow(firmId: string, queueType: "workflow" | "follow_up", item: string, extra: Partial<WorkflowOpsActivityRow> = {}): WorkflowOpsActivityRow {
  return {
    id: courtOpsAckId(firmId, queueType, item),
    firmId,
    source: "court_ops",
    action: "court_ops_acknowledge",
    actorId: `u_${firmId}`,
    classification: "internal",
    matterId: null,
    documentId: queueType === "workflow" ? item : null,
    followUpId: queueType === "follow_up" ? item : null,
    queueType,
    status: "acknowledged",
    detail: "seen",
    tags: ["court", "ops"],
    createdAt: 100,
    ...extra,
  }
}

describe("FA-D4-001-FU1-001 deriveCourtOpsAckMatter", () => {
  it("stamps a follow-up acknowledgement with the parent follow-up's matter", () => {
    expect(deriveCourtOpsAckMatter({
      queueType: "follow_up",
      suppliedMatterId: null,
      firmId: F,
      parent: { firmId: F, matterId: MATTER },
    })).toBe(MATTER)
  })

  it("stamps a workflow acknowledgement with the parent document's matter", () => {
    expect(deriveCourtOpsAckMatter({
      queueType: "workflow",
      suppliedMatterId: null,
      firmId: F,
      parent: { firmId: F, matterId: MATTER },
    })).toBe(MATTER)
  })

  it("leaves a firm-level workflow acknowledgement unbound when its parent has no matter", () => {
    expect(deriveCourtOpsAckMatter({
      queueType: "workflow",
      suppliedMatterId: null,
      firmId: F,
      parent: { firmId: F, matterId: null },
    })).toBeNull()
  })

  it("refuses a follow-up acknowledgement whose parent is missing or has no matter", () => {
    expect(() => deriveCourtOpsAckMatter({
      queueType: "follow_up",
      suppliedMatterId: null,
      firmId: F,
      parent: null,
    })).toThrow(CourtOpsMatterUnboundError)
    expect(() => deriveCourtOpsAckMatter({
      queueType: "follow_up",
      suppliedMatterId: null,
      firmId: F,
      parent: { firmId: F, matterId: null },
    })).toThrow(CourtOpsMatterUnboundError)
  })

  it("refuses a matterId that disagrees with the parent", () => {
    expect(() => deriveCourtOpsAckMatter({
      queueType: "follow_up",
      suppliedMatterId: OTHER,
      firmId: F,
      parent: { firmId: F, matterId: MATTER },
    })).toThrow(CourtOpsMatterUnboundError)
  })

  it("refuses a parent stamped with another firm", () => {
    expect(() => deriveCourtOpsAckMatter({
      queueType: "workflow",
      suppliedMatterId: null,
      firmId: F,
      parent: { firmId: "firmB", matterId: MATTER },
    })).toThrow(CourtOpsMatterUnboundError)
  })
})

describe("FA-D4-001-FU1-001 memory writers", () => {
  it("persists a follow-up acknowledgement with the follow-up's matterId", async () => {
    const store = new SpineStore()
    store.followUps.push({
      id: FU, firmId: F, matterId: MATTER, courtId: "SHC", raw: "CP 1", kind: "case_number_reject", status: "open",
    })
    const repos = createMemoryRepositories(store)
    const written = await repos.workflowOpsActivity.recordCourtOpsAcknowledgement(F, ackRow(F, "follow_up", FU))
    expect(written.matterId).toBe(MATTER)
    expect(store.workflowOpsActivity.get(written.id)?.matterId).toBe(MATTER)
  })

  it("persists a workflow acknowledgement with the document workflow's matterId", async () => {
    const store = new SpineStore()
    store.documentWorkflow.set(X, {
      documentId: X, firmId: F, matterId: MATTER, status: "review_required", reviewerId: null, updatedAt: 1,
    })
    const repos = createMemoryRepositories(store)
    const written = await repos.workflowOpsActivity.recordCourtOpsAcknowledgement(F, ackRow(F, "workflow", X))
    expect(written.matterId).toBe(MATTER)
  })

  it("refuses a follow-up upsert that has no matterId", async () => {
    const repos = createMemoryRepositories(new SpineStore())
    await expect(repos.followUps.upsert({
      id: FU, firmId: F, matterId: "" as unknown as string, courtId: "SHC", raw: "x", kind: "case_number_reject",
    })).rejects.toBeInstanceOf(CourtOpsMatterUnboundError)
  })

  it("still refuses a planted foreign acknowledgement after the parent is present", async () => {
    const store = new SpineStore()
    store.documentWorkflow.set("doc_2", {
      documentId: "doc_2", firmId: F, matterId: null, status: "review_required", reviewerId: null, updatedAt: 1,
    })
    const repos = createMemoryRepositories(store)
    const foreign = { ...ackRow("firmB", "workflow", "doc_2"), id: courtOpsAckId(F, "workflow", "doc_2") }
    store.workflowOpsActivity.set(foreign.id, foreign)
    await expect(repos.workflowOpsActivity.recordCourtOpsAcknowledgement(F, ackRow(F, "workflow", "doc_2"))).rejects.toBeInstanceOf(CourtOpsAckRefusedError)
    expect(store.workflowOpsActivity.get(foreign.id)?.firmId).toBe("firmB")
  })
})

describe("FA-D4-001-FU1-001 deletion reach", () => {
  it("links a null acknowledgement through its follow-up id", () => {
    const id = courtOpsAckId(F, "follow_up", FU)
    expect(courtOpsParentRef(id, { followUpId: FU, queueType: "follow_up" })).toEqual({ collection: "follow_ups", id: FU })
    expect(decideCourtOpsReach({
      collection: "workflow_ops_activity",
      id,
      row: { firmId: F, matterId: null, followUpId: FU, queueType: "follow_up", action: "court_ops_acknowledge", source: "court_ops" },
      parent: { firmId: F, matterId: MATTER },
    })).toEqual({ action: "stamp", matterId: MATTER })
  })

  it("links a legacy null acknowledgement id through the workflow parent", () => {
    const id = "ops:court_ops:ack:workflow:doc_9"
    expect(decideCourtOpsReach({
      collection: "workflow_ops_activity",
      id,
      row: { firmId: F, matterId: null, action: "court_ops_acknowledge", source: "court_ops" },
      parent: { firmId: F, matterId: MATTER },
    })).toEqual({ action: "stamp", matterId: MATTER })
  })

  it("leaves a firm-level workflow acknowledgement live", () => {
    expect(decideCourtOpsReach({
      collection: "workflow_ops_activity",
      id: courtOpsAckId(F, "workflow", X),
      row: { firmId: F, matterId: null, documentId: X, queueType: "workflow", action: "court_ops_acknowledge", source: "court_ops" },
      parent: { firmId: F, matterId: null },
    })).toEqual({ action: "leave" })
  })

  it("reports a follow-up with no matter and an acknowledgement with no parent", () => {
    expect(decideCourtOpsReach({
      collection: "follow_ups",
      id: FU,
      row: { firmId: F, matterId: null },
      parent: null,
    })).toEqual({ action: "report", reason: "matter_unbound" })
    expect(decideCourtOpsReach({
      collection: "workflow_ops_activity",
      id: "ops:court_ops:ack:follow_up:missing",
      row: { firmId: F, matterId: null, action: "court_ops_acknowledge", source: "court_ops" },
      parent: null,
    })).toEqual({ action: "report", reason: "parent_missing" })
  })

  it("A29: a parent with no firmId is refused", () => {
    expect(() => deriveCourtOpsAckMatter({
      queueType: "workflow",
      suppliedMatterId: null,
      firmId: F,
      parent: { matterId: MATTER },
    })).toThrow(CourtOpsMatterUnboundError)
  })

  it("A9: an acknowledgement whose parent is another firm's is reported, not stamped", () => {
    expect(decideCourtOpsReach({
      collection: "workflow_ops_activity",
      id: courtOpsAckId(F, "workflow", X),
      row: { firmId: F, matterId: null, documentId: X, queueType: "workflow", action: "court_ops_acknowledge", source: "court_ops" },
      parent: { firmId: "firmB", matterId: MATTER },
    })).toEqual({ action: "report", reason: "parent_other_firm" })
  })

  it("does not treat an ordinary workflow event as a court-ops row", () => {
    expect(decideCourtOpsReach({
      collection: "workflow_ops_activity",
      id: "ops:workflow_event:wfe_1",
      row: { firmId: F, matterId: null, source: "workflow_event", action: "workflow_transition" },
      parent: null,
    })).toEqual({ action: "leave" })
  })

  it("prepare reaches court-ops rows before it enqueues purge jobs", () => {
    const src = readFileSync("functions/src/retention/saga.ts", "utf8")
    const prep = src.slice(src.indexOf("async function prepareSteps"), src.indexOf("async function halt"))
    const reach = prep.indexOf("reachCourtOpsDeletion")
    const enqueue = prep.indexOf("enqueueJobs")
    expect(reach).toBeGreaterThan(0)
    expect(enqueue).toBeGreaterThan(reach)
  })

  it("C2: an empty matterId is unbound", () => {
    expect(decideCourtOpsReach({
      collection: "workflow_ops_activity",
      id: `ops:court_ops:ack:${F}:follow_up:${X}`,
      row: { firmId: F, matterId: "", followUpId: X, queueType: "follow_up", action: "court_ops_acknowledge", source: "court_ops" },
      parent: { firmId: F, matterId: "" },
    })).toEqual({ action: "report", reason: "matter_unbound" })
  })

  it("B9: prepare keeps the fenced court-ops-reach hold check", () => {
    const src = readFileSync("functions/src/retention/saga.ts", "utf8")
    const prep = src.slice(src.indexOf("async function prepareSteps"), src.indexOf("async function halt"))
    const step = prep.indexOf('"court-ops-reach"')
    expect(step).toBeGreaterThan(prep.indexOf("reachCourtOpsDeletion"))
    expect(prep.slice(step, step + 220)).toContain("assertNoHold(tx, firmId, req.matterId)")
  })

  it("A3: the deleting matter's hold is read inside the page transaction", () => {
    const src = readFileSync("functions/src/retention/courtOpsDeletionReach.ts", "utf8")
    const page = src.slice(src.indexOf("return input.db.runTransaction"), src.indexOf("function writeCourtOpsPage"))
    expect(page).toContain("const hold = await tx.get(input.db.collection(LEGAL_HOLDS_COLLECTION).doc(input.deletingMatterId))")
    expect(page).not.toContain(".doc(input.deletingMatterId).get()")
  })
})
