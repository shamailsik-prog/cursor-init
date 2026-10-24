import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { afterEach, describe, expect, it, vi } from "vitest"
import shippedPolicy from "@/infra/retention/policy.json"
import inventory from "@/infra/retention/inventory.json"
import { canonicalMatterDocument } from "@/platform/d1/matterDocument"
import { adminDb } from "../src/admin"
import { ROUTES, createRouter } from "../src/http/router"
import { retentionTestSeam, storeKey, type RetentionPolicy } from "../src/retention/config"
import { enqueueJob } from "../src/p2/enqueue"
import { runJobTask } from "../src/p2/worker"
import { apiErrorOf, viaApi, ApiError } from "./api"
import { EMULATORS, mintIdToken, mockRes, uniq } from "./emu"
import { FakeClock, testDeps } from "./jobs"

/**
 * Audit F42: the deletion protocol end to end, through the HTTP router and the P2 worker over the Auth and Firestore
 * emulators. A partner requests, a second partner approves, the approval tombstones the matter and revokes its
 * memberships, and the saga purges or acknowledges every inventoried store. Reads refuse the tombstoned matter at once
 * through the Functions routes and the F02 authority gate. A legal hold (the shipped policy's, or the matter's own)
 * blocks deletion and is recorded; a crash mid-saga resumes without repeating an effect.
 */

// A whole saga acknowledges about 300 stores through about 20 P2 jobs over the emulator: 5 to 15 s on a quiet
// machine, more on a loaded one. Each test gets its own budget rather than the 15 s default.
vi.setConfig({ testTimeout: 120_000 })

type Member = { uid: string; token: string }
type Firm = { firmId: string; P: Member; Q: Member; A: Member; C: Member; outsider: Member; matterId: string; otherMatterId: string }
type RequestView = { requestId: string; status: string; refusal?: { code: string } | null; jobId?: string }
type Ack = { storeId: string; outcome: string; count: number | null; idsSha256: string | null; detail: Record<string, unknown> }
type DeletionView = {
  requestId: string
  matterId: string
  status: string
  expected: string[]
  acked: Record<string, string>
  halted: { code: string } | null
  acks: Ack[]
}

const requestApi = viaApi<RequestView>("requestMatterDeletion")
const approveApi = viaApi<RequestView>("approveMatterDeletion")
const statusApi = viaApi<DeletionView>("getDeletionRequest")
const holdApi = viaApi<Record<string, unknown>>("placeLegalHold")
const releaseApi = viaApi<Record<string, unknown>>("releaseLegalHold")
const getMatterApi = viaApi("getMatter")
const listMattersApi = viaApi<{ items: Array<{ matterId?: string; id?: string }> }>("listMatters")
const createDraftApi = viaApi<{ draftId: string }>("createDraft")
const getDraftApi = viaApi("getDraft")
const listDraftsApi = viaApi("listDrafts")
const listJobsApi = viaApi("listJobs")
const committeeApi = viaApi("committeeBrain")

const TITLE = "Confidential title for the F42 matter"
const BODY = "IN THE HIGH COURT. The petitioner submits as follows. F42 draft body."
const OUTPUT_TEXT = "F42 confidential AI answer text"
const claims = (firmId: string, role: string) => ({ firmId, role, clearanceLevel: "privileged-restricted" })
const send = <T>(api: (c: never) => Promise<T>, f: Firm, m: Member, data: Record<string, unknown>): Promise<T> =>
  api({ token: m.token, data: { firmId: f.firmId, ...data } } as never)

/** The test policy: matter classes purge with no hold, AI records anonymise, the vault locks, Opik is requested. */
function testPolicy(): RetentionPolicy {
  const p = structuredClone(shippedPolicy) as unknown as RetentionPolicy
  p.policyVersion = "test-f42-purge"
  for (const name of ["matter_access", "matter_content", "derived_index", "job_record", "legacy_matter_ops"]) {
    p.classes[name] = { ...p.classes[name], onMatterDeletion: "purge", legalHold: false }
  }
  // The matter row is anonymised, not purged: the conflict screen still reads it (spec R8).
  p.classes.matter_record = { ...p.classes.matter_record, onMatterDeletion: "anonymise", legalHold: false }
  p.classes.ai_record = { ...p.classes.ai_record, onMatterDeletion: "anonymise", legalHold: false }
  p.classes.vault_object = { ...p.classes.vault_object, onMatterDeletion: "lock", legalHold: false }
  p.classes.third_party_trace = { ...p.classes.third_party_trace, onMatterDeletion: "external" }
  p.classes.backup = { ...p.classes.backup, onMatterDeletion: "expiry" }
  return p
}

async function seedMatter(firmId: string, matterId: string, title: string, members: string[]): Promise<void> {
  const db = adminDb()
  await db
    .collection("matters")
    .doc(matterId)
    .set({
      ...canonicalMatterDocument({ firmId, clientId: `client-${firmId}`, title, classification: "internal", status: "live", stage: "pre_filing", courtId: "SHC", caseNumber: null, matterNo: null, conflictCheckId: null, createdBy: members[0] }),
      createdAt: Timestamp.now(),
    })
  for (const uid of members) {
    await db.collection("matter_members").doc(`${matterId}_${uid}`).set({ firmId, matterId, userId: uid, addedBy: members[0], classification: "internal", createdAt: Timestamp.now() })
  }
}

/** One row of a matter in each kind of store the saga treats differently. Returns the refs it wrote. */
async function seedStores(firmId: string, matterId: string, tag: string): Promise<Record<string, string>> {
  const db = adminDb()
  const ids: Record<string, string> = {}
  const put = async (collection: string, data: DocumentData, id = uniq(`${tag}-${collection.slice(0, 12)}`)) => {
    await db.collection(collection).doc(id).set({ firmId, ...data })
    ids[collection] = id
    return id
  }
  await put("documents", { matterId, classification: "internal", storagePath: `fs://${firmId}/documents/${tag}-d1/v1`, contentHash: "a".repeat(64), title: TITLE })
  await put("document_versions", { matterId, classification: "internal", storagePath: `fs://${firmId}/documents/${tag}-d1/v2` })
  await put("ocr_texts", { matterId, documentId: `${tag}-d1`, classification: "internal", text: `${TITLE} OCR` })
  await put("p1_ocr_operations", { matterId, documentId: `${tag}-d1`, text: `${TITLE} OCR op` })
  await put("committee_outputs", { matterId, actorId: "x", classification: "internal", text: OUTPUT_TEXT, outbound: { body: "masked" }, createdAt: Date.now() })
  await put("draft_gate_results", { matterId, draftId: "d", classification: "internal" })
  await put("draft_gate_overrides", { matterId, draftId: "d", reason: TITLE })
  await put("matter_client_search_index", { rowType: "matter", referenceId: matterId, linkedMatterId: matterId, label: TITLE, classification: "internal" })
  await put("matter_report_export_analytics", { matterId, classification: "internal", lastExportReason: TITLE })
  await put("matter_report_relevance_snapshots", { matterId, classification: "internal", recomputeReason: TITLE })
  await put("workflow_ops_activity", { matterId, classification: "internal", detail: TITLE })
  await put("workflow_ops_alert_digests", { matterId, classification: "internal", recomputeReason: TITLE })
  await put("follow_ups", { matterId, raw: TITLE })
  await put("jobs", { matterId, jobType: "ocr", documentId: `${tag}-d1`, classification: "internal" })
  await put("matter_parties", { matterId, name: `${tag} Opposing Party` })
  await put("conflict_checks", { matterId, subjects: [] })
  const exported = await put("ai_usage_logs", { matterId, model: "m", costMicroUsd: 5, trace: { id: `trace-${tag}-1`, status: "exported" }, createdAt: Timestamp.now() })
  ids.ai_usage_logs_exported = exported
  ids.ai_usage_logs_disabled = await put("ai_usage_logs", { matterId, model: "m", costMicroUsd: 3, trace: { id: `trace-${tag}-2`, status: "disabled" }, createdAt: Timestamp.now() })
  ids.ai_usage_logs = exported
  return ids
}

const PURGED = [
  "documents",
  "document_versions",
  "ocr_texts",
  "p1_ocr_operations",
  "committee_outputs",
  "draft_gate_results",
  "draft_gate_overrides",
  "matter_client_search_index",
  "matter_report_export_analytics",
  "matter_report_relevance_snapshots",
  "workflow_ops_activity",
  "workflow_ops_alert_digests",
  "follow_ups",
  "jobs",
]

async function newFirm(): Promise<Firm> {
  const firmId = uniq("f42firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F42", plan: "internal", rateLimits: { general: 1000 } })
  const [P, Q, A, C, outsider] = [
    await mintIdToken(claims(firmId, "partner")),
    await mintIdToken(claims(firmId, "partner")),
    await mintIdToken(claims(firmId, "associate")),
    await mintIdToken(claims(firmId, "clerk")),
    await mintIdToken(claims(firmId, "partner")),
  ]
  const matterId = uniq("f42m")
  const otherMatterId = uniq("f42other")
  await seedMatter(firmId, matterId, TITLE, [P.uid, Q.uid, A.uid, C.uid])
  await seedMatter(firmId, otherMatterId, "Another matter", [P.uid, Q.uid])
  return { firmId, P, Q, A, C, outsider, matterId, otherMatterId }
}

/** Runs every queued or retrying retention job of the firm until none is left; returns the outcomes. */
async function drain(firmId: string, clock: FakeClock, deps = testDeps(clock), rounds = 60): Promise<string[]> {
  const outcomes: string[] = []
  for (let i = 0; i < rounds; i++) {
    clock.set(Math.max(clock.now(), Date.now()))
    const snap = await adminDb().collection("jobs").where("firmId", "==", firmId).where("status", "in", ["queued", "failed"]).get()
    const due = snap.docs.filter((d) => d.get("engine") === "p2" && String(d.get("jobType")).startsWith("retention."))
    if (due.length === 0) return outcomes
    for (const d of due) {
      const next = d.get("nextAttemptAt") as Timestamp | null
      if (next && next.toMillis() > clock.now()) clock.set(next.toMillis() + 1)
      outcomes.push(await runJobTask({ jobId: d.id, seq: d.get("dispatchSeq") as number }, deps))
    }
  }
  throw new Error("retention jobs did not settle")
}

async function requestAndApprove(f: Firm): Promise<{ requestId: string; approved: RequestView }> {
  const req = await send(requestApi, f, f.P, { matterId: f.matterId, reasonCode: "client_instruction" })
  expect(req.status).toBe("pending_approval")
  const approved = await send(approveApi, f, f.Q, { requestId: req.requestId })
  return { requestId: req.requestId, approved }
}

async function exists(collection: string, id: string): Promise<boolean> {
  return (await adminDb().collection(collection).doc(id).get()).exists
}

/** Every string anywhere in a stored value. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value)
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out))
  else if (value && typeof value === "object" && !(value instanceof Timestamp)) Object.values(value).forEach((v) => strings(v, out))
  return out
}

/** A call through the router to one of the F02 Next authority routes (GET), with the query as data. */
async function f02Get(path: string, f: Firm, m: Member, query: Record<string, string>): Promise<{ status: number; code: string | undefined }> {
  const route = ROUTES.find((r) => r.method === "GET" && r.path === path)
  if (!route) throw new Error(`no route ${path}`)
  const { res, out } = mockRes()
  await createRouter(ROUTES)(
    { method: "GET", path, headers: { authorization: `Bearer ${m.token}`, "x-firm-id": f.firmId, "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 250)}` }, body: {}, query, ip: "127.0.0.1" } as never,
    res as never
  )
  return { status: out.status, code: (out.body as { error?: { code?: string } } | undefined)?.error?.code }
}

afterEach(() => {
  delete retentionTestSeam.policy
  delete retentionTestSeam.afterStep
  delete retentionTestSeam.beforeAck
})

describe.skipIf(!EMULATORS)("F42: matter deletion through tombstone, saga and acknowledgements", () => {
  it("the shipped policy refuses every deletion by legal hold, records the refusal and deletes nothing", async () => {
    const f = await newFirm()
    const ids = await seedStores(f.firmId, f.matterId, "def")
    const req = await send(requestApi, f, f.P, { matterId: f.matterId, reasonCode: "client_instruction" })
    expect(req.status).toBe("refused")
    expect(req.refusal?.code).toBe("legal_hold_policy")
    const stored = (await adminDb().collection("deletion_requests").doc(req.requestId).get()).data()
    expect(stored).toMatchObject({ firmId: f.firmId, matterId: f.matterId, status: "refused", refusal: { code: "legal_hold_policy", by: f.P.uid } })
    expect(await exists("matter_tombstones", f.matterId)).toBe(false)
    for (const c of PURGED) expect(await exists(c, ids[c]), c).toBe(true)
    expect(await exists("matters", f.matterId)).toBe(true)
    expect(await exists("matter_members", `${f.matterId}_${f.A.uid}`)).toBe(true)
    const refusalAudit = await adminDb().collection("audit_log").where("firmId", "==", f.firmId).where("action", "==", "retention.request_deletion").get()
    expect(refusalAudit.docs.map((d) => d.get("reason"))).toContain("legal_hold_policy")
  })

  it("the saga purges every matter store, acknowledges every inventoried store and finishes; other matters and firms are untouched", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const ids = await seedStores(f.firmId, f.matterId, "m")
    const keep = await seedStores(f.firmId, f.otherMatterId, "o")
    const otherFirm = uniq("f42x")
    const foreign = await seedStores(otherFirm, f.matterId, "x") // same matter id, another firm: never touched
    const { requestId, approved } = await requestAndApprove(f)
    expect(approved.status).toBe("in_progress")
    expect(await exists("matter_tombstones", f.matterId)).toBe(true)
    // The approval revoked every membership in its own transaction.
    for (const m of [f.P, f.Q, f.A, f.C]) expect(await exists("matter_members", `${f.matterId}_${m.uid}`)).toBe(false)
    expect(await exists("matter_members", `${f.otherMatterId}_${f.P.uid}`)).toBe(true)

    const clock = new FakeClock(Date.now())
    const outcomes = await drain(f.firmId, clock)
    expect(outcomes.every((o) => o === "done")).toBe(true)

    const view = await send(statusApi, f, f.P, { requestId })
    expect(view.status).toBe("completed")
    const expected = (inventory.stores as Array<{ id: string }>).map((s) => storeKey(s.id)).sort()
    expect([...view.expected].sort()).toEqual(expected)
    expect(Object.keys(view.acked).sort()).toEqual(expected)
    expect(view.acks).toHaveLength(expected.length)
    const ack = (id: string) => view.acks.find((a) => a.storeId === id)!
    expect(ack("firestore:matters")).toMatchObject({ outcome: "anonymised", count: 1 })
    expect(ack("firestore:matter_members")).toMatchObject({ outcome: "purged", count: 0 })
    expect(ack("firestore:documents")).toMatchObject({ outcome: "purged", count: 1 })
    expect(ack("firestore:committee_outputs")).toMatchObject({ outcome: "purged", count: 1 })
    expect(ack("firestore:workflow_ops_alert_digests")).toMatchObject({ outcome: "purged", count: 1 })
    expect(ack("firestore:ai_usage_logs")).toMatchObject({ outcome: "anonymised", count: 2 })
    expect(ack("firestore:matter_parties")).toMatchObject({ outcome: "retained" })
    expect(ack("firestore:audit_log")).toMatchObject({ outcome: "not_applicable" })
    expect(ack("firestore:idempotency_effects")).toMatchObject({ outcome: "expiry" })
    expect(ack("objects:documents")).toMatchObject({ outcome: "lock_pending", count: 2 })
    expect(ack("external:opik")).toMatchObject({ outcome: "external_requested", count: 1 })
    expect(ack("backup:firestore")).toMatchObject({ outcome: "expiry" })
    expect(ack("postgres:corpus_embeddings")).toMatchObject({ outcome: "not_applicable" })
    expect(ack("firestore:p1_decisions")).toMatchObject({ outcome: "anonymised", count: 0 })
    for (const a of view.acks.filter((x) => x.outcome === "purged" && (x.count ?? 0) > 0)) expect(a.idsSha256).toMatch(/^[0-9a-f]{64}$/)
    const windowEnd = Date.parse(String(ack("backup:firestore").detail.windowEndsAt))
    expect(windowEnd - Date.now()).toBeGreaterThan(97 * 86_400_000)

    // Purged: every row of the matter, in every store; the matter row itself.
    for (const c of PURGED) expect(await exists(c, ids[c]), c).toBe(false)
    // Anonymised: the matter row stays for the conflict screen, without its title or case number.
    expect((await adminDb().collection("matters").doc(f.matterId).get()).data()).toMatchObject({ firmId: f.firmId, title: "", caseNumber: null, anonymisedBy: requestId })
    // Anonymised: the spend rows stay, without the matter.
    const usage = (await adminDb().collection("ai_usage_logs").doc(ids.ai_usage_logs_exported).get()).data()
    expect(usage).toMatchObject({ matterId: null, costMicroUsd: 5 })
    // Retained: the conflict register.
    expect(await exists("matter_parties", ids.matter_parties)).toBe(true)
    // The vault objects are tombstoned for the lifecycle, and the Opik request lists the exported trace only.
    const vault = await adminDb().collection("vault_object_tombstones").where("requestId", "==", requestId).get()
    expect(vault.docs.map((d) => d.get("storagePath")).sort()).toEqual([`fs://${f.firmId}/documents/m-d1/v1`, `fs://${f.firmId}/documents/m-d1/v2`])
    const external = (await adminDb().collection("deletion_external_requests").doc(`${requestId}_opik`).get()).data()
    expect(external).toMatchObject({ processor: "opik", traceIds: ["trace-m-1"], count: 1, status: "pending_operator" })
    // The tombstone survives with the finish stamped.
    const tomb = (await adminDb().collection("matter_tombstones").doc(f.matterId).get()).data()
    expect(tomb).toMatchObject({ firmId: f.firmId, requestId, membersRevoked: 4 })
    expect(tomb?.purgeCompletedAt).toBeInstanceOf(Timestamp)

    // Untouched: the firm's other matter and another firm's rows under the same matter id.
    for (const c of PURGED) expect(await exists(c, keep[c]), `other matter ${c}`).toBe(true)
    for (const c of PURGED) expect(await exists(c, foreign[c]), `other firm ${c}`).toBe(true)
    expect(await exists("matters", f.otherMatterId)).toBe(true)
  })

  it("reads refuse the tombstoned matter at once through the Functions routes and the F02 authority gate", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const draft = await send(createDraftApi, f, f.P, { matterId: f.matterId, documentTypeId: "constitutional_petition_199", title: "F42 draft", body: BODY })
    // Before: the matter and its draft read normally.
    await send(getMatterApi, f, f.A, { matterId: f.matterId })
    await send(getDraftApi, f, f.A, { draftId: draft.draftId })

    await requestAndApprove(f)
    // No saga job has run: every refusal below comes from the tombstone.
    const refused = async (p: Promise<unknown>) => {
      const err = await apiErrorOf(p)
      expect(err).toBeInstanceOf(ApiError)
      return `${err.status} ${err.code}`
    }
    expect(await refused(send(getMatterApi, f, f.P, { matterId: f.matterId }))).toBe("403 matter_deleted")
    expect(await refused(send(getDraftApi, f, f.P, { draftId: draft.draftId }))).toBe("403 matter_deleted")
    expect(await refused(send(listDraftsApi, f, f.P, { matterId: f.matterId }))).toBe("403 matter_deleted")
    expect(await refused(send(listJobsApi, f, f.P, { matterId: f.matterId }))).toBe("403 matter_deleted")
    expect(await refused(send(committeeApi, f, f.P, { matterId: f.matterId, body: "Summarise the matter." }))).toBe("403 matter_deleted")
    const listed = await send(listMattersApi, f, f.P, {})
    expect(JSON.stringify(listed)).not.toContain(f.matterId)
    expect(JSON.stringify(listed)).toContain(f.otherMatterId)
    // The F02 authority gate in front of the Next domain routes.
    expect(await f02Get("/api/d1/documents", f, f.P, { matterId: f.matterId, userId: f.P.uid })).toMatchObject({ status: 403, code: "matter_deleted" })
    expect(await f02Get("/api/d4/drafts", f, f.P, { matterId: f.matterId })).toMatchObject({ status: 403, code: "matter_deleted" })
  })

  it("the tombstone alone, with every membership intact, refuses the matter's reads and lists, and its queued P2 job", async () => {
    const f = await newFirm()
    const { jobId } = await adminDb().runTransaction((tx) =>
      enqueueJob(tx, { firmId: f.firmId, jobType: "platform.diagnostic", classification: "internal", matterId: f.matterId, payload: { behaviour: "succeed" }, idempotencyKey: uniq("k"), createdBy: f.P.uid }, { now: Date.now() })
    )
    await adminDb().collection("matter_tombstones").doc(f.matterId).set({ firmId: f.firmId, matterId: f.matterId, requestId: "direct", classification: "internal", tombstonedAt: Timestamp.now() })
    expect(await exists("matter_members", `${f.matterId}_${f.A.uid}`)).toBe(true)
    const err = await apiErrorOf(send(getMatterApi, f, f.A, { matterId: f.matterId }))
    expect(`${err.status} ${err.code}`).toBe("403 matter_deleted")
    const listed = await send(listMattersApi, f, f.A, {})
    expect(JSON.stringify(listed)).not.toContain(f.matterId)
    expect(await runJobTask({ jobId, seq: 0 }, testDeps(new FakeClock(Date.now())))).toBe("dead_lettered")
    expect((await adminDb().collection("jobs").doc(jobId).get()).get("lastError.code")).toBe("matter_deleted")
    // Another firm's tombstone under the same id refuses nothing here.
    const g = await newFirm()
    await adminDb().collection("matter_tombstones").doc(g.matterId).set({ firmId: f.firmId, matterId: g.matterId, requestId: "direct", classification: "internal", tombstonedAt: Timestamp.now() })
    await send(getMatterApi, g, g.A, { matterId: g.matterId })
  })

  it("a row that lands after a store's purge but before its acknowledgement is purged first, then acknowledged", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    await seedStores(f.firmId, f.matterId, "late")
    let late: string | null = null
    retentionTestSeam.beforeAck = async (part) => {
      if (part !== "g0" || late !== null) return
      late = uniq("late-doc")
      await adminDb().collection("documents").doc(late).set({ firmId: f.firmId, matterId: f.matterId, classification: "internal", storagePath: `fs://${f.firmId}/documents/late/v1` })
    }
    const { requestId } = await requestAndApprove(f)
    const outcomes = await drain(f.firmId, new FakeClock(Date.now()))
    expect(late).not.toBeNull()
    expect(outcomes).toContain("failed")
    expect(await exists("documents", late!)).toBe(false)
    const view = await send(statusApi, f, f.P, { requestId })
    expect(view.status).toBe("completed")
    const ack = (id: string) => view.acks.find((a) => a.storeId === id)!
    expect(ack("firestore:documents")).toMatchObject({ outcome: "purged", count: 2 })
    expect(ack("objects:documents")).toMatchObject({ outcome: "lock_pending", count: 3 })
    const jobs = await adminDb().collection("jobs").where("firmId", "==", f.firmId).where("jobType", "==", "retention.store.purge").get()
    const codes = jobs.docs.flatMap((d) => ((d.get("logs") as Array<{ code?: string }>) ?? []).map((l) => l.code))
    expect(codes).toContain("purge_incomplete")
  })

  it("a matter legal hold blocks the request and the approval, and each refusal is recorded; only another partner releases it", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const ids = await seedStores(f.firmId, f.matterId, "h")
    // Approval-time hold: requested first, then held, then approval refused.
    const req = await send(requestApi, f, f.P, { matterId: f.matterId, reasonCode: "client_instruction" })
    expect(req.status).toBe("pending_approval")
    await send(holdApi, f, f.Q, { matterId: f.matterId, reasonCode: "litigation_anticipated" })
    const approved = await send(approveApi, f, f.Q, { requestId: req.requestId })
    expect(approved).toMatchObject({ status: "refused", refusal: { code: "legal_hold_matter" } })
    expect((await adminDb().collection("deletion_requests").doc(req.requestId).get()).data()).toMatchObject({ status: "refused", refusal: { code: "legal_hold_matter", by: f.Q.uid } })
    // Request-time hold.
    const again = await send(requestApi, f, f.P, { matterId: f.matterId, reasonCode: "client_instruction" })
    expect(again).toMatchObject({ status: "refused", refusal: { code: "legal_hold_matter" } })
    expect(await exists("matter_tombstones", f.matterId)).toBe(false)
    for (const c of PURGED) expect(await exists(c, ids[c]), c).toBe(true)
    // The partner who placed the hold cannot release it; another partner can.
    expect((await apiErrorOf(send(releaseApi, f, f.Q, { matterId: f.matterId }))).code).toBe("second_partner_required")
    await send(releaseApi, f, f.P, { matterId: f.matterId })
    expect((await adminDb().collection("legal_holds").doc(f.matterId).get()).data()).toMatchObject({ active: false, releasedBy: f.P.uid })
    const ok = await send(requestApi, f, f.P, { matterId: f.matterId, reasonCode: "client_instruction" })
    expect(ok.status).toBe("pending_approval")
  })

  it("a hold placed while the saga runs halts it: nothing more is purged and the request stays unacknowledged", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const ids = await seedStores(f.firmId, f.matterId, "mid")
    const { requestId, approved } = await requestAndApprove(f)
    const clock = new FakeClock(Date.now())
    const deps = testDeps(clock)
    // Run the prepare job only; its purge jobs are enqueued but not yet run.
    expect(await runJobTask({ jobId: approved.jobId!, seq: 0 }, deps)).toBe("done")
    await send(holdApi, f, f.P, { matterId: f.matterId, reasonCode: "regulator_request" })
    const outcomes = await drain(f.firmId, clock, deps)
    expect(outcomes).toContain("dead_lettered")
    const view = await send(statusApi, f, f.P, { requestId })
    expect(view.status).toBe("in_progress")
    expect(view.halted).toMatchObject({ code: "legal_hold_active" })
    expect(Object.keys(view.acked)).not.toContain("firestore_documents")
    for (const c of PURGED) expect(await exists(c, ids[c]), c).toBe(true)
    const dead = await adminDb().collection("jobs").where("firmId", "==", f.firmId).where("status", "==", "dead_lettered").get()
    expect(dead.docs.map((d) => d.get("lastError.code"))).toContain("legal_hold_active")
  })

  it("a crash mid-saga resumes from its last committed step: every row purged once, every store acknowledged once", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const ids = await seedStores(f.firmId, f.matterId, "crash")
    let crashes = 0
    retentionTestSeam.afterStep = async (step) => {
      if (step.startsWith("chunk") && crashes < 2) {
        crashes += 1
        throw new Error("simulated crash after a committed step")
      }
    }
    const { requestId } = await requestAndApprove(f)
    const clock = new FakeClock(Date.now())
    const outcomes = await drain(f.firmId, clock)
    expect(crashes).toBe(2)
    expect(outcomes).toContain("failed")
    const view = await send(statusApi, f, f.P, { requestId })
    expect(view.status).toBe("completed")
    const ackDocs = await adminDb().collection("deletion_acks").where("requestId", "==", requestId).get()
    expect(ackDocs.size).toBe(view.expected.length)
    const ack = (id: string) => view.acks.find((a) => a.storeId === id)!
    expect(ack("firestore:documents")).toMatchObject({ outcome: "purged", count: 1 })
    expect(ack("firestore:committee_outputs")).toMatchObject({ outcome: "purged", count: 1 })
    expect(ack("objects:documents")).toMatchObject({ outcome: "lock_pending", count: 2 })
    for (const c of PURGED) expect(await exists(c, ids[c]), c).toBe(false)
    // A replay of a finished job changes nothing.
    const before = (await adminDb().collection("deletion_requests").doc(requestId).get()).updateTime
    expect(await drain(f.firmId, clock)).toEqual([])
    expect((await adminDb().collection("deletion_requests").doc(requestId).get()).updateTime?.isEqual(before!)).toBe(true)
  })

  it("authorisation: partners only; the requester cannot approve; one open request per matter; a cleared partner of the firm only", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    for (const m of [f.A, f.C]) {
      const err = await apiErrorOf(send(requestApi, f, m, { matterId: f.matterId, reasonCode: "client_instruction" }))
      expect(`${err.status} ${err.code}`).toBe("403 partner_only")
    }
    const req = await send(requestApi, f, f.P, { matterId: f.matterId, reasonCode: "client_instruction" })
    expect((await apiErrorOf(send(requestApi, f, f.Q, { matterId: f.matterId, reasonCode: "client_instruction" }))).code).toBe("deletion_request_open")
    expect((await apiErrorOf(send(approveApi, f, f.P, { requestId: req.requestId }))).code).toBe("second_partner_required")
    expect((await apiErrorOf(send(approveApi, f, f.A, { requestId: req.requestId }))).code).toBe("partner_only")
    expect((await apiErrorOf(send(requestApi, f, f.P, { matterId: uniq("nomatter"), reasonCode: "client_instruction" }))).code).toBe("not_found")
    expect((await apiErrorOf(send(requestApi, f, f.P, { matterId: f.matterId, reasonCode: "Free text with spaces" }))).code).toBe("invalid_reason_code")
    // A partner of another firm cannot approve this firm's request (the firm binding refuses before the store is read).
    const g = await newFirm()
    const crossFirm = await apiErrorOf(approveApi({ token: g.P.token, data: { firmId: f.firmId, requestId: req.requestId } } as never))
    expect(crossFirm.status).toBe(403)
    // A partner of the firm whose clearance is below the matter's label cannot approve.
    const low = await mintIdToken({ firmId: f.firmId, role: "partner", clearanceLevel: "public" })
    expect((await apiErrorOf(send(approveApi, f, low, { requestId: req.requestId }))).code).toBe("clearance")
    // The outsider partner (no membership) may approve: deletion is firm administration, not matter membership.
    const ok = await send(approveApi, f, f.outsider, { requestId: req.requestId })
    expect(ok.status).toBe("in_progress")
    // The window: an old request expires.
    const h = await newFirm()
    const old = await send(requestApi, h, h.P, { matterId: h.matterId, reasonCode: "client_instruction" })
    await adminDb().collection("deletion_requests").doc(old.requestId).update({ requestedAt: Timestamp.fromMillis(Date.now() - 73 * 3_600_000) })
    expect((await apiErrorOf(send(approveApi, h, h.Q, { requestId: old.requestId }))).code).toBe("approval_expired")
  })

  it("the deletion trail keeps ids, codes, counts and hashes only, never the matter's content", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    await seedStores(f.firmId, f.matterId, "trail")
    const { requestId } = await requestAndApprove(f)
    await drain(f.firmId, new FakeClock(Date.now()))
    const docs: DocumentData[] = []
    for (const c of ["deletion_requests", "deletion_acks", "deletion_external_requests", "vault_object_tombstones"]) {
      const snap = await adminDb().collection(c).where("requestId", "==", requestId).get()
      docs.push(...snap.docs.map((d) => d.data()))
    }
    docs.push((await adminDb().collection("deletion_requests").doc(requestId).get()).data()!)
    docs.push((await adminDb().collection("matter_tombstones").doc(f.matterId).get()).data()!)
    const audit = await adminDb().collection("audit_log").where("firmId", "==", f.firmId).get()
    docs.push(...audit.docs.map((d) => d.data()))
    const all = strings(docs).join("\n")
    expect(docs.length).toBeGreaterThan(10)
    for (const content of [TITLE, BODY, OUTPUT_TEXT, "Opposing Party", "Another matter"]) expect(all).not.toContain(content)
  })
})
