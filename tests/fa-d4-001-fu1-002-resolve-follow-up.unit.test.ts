// FA-D4-001-FU1-002: resolve_follow_up writes the follow-up with a blind upsert. A second resolve,
// a concurrent resolve, a missing row, a foreign firm and a matter the caller cannot access must
// refuse and leave the stored row as it was. The valid first resolve of an open row stays.
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { POST } from "@/app/api/d2/court-ops/route"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { uploadDocument } from "@/services/d1-6/uploadDocument"
import { recordCaseNumber } from "@/services/d6-1/caseNumber"
import { transitionWorkflowStatus } from "@/services/d1-7/documentWorkflow"
import { decideFollowUpResolution, FollowUpResolveRefusedError } from "@/platform/persistence/courtOpsFollowUpResolve"
import type { FollowUp } from "@/platform/spine/store"

const NOT_FOUND_BODY = { error: "follow_up not found", code: "follow_up_not_found" }

afterEach(() => {
  resetRuntimeStoreForTests()
  resetIdempotencyForTests()
})

function post(body: unknown, key = randomUUID()) {
  return POST(
    new Request("http://127.0.0.1/api/d2/court-ops", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    })
  )
}

async function seedOpenFollowUp(): Promise<FollowUp> {
  const store = getRuntimeStore()
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title: "Ops matter",
    courtId: "SHC",
    classification: "internal",
  })
  addMember(store, matter.id, "partner_a", "firmA")
  addMember(store, matter.id, "associate_a", "firmA")
  recordCaseNumber(store, matter.id, "CP 1234", "SHC")
  const write = await uploadDocument(store, {
    firmId: "firmA",
    matterId: matter.id,
    bytes: Buffer.from("%PDF-workflow-blocker%"),
    sourceChannel: "web",
    classification: "internal",
    idempotencyKey: randomUUID(),
    uploadedBy: "partner_a",
  })
  transitionWorkflowStatus(store, {
    actorId: "associate_a",
    documentId: write.docId,
    nextStatus: "processing",
  })
  transitionWorkflowStatus(store, {
    actorId: "associate_a",
    documentId: write.docId,
    nextStatus: "review_required",
  })
  const follow = store.followUps.find((row) => row.kind === "case_number_reject")
  if (!follow) throw new Error("seed did not create a case_number_reject follow-up")
  return follow
}

function resolveBody(followUpId: string, actorId = "partner_a", reason?: string) {
  return { action: "resolve_follow_up", actorId, followUpId, ...(reason === undefined ? {} : { reason }) }
}

function resolutionAudits() {
  return getRuntimeStore().audit.filter((row) => row.action === "court_ops_resolve_follow_up")
}

function activityOf(followUpId: string) {
  return getRuntimeStore().workflowOpsActivity.get(`ops:court_ops:follow_up:${followUpId}`)
}

describe("FA-D4-001-FU1-002 resolve_follow_up (memory)", () => {
  it("resolves an open follow-up the caller may resolve", async () => {
    const follow = await seedOpenFollowUp()
    const res = await post(resolveBody(follow.id, "partner_a", "cleared"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { action: string; followUpId: string }; reused: boolean }
    expect(body.result).toEqual({ action: "resolve_follow_up", followUpId: follow.id })
    expect(body.reused).toBe(false)
    const stored = getRuntimeStore().followUps.find((row) => row.id === follow.id)
    expect(stored?.status).toBe("resolved")
    expect(stored?.resolvedBy).toBe("partner_a")
    expect(typeof stored?.resolvedAt).toBe("number")
    expect(stored?.firmId).toBe(follow.firmId)
    expect(stored?.matterId).toBe(follow.matterId)
    expect(stored?.raw).toBe(follow.raw)
    expect(activityOf(follow.id)?.detail).toBe("cleared")
    expect(resolutionAudits()).toHaveLength(1)
  })

  it("refuses a missing follow-up and does not create one", async () => {
    await seedOpenFollowUp()
    const before = getRuntimeStore().followUps.map((row) => ({ ...row }))
    const res = await post(resolveBody("fu_does_not_exist"))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NOT_FOUND_BODY)
    expect(getRuntimeStore().followUps.map((row) => ({ ...row }))).toEqual(before)
    expect(resolutionAudits()).toHaveLength(0)
    expect(activityOf("fu_does_not_exist")).toBeUndefined()
  })

  it("refuses a resolver from another firm and does not resolve the row", async () => {
    const follow = await seedOpenFollowUp()
    const res = await post(resolveBody(follow.id, "partner_b", "not yours"))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NOT_FOUND_BODY)
    const stored = getRuntimeStore().followUps.find((row) => row.id === follow.id)
    expect(stored?.status).toBe("open")
    expect(stored?.resolvedBy ?? null).toBeNull()
    expect(resolutionAudits()).toHaveLength(0)
    expect(activityOf(follow.id)).toBeUndefined()
  })

  it("refuses a caller who cannot access the follow-up's matter and does not resolve it", async () => {
    const store = getRuntimeStore()
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "client_a",
      title: "Hidden matter",
      courtId: "SHC",
      classification: "internal",
    })
    const follow: FollowUp = {
      id: "fu_hidden_matter",
      firmId: "firmA",
      matterId: matter.id,
      courtId: "SHC",
      raw: "do not touch",
      kind: "case_number_reject",
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
    }
    store.followUps.push(follow)
    const res = await post(resolveBody(follow.id, "partner_a", "no"))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(NOT_FOUND_BODY)
    const stored = store.followUps.find((row) => row.id === follow.id)
    expect(stored).toMatchObject({ status: "open", raw: "do not touch", matterId: matter.id, resolvedBy: null, resolvedAt: null })
    expect(resolutionAudits()).toHaveLength(0)
    expect(activityOf(follow.id)).toBeUndefined()
  })

  it("refuses a second resolve and does not rewrite the first resolution or its activity row", async () => {
    const follow = await seedOpenFollowUp()
    const first = await post(resolveBody(follow.id, "partner_a", "first"))
    expect(first.status).toBe(200)
    const resolved = getRuntimeStore().followUps.find((row) => row.id === follow.id)
    const resolvedAt = resolved?.resolvedAt
    const resolvedBy = resolved?.resolvedBy
    const detail = activityOf(follow.id)?.detail
    const second = await post(resolveBody(follow.id, "associate_a", "second"))
    expect(second.status).toBe(409)
    const body = (await second.json()) as { code?: string; reason?: string }
    expect(body.code).toBe("follow_up_already_resolved")
    expect(body.reason).toBe("already_resolved")
    const stored = getRuntimeStore().followUps.find((row) => row.id === follow.id)
    expect(stored?.status).toBe("resolved")
    expect(stored?.resolvedAt).toBe(resolvedAt)
    expect(stored?.resolvedBy).toBe(resolvedBy)
    expect(activityOf(follow.id)?.detail).toBe(detail)
    expect(resolutionAudits()).toHaveLength(1)
    expect(resolutionAudits()[0]?.actorId).toBe("partner_a")
  })

  it("lets only one of two concurrent resolves commit", async () => {
    const follow = await seedOpenFollowUp()
    const [left, right] = await Promise.all([
      post(resolveBody(follow.id, "partner_a", "left")),
      post(resolveBody(follow.id, "partner_a", "right")),
    ])
    const statuses = [left.status, right.status].sort((a, b) => a - b)
    expect(statuses).toEqual([200, 409])
    const stored = getRuntimeStore().followUps.find((row) => row.id === follow.id)
    expect(stored?.status).toBe("resolved")
    expect(stored?.resolvedBy).toBe("partner_a")
    const detail = activityOf(follow.id)?.detail
    expect(detail === "left" || detail === "right").toBe(true)
    expect(resolutionAudits()).toHaveLength(1)
    const loser = left.status === 409 ? left : right
    const loserBody = (await loser.json()) as { code?: string; reason?: string }
    expect(loserBody.code).toBe("follow_up_already_resolved")
    expect(loserBody.reason).toBe("already_resolved")
  })

  it("answers a missing row, another firm, and a hidden matter with one identical 404", async () => {
    const follow = await seedOpenFollowUp()
    const hiddenMatter = createMatter(getRuntimeStore(), {
      firmId: "firmA",
      clientId: "client_a",
      title: "Hidden",
      courtId: "SHC",
      classification: "internal",
    })
    getRuntimeStore().followUps.push({
      id: "fu_hidden_same_body",
      firmId: "firmA",
      matterId: hiddenMatter.id,
      courtId: "SHC",
      raw: "hidden",
      kind: "case_number_reject",
      status: "open",
    })
    const missing = await (await post(resolveBody("fu_absent"))).json()
    const foreign = await (await post(resolveBody(follow.id, "partner_b"))).json()
    const hidden = await (await post(resolveBody("fu_hidden_same_body"))).json()
    expect(missing).toEqual(NOT_FOUND_BODY)
    expect(foreign).toEqual(missing)
    expect(hidden).toEqual(missing)
  })

  it("answers a hidden follow-up that is already resolved with the same 404", async () => {
    const store = getRuntimeStore()
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "client_a",
      title: "Hidden resolved",
      courtId: "SHC",
      classification: "internal",
    })
    store.followUps.push({
      id: "fu_hidden_resolved",
      firmId: "firmA",
      matterId: matter.id,
      courtId: "SHC",
      raw: "keep",
      kind: "case_number_reject",
      status: "resolved",
      resolvedBy: "earlier-actor",
      resolvedAt: 111,
    })
    const missing = await post(resolveBody("fu_absent_hidden"))
    const hidden = await post(resolveBody("fu_hidden_resolved", "partner_a", "leak"))
    expect(hidden.status).toBe(missing.status)
    expect(hidden.status).toBe(404)
    expect(await hidden.json()).toEqual(await missing.json())
    expect(store.followUps.find((row) => row.id === "fu_hidden_resolved")).toMatchObject({
      status: "resolved",
      resolvedBy: "earlier-actor",
      resolvedAt: 111,
      raw: "keep",
    })
    expect(resolutionAudits()).toHaveLength(0)
    expect(activityOf("fu_hidden_resolved")).toBeUndefined()
  })

  it("resolves a legacy follow-up that has no status", async () => {
    const follow = await seedOpenFollowUp()
    const stored = getRuntimeStore().followUps.find((row) => row.id === follow.id)
    if (!stored) throw new Error("seeded follow-up missing")
    delete stored.status
    const res = await post(resolveBody(follow.id, "partner_a", "legacy"))
    expect(res.status).toBe(200)
    expect(stored.status).toBe("resolved")
    expect(stored.resolvedBy).toBe("partner_a")
    expect(activityOf(follow.id)?.detail).toBe("legacy")
  })

  it("refuses an unknown kind and does not resolve the row", async () => {
    const follow = await seedOpenFollowUp()
    const stored = getRuntimeStore().followUps.find((row) => row.id === follow.id)
    if (!stored) throw new Error("seeded follow-up missing")
    ;(stored as { kind: string }).kind = "not_a_kind"
    const res = await post(resolveBody(follow.id, "partner_a", "no"))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code?: string; reason?: string }
    expect(body.code).toBe("follow_up_not_resolvable")
    expect(body.reason).toBe("not_resolvable")
    expect(stored.status).toBe("open")
    expect(resolutionAudits()).toHaveLength(0)
    expect(activityOf(follow.id)).toBeUndefined()
  })

  it("writes the activity row again when the same resolver retries and the row is missing", async () => {
    const follow = await seedOpenFollowUp()
    const first = await post(resolveBody(follow.id, "partner_a", "first"))
    expect(first.status).toBe(200)
    const resolvedAt = getRuntimeStore().followUps.find((row) => row.id === follow.id)?.resolvedAt
    getRuntimeStore().workflowOpsActivity.delete(`ops:court_ops:follow_up:${follow.id}`)
    const retry = await post(resolveBody(follow.id, "partner_a", "again"))
    expect(retry.status).toBe(200)
    const stored = getRuntimeStore().followUps.find((row) => row.id === follow.id)
    expect(stored?.resolvedAt).toBe(resolvedAt)
    expect(stored?.resolvedBy).toBe("partner_a")
    expect(activityOf(follow.id)?.detail).toBe("again")
    expect(resolutionAudits()).toHaveLength(1)
  })
})

describe("FA-D4-001-FU1-002 decideFollowUpResolution", () => {
  const caller = {
    firmId: "firmA",
    actorId: "partner_a",
    resolvedAt: 5,
    matterAllowed: () => true,
  }
  const openRow = {
    id: "fu_decide",
    firmId: "firmA",
    matterId: "matter_a",
    courtId: "SHC",
    raw: "raw",
    kind: "case_number_reject",
    status: "open",
  }

  it("refuses a stored id that is not the document id", () => {
    expect(() => decideFollowUpResolution("fu_decide", { ...openRow, id: "other-id" }, caller)).toThrow(
      FollowUpResolveRefusedError
    )
    try {
      decideFollowUpResolution("fu_decide", { ...openRow, id: "other-id" }, caller)
    } catch (err) {
      expect(err).toBeInstanceOf(FollowUpResolveRefusedError)
      expect((err as FollowUpResolveRefusedError).reason).toBe("not_resolvable")
    }
  })

  it("refuses a blank actor and a non-finite resolvedAt", () => {
    expect(() => decideFollowUpResolution("fu_decide", openRow, { ...caller, actorId: "" })).toThrow(
      FollowUpResolveRefusedError
    )
    try {
      decideFollowUpResolution("fu_decide", openRow, { ...caller, actorId: "" })
    } catch (err) {
      expect((err as FollowUpResolveRefusedError).reason).toBe("not_resolvable")
    }
    expect(() => decideFollowUpResolution("fu_decide", openRow, { ...caller, resolvedAt: Number.NaN })).toThrow(
      FollowUpResolveRefusedError
    )
  })
})
