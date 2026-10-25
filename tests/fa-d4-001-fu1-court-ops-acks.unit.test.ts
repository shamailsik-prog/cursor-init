// Audit FA-D4-001-FU1: the court-ops acknowledgement id, the one validator of a stored ack row, the transactional
// writer's decision, and the memory repository (spec R2, R3, R5, R6, R11).
import { describe, expect, it } from "vitest"
import {
  COURT_OPS_ACK_ITEM_ID_MAX_BYTES,
  CourtOpsAckIdError,
  CourtOpsAckRefusedError,
  courtOpsAckId,
  courtOpsAckItemIdProblem,
  isCourtOpsAckQueueType,
  legacyCourtOpsAckId,
  nextCourtOpsAckRow,
  readCourtOpsAckRow,
  readLegacyCourtOpsAckRow,
} from "@/platform/persistence/courtOpsAcknowledgement"
import { createMemoryRepositories } from "@/platform/persistence/spineRepositories"
import { SpineStore, type WorkflowOpsActivityRow } from "@/platform/spine/store"

const F = "firmA"
const G = "firmB"
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

describe("court-ops ack id (R3, R5)", () => {
  it("is ops:court_ops:ack:{firmId}:{queueType}:{itemId}", () => {
    expect(courtOpsAckId(F, "workflow", X)).toBe("ops:court_ops:ack:firmA:workflow:doc_1")
    expect(courtOpsAckId(F, "follow_up", FU)).toBe("ops:court_ops:ack:firmA:follow_up:fu_1")
    expect(legacyCourtOpsAckId("workflow", X)).toBe("ops:court_ops:ack:workflow:doc_1")
  })

  it.each([
    ["a ':'", "a:b"],
    ["a '/'", "a/b"],
    ["an empty id", ""],
    ["257 bytes", "x".repeat(257)],
    ["258 bytes of two-byte characters", "é".repeat(129)],
  ])("refuses an item id with %s", (_label, item) => {
    expect(courtOpsAckItemIdProblem(item)).not.toBeNull()
    expect(() => courtOpsAckId(F, "workflow", item)).toThrow(CourtOpsAckIdError)
  })

  it("accepts an item id of exactly the byte limit, and refuses a non-string", () => {
    expect(COURT_OPS_ACK_ITEM_ID_MAX_BYTES).toBe(256)
    expect(courtOpsAckItemIdProblem("x".repeat(256))).toBeNull()
    expect(courtOpsAckItemIdProblem("é".repeat(128))).toBeNull()
    expect(courtOpsAckItemIdProblem(7)).not.toBeNull()
    expect(courtOpsAckItemIdProblem(undefined)).not.toBeNull()
  })

  it.each([["empty", ""], ["padded", " firmA"], ["with ':'", "firm:A"], ["with '/'", "firm/A"]])("refuses a firm id that is %s", (_l, firm) => {
    expect(() => courtOpsAckId(firm, "workflow", X)).toThrow()
  })

  it("accepts exactly the two queue types", () => {
    expect(isCourtOpsAckQueueType("follow_up")).toBe(true)
    expect(isCourtOpsAckQueueType("workflow")).toBe(true)
    for (const v of ["zz", "Workflow", "workflow ", "", null, undefined, 1, "follow-up"]) expect(isCourtOpsAckQueueType(v)).toBe(false)
    expect(() => courtOpsAckId(F, "zz" as never, X)).toThrow(CourtOpsAckIdError)
  })
})

describe("readCourtOpsAckRow: the one validator (R6, R11)", () => {
  it("reads a canonical row; the document id wins over a stored id field", () => {
    const row = ackRow(F, "workflow", X)
    expect(readCourtOpsAckRow(row.id, { ...row, id: "forged" })).toEqual(row)
  })

  it.each<[string, string, Record<string, unknown>]>([
    ["a legacy id", legacyCourtOpsAckId("workflow", X), {}],
    ["an id naming another firm", courtOpsAckId(G, "workflow", X), {}],
    ["an id naming another item", courtOpsAckId(F, "workflow", "doc_2"), {}],
    ["an unknown queue type", courtOpsAckId(F, "workflow", X), { queueType: "zz" }],
    ["a workflow row carrying a followUpId", courtOpsAckId(F, "workflow", X), { followUpId: "fu_9" }],
    ["a non-string detail", courtOpsAckId(F, "workflow", X), { detail: 42 }],
    ["another action", courtOpsAckId(F, "workflow", X), { action: "court_ops_resolve_follow_up" }],
    ["another source", courtOpsAckId(F, "workflow", X), { source: "workflow_event" }],
    ["an unknown classification", courtOpsAckId(F, "workflow", X), { classification: "secret" }],
    ["tags that are not strings", courtOpsAckId(F, "workflow", X), { tags: [1] }],
    ["a non-numeric createdAt", courtOpsAckId(F, "workflow", X), { createdAt: "1" }],
    ["an empty actorId", courtOpsAckId(F, "workflow", X), { actorId: "" }],
  ])("refuses %s", (_label, id, patch) => {
    expect(readCourtOpsAckRow(id, { ...ackRow(F, "workflow", X), ...patch })).toBeNull()
  })

  it("refuses a non-object", () => {
    for (const v of [null, undefined, "x", 1, []]) expect(readCourtOpsAckRow(courtOpsAckId(F, "workflow", X), v)).toBeNull()
  })

  it("readLegacyCourtOpsAckRow reads a legacy row re-keyed to its firm-qualified id, and refuses a canonical id", () => {
    const legacy = { ...ackRow(F, "follow_up", FU), id: legacyCourtOpsAckId("follow_up", FU) }
    expect(readLegacyCourtOpsAckRow(legacy.id, legacy)).toEqual(ackRow(F, "follow_up", FU))
    expect(readLegacyCourtOpsAckRow(courtOpsAckId(F, "follow_up", FU), legacy)).toBeNull()
    expect(readLegacyCourtOpsAckRow(legacyCourtOpsAckId("zz", FU), { ...legacy, queueType: "zz" })).toBeNull()
  })
})

describe("nextCourtOpsAckRow: the writer's decision inside its transaction (R6)", () => {
  const next = ackRow(F, "workflow", X, { detail: "new", createdAt: 200 })

  it("writes the next row when nothing is stored, or over the firm's own previous acknowledgement", () => {
    expect(nextCourtOpsAckRow(F, next, null)).toEqual(next)
    expect(nextCourtOpsAckRow(F, next, undefined)).toEqual(next)
    expect(nextCourtOpsAckRow(F, next, ackRow(F, "workflow", X))).toEqual(next)
  })

  it("refuses a stored row stamped with another firm (foreign_firm), and one that is not canonical (malformed)", () => {
    const foreign = { ...ackRow(G, "workflow", X), id: next.id }
    expect(() => nextCourtOpsAckRow(F, next, foreign)).toThrow(CourtOpsAckRefusedError)
    try {
      nextCourtOpsAckRow(F, next, foreign)
    } catch (err) {
      expect(err).toMatchObject({ code: "court_ops_ack_refused", reason: "foreign_firm", ackId: next.id })
    }
    try {
      nextCourtOpsAckRow(F, next, { ...ackRow(F, "workflow", X), queueType: G })
    } catch (err) {
      expect(err).toMatchObject({ code: "court_ops_ack_refused", reason: "malformed" })
    }
    expect(() => nextCourtOpsAckRow(F, next, { firmId: F })).toThrow(CourtOpsAckRefusedError)
  })

  it("never writes a row of another firm or a row that is not canonical", () => {
    expect(() => nextCourtOpsAckRow(G, next, null)).toThrow(CourtOpsAckIdError)
    expect(() => nextCourtOpsAckRow(F, { ...next, id: legacyCourtOpsAckId("workflow", X) }, null)).toThrow(CourtOpsAckIdError)
    expect(() => nextCourtOpsAckRow(F, { ...next, detail: 1 as never }, null)).toThrow(CourtOpsAckIdError)
  })
})

describe("memory repository workflowOpsActivity (R6, R11)", () => {
  it("records an acknowledgement at its id, and refuses (unchanged) over another firm's row", async () => {
    const store = new SpineStore()
    const repos = createMemoryRepositories(store)
    const row = ackRow(F, "workflow", X)
    expect(await repos.workflowOpsActivity.recordCourtOpsAcknowledgement(F, row)).toEqual(row)
    expect(store.workflowOpsActivity.get(row.id)).toEqual(row)
    const foreign = { ...ackRow(G, "workflow", X), id: courtOpsAckId(F, "workflow", "doc_2") }
    store.workflowOpsActivity.set(foreign.id, foreign)
    await expect(repos.workflowOpsActivity.recordCourtOpsAcknowledgement(F, ackRow(F, "workflow", "doc_2"))).rejects.toBeInstanceOf(CourtOpsAckRefusedError)
    expect(store.workflowOpsActivity.get(foreign.id)).toEqual(foreign)
  })

  it("upsert refuses an acknowledgement id: record is the only writer", async () => {
    const repos = createMemoryRepositories(new SpineStore())
    await expect(repos.workflowOpsActivity.upsert(ackRow(F, "workflow", X))).rejects.toThrow()
    await expect(repos.workflowOpsActivity.upsert({ ...ackRow(F, "workflow", X), id: legacyCourtOpsAckId("workflow", X) })).rejects.toThrow()
  })

  it("get and listByFirm return canonical acknowledgement rows only; other activity rows are unchanged", async () => {
    const store = new SpineStore()
    const repos = createMemoryRepositories(store)
    const canonical = ackRow(F, "workflow", X)
    const legacy = { ...ackRow(F, "follow_up", FU), id: legacyCourtOpsAckId("follow_up", FU) }
    const event = { ...ackRow(F, "workflow", X), id: "ops:workflow_event:wfe_1", source: "workflow_event" as const, action: "workflow_transition" }
    for (const r of [canonical, legacy, event]) store.workflowOpsActivity.set(r.id, r)
    expect(await repos.workflowOpsActivity.get(canonical.id, F)).toEqual(canonical)
    expect(await repos.workflowOpsActivity.get(canonical.id, G)).toBeNull()
    expect(await repos.workflowOpsActivity.get(legacy.id, F)).toBeNull()
    expect(await repos.workflowOpsActivity.get(event.id, F)).toEqual(event)
    expect((await repos.workflowOpsActivity.listByFirm(F)).map((r) => r.id).sort()).toEqual([canonical.id, event.id].sort())
  })
})
