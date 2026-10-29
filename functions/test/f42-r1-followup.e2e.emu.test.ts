import { randomUUID } from "node:crypto"
import { FieldValue, Timestamp, type DocumentData } from "firebase-admin/firestore"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import shippedPolicy from "@/infra/retention/policy.json"
import { canonicalMatterDocument } from "@/platform/d1/matterDocument"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { adminAuth, adminDb } from "../src/admin"
import { InMemoryAuthorityStore, setAuthorityStoreForTests } from "../src/d4/authority"
import { ROUTES, createRouter } from "../src/http/router"
import { firmConfigRef } from "../src/p1/config"
import { p1TestSeam } from "../src/p1/gateway"
import { setOpikFetchForTests } from "../src/p1/opik"
import { setP1TransportForTests } from "../src/p1/transport"
import { retentionTestSeam, type RetentionPolicy } from "../src/retention/config"
import { enqueueJob } from "../src/p2/enqueue"
import { runJobTask } from "../src/p2/worker"
import { apiErrorOf, viaApi } from "./api"
import { EMULATORS, mintIdToken, mockRes, uniq } from "./emu"
import { deleteFirmScopedData } from "./firmCleanup"
import { FakeClock, testDeps } from "./jobs"

/**
 * Audit F42, the R1 follow-up (spec section 11): the re-audit's findings FA-F42-R1-001 to R1-008, each through the real
 * HTTP router and the real P2 worker over the Auth and Firestore emulators, with the test policy (matter classes purge
 * with no hold, AI records anonymise, the vault locks, Opik is requested) unless a test says otherwise.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })

type Member = { uid: string; token: string; email?: string }
type Firm = { firmId: string; P: Member; Q: Member; A: Member; matterId: string }
type RequestView = { requestId: string; status: string; refusal?: { code: string } | null; jobId?: string }
type Ack = { storeId: string; outcome: string; count: number | null; idsSha256: string | null; detail: Record<string, unknown> }
type DeletionView = { requestId: string; status: string; expected: string[]; acked: Record<string, string>; halted: { code: string } | null; acks: Ack[] }

const requestApi = viaApi<RequestView>("requestMatterDeletion")
const approveApi = viaApi<RequestView>("approveMatterDeletion")
const statusApi = viaApi<DeletionView>("getDeletionRequest")
const holdApi = viaApi<Record<string, unknown>>("placeLegalHold")

const TITLE = "F42R1 Confidential title Ayesha Siddiqui v Khan"
const DAY_MS = 86_400_000
const claims = (firmId: string, role: string) => ({ firmId, role, clearanceLevel: "privileged-restricted" })
const send = <T>(api: (c: never) => Promise<T>, f: { firmId: string }, m: Member, data: Record<string, unknown>): Promise<T> =>
  api({ token: m.token, data: { firmId: f.firmId, ...data } } as never)

/** The test policy: matter classes purge with no hold, AI records anonymise, the vault locks, Opik is requested. */
function testPolicy(): RetentionPolicy {
  const p = structuredClone(shippedPolicy) as unknown as RetentionPolicy
  p.policyVersion = "test-f42-r1"
  for (const name of ["matter_access", "matter_content", "derived_index", "job_record", "legacy_matter_ops"]) {
    p.classes[name] = { ...p.classes[name], onMatterDeletion: "purge", legalHold: false }
  }
  p.classes.matter_record = { ...p.classes.matter_record, onMatterDeletion: "anonymise", legalHold: false }
  p.classes.ai_record = { ...p.classes.ai_record, onMatterDeletion: "anonymise", legalHold: false }
  p.classes.vault_object = { ...p.classes.vault_object, onMatterDeletion: "lock", legalHold: false }
  p.classes.third_party_trace = { ...p.classes.third_party_trace, onMatterDeletion: "external" }
  p.classes.backup = { ...p.classes.backup, onMatterDeletion: "expiry" }
  return p
}

// Every firm and auth user this file creates, deleted in afterAll (FA-F42-R1-015).
const firms: string[] = []
const uids: string[] = []

type MemberOpts = { independentPartner?: boolean }

async function member(firmId: string, role: string, opts?: MemberOpts): Promise<Member> {
  const m = await mintIdToken(claims(firmId, role))
  uids.push(m.uid)
  // An established account: created long before any request (spec R26 judges an approver's tenure).
  await adminDb().collection("users").doc(m.uid).set(
    {
      createdAt: Timestamp.fromMillis(Date.now() - 400 * DAY_MS),
      ...(role === "partner" && opts?.independentPartner !== undefined
        ? { independentPartner: opts.independentPartner }
        : {}),
    },
    { merge: true }
  )
  return m
}

async function seedMatter(firmId: string, matterId: string, title: string, members: string[]): Promise<void> {
  const db = adminDb()
  await db.collection("matters").doc(matterId).set({
    ...canonicalMatterDocument({ firmId, clientId: `client-${firmId}`, title, classification: "internal", status: "live", stage: "pre_filing", courtId: "SHC", caseNumber: null, matterNo: null, conflictCheckId: null, createdBy: members[0] }),
    createdAt: Timestamp.now(),
  })
  for (const uid of members) {
    await db.collection("matter_members").doc(`${matterId}_${uid}`).set({ firmId, matterId, userId: uid, addedBy: members[0], classification: "internal", createdAt: Timestamp.now() })
  }
}

async function newFirm(): Promise<Firm> {
  const firmId = uniq("f42r1")
  firms.push(firmId)
  await adminDb().collection("firms").doc(firmId).set({ name: "F42R1", plan: "internal", rateLimits: { general: 5000 } })
  const P = await member(firmId, "partner", { independentPartner: true })
  const Q = await member(firmId, "partner", { independentPartner: true })
  const A = await member(firmId, "associate")
  const matterId = uniq("f42r1m")
  await seedMatter(firmId, matterId, TITLE, [P.uid, Q.uid, A.uid])
  return { firmId, P, Q, A, matterId }
}

/** Runs every queued or retrying retention job of the firm until none is left; returns the outcomes. */
async function drain(firmId: string, clock: FakeClock, deps = testDeps(clock), rounds = 120): Promise<string[]> {
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

/** Every string anywhere in a stored value. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value)
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out))
  else if (value && typeof value === "object" && !(value instanceof Timestamp)) Object.values(value).forEach((v) => strings(v, out))
  return out
}

/** Every document of the deletion trail of `requestId` (and the firm's audit rows). */
async function trailOf(f: Firm, requestId: string): Promise<DocumentData[]> {
  const docs: DocumentData[] = []
  for (const c of ["deletion_requests", "deletion_acks", "deletion_external_requests", "vault_object_tombstones"]) {
    const snap = await adminDb().collection(c).where("requestId", "==", requestId).get()
    docs.push(...snap.docs.map((d) => d.data()))
  }
  docs.push((await adminDb().collection("deletion_requests").doc(requestId).get()).data() ?? {})
  docs.push((await adminDb().collection("matter_tombstones").doc(f.matterId).get()).data() ?? {})
  docs.push(...(await adminDb().collection("legal_holds").where("firmId", "==", f.firmId).get()).docs.map((d) => d.data()))
  docs.push(...(await adminDb().collection("audit_log").where("firmId", "==", f.firmId).get()).docs.map((d) => d.data()))
  return docs
}

afterAll(async () => {
  if (EMULATORS) await deleteFirmScopedData(firms, uids)
}, 300_000)

afterEach(() => {
  delete retentionTestSeam.policy
  delete retentionTestSeam.afterStep
  delete retentionTestSeam.beforeAck
  delete retentionTestSeam.trailDocumentIdPageSize
  for (const k of Object.keys(p1TestSeam)) delete (p1TestSeam as Record<string, unknown>)[k]
  setP1TransportForTests(null)
  setOpikFetchForTests(null)
  setAuthorityStoreForTests(null)
  setProviderConfigForTests(null)
  vi.unstubAllEnvs()
})

describe.skipIf(!EMULATORS)("FA-F42-R1-005: no content enters the deletion trail", () => {
  it("a reason code outside the policy's closed lists is refused on the request and on the hold, and nothing is written", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    for (const reasonCode of ["client_ayesha_siddiqui_khula", "litigation_anticipated"]) {
      const err = await apiErrorOf(send(requestApi, f, f.P, { matterId: f.matterId, reasonCode }))
      expect(`${err.status} ${err.code}`, reasonCode).toBe("400 invalid_reason_code")
    }
    for (const reasonCode of ["client_ayesha_siddiqui_khula", "client_instruction_for_khan"]) {
      const err = await apiErrorOf(send(holdApi, f, f.P, { matterId: f.matterId, reasonCode }))
      expect(`${err.status} ${err.code}`, reasonCode).toBe("400 invalid_reason_code")
    }
    expect((await adminDb().collection("deletion_requests").where("firmId", "==", f.firmId).get()).size).toBe(0)
    expect((await adminDb().collection("legal_holds").doc(f.matterId).get()).exists).toBe(false)
    // The listed codes still pass: a deletion code on the request, a hold code on the hold.
    expect((await send(holdApi, f, f.Q, { matterId: f.matterId, reasonCode: "litigation_anticipated" })).active).toBe(true)
    const audit = await adminDb().collection("audit_log").where("firmId", "==", f.firmId).get()
    expect(strings(audit.docs.map((d) => d.data())).join("\n").toLowerCase()).not.toContain("ayesha")
  })

  it("a vault path that is not the vault's own shape for its row is not copied: its hash stands in, and it is counted", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const docOk = `${f.matterId}-dok`
    const docBad = `${f.matterId}-dbad`
    const db = adminDb()
    await db.collection("documents").doc(docOk).set({ firmId: f.firmId, matterId: f.matterId, classification: "internal", storagePath: `fs://${f.firmId}/documents/${docOk}/v1` })
    // A legacy row whose path carries content, and one whose path names another firm.
    await db.collection("documents").doc(docBad).set({ firmId: f.firmId, matterId: f.matterId, classification: "internal", storagePath: `fs://${f.firmId}/documents/${TITLE}/v1` })
    await db.collection("documents").doc(`${f.matterId}-dother`).set({ firmId: f.firmId, matterId: f.matterId, classification: "internal", storagePath: `s3://other-firm/documents/${f.matterId}-dother/v1` })
    await db.collection("document_versions").doc(`${f.matterId}-v2`).set({ firmId: f.firmId, matterId: f.matterId, documentId: docOk, classification: "internal", storagePath: `s3://${f.firmId}/documents/${docOk}/v2` })
    await db.collection("document_versions").doc(`${f.matterId}-v3`).set({ firmId: f.firmId, matterId: f.matterId, documentId: docOk, classification: "internal", storagePath: `fs://${f.firmId}/documents/${docOk}/v3-${TITLE}` })
    const { requestId } = await requestAndApprove(f)
    await drain(f.firmId, new FakeClock(Date.now()))
    const view = await send(statusApi, f, f.P, { requestId })
    expect(view.status).toBe("completed")
    const vaultAck = view.acks.find((a) => a.storeId === "objects:documents")!
    expect(vaultAck).toMatchObject({ outcome: "lock_pending", count: 5, detail: { refusedPaths: 3 } })
    const vault = await db.collection("vault_object_tombstones").where("requestId", "==", requestId).get()
    expect(vault.size).toBe(5)
    const kept = vault.docs.filter((d) => d.get("storagePath") !== null).map((d) => d.get("storagePath") as string).sort()
    expect(kept).toEqual([`fs://${f.firmId}/documents/${docOk}/v1`, `s3://${f.firmId}/documents/${docOk}/v2`])
    for (const d of vault.docs.filter((x) => x.get("storagePath") === null)) {
      expect(d.data()).toMatchObject({ pathShape: "refused", storagePathSha256: d.id })
      expect(d.id).toMatch(/^[0-9a-f]{64}$/)
    }
    const all = strings(await trailOf(f, requestId)).join("\n")
    expect(all).not.toContain(TITLE)
    expect(all.toLowerCase()).not.toContain("ayesha")
  })
})

const releaseApi = viaApi<Record<string, unknown>>("releaseLegalHold")
const retryApi = viaApi<Record<string, unknown>>("retryFailedJob")
const RETRY_NOTE = "Resumed after the legal hold on the matter was released."

/** The processor request summaries of `requestId` (not its parts), with every id its parts hold. */
async function processorRequests(requestId: string): Promise<Array<{ id: string; status: string; traceIds: string[] }>> {
  const snap = await adminDb().collection("deletion_external_requests").where("requestId", "==", requestId).get()
  const ids = snap.docs.filter((d) => typeof d.get("part") === "number").flatMap((d) => d.get("traceIds") as string[])
  return snap.docs.filter((d) => typeof d.get("status") === "string").map((d) => ({ id: d.id, status: d.get("status") as string, traceIds: [...ids].sort() }))
}

/** Retries every dead-lettered retention job of the firm through the P5 route, as a partner does (P3-12). */
async function retryDead(f: Firm, m: Member): Promise<number> {
  const dead = await adminDb().collection("jobs").where("firmId", "==", f.firmId).where("status", "==", "dead_lettered").get()
  const jobs = dead.docs.filter((d) => String(d.get("jobType")).startsWith("retention."))
  for (const d of jobs) await send(retryApi, f, m, { jobId: d.id, note: RETRY_NOTE })
  return jobs.length
}

describe.skipIf(!EMULATORS)("FA-F42-R1-004: a legal hold stops every remaining destructive step, the processor instruction included", () => {
  it("a hold placed after the approval and before prepare: prepare halts before any instruction or purge; the release resumes it", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    await adminDb().collection("ai_usage_logs").doc(uniq("u")).set({ firmId: f.firmId, matterId: f.matterId, model: "m", costMicroUsd: 1, trace: { id: "trace-held-1", status: "exported" }, createdAt: Timestamp.now() })
    const { requestId, approved } = await requestAndApprove(f)
    await send(holdApi, f, f.P, { matterId: f.matterId, reasonCode: "litigation_anticipated" })
    const clock = new FakeClock(Date.now())
    const deps = testDeps(clock)
    expect(await runJobTask({ jobId: approved.jobId!, seq: 0 }, deps)).toBe("dead_lettered")
    const prep = (await adminDb().collection("jobs").doc(approved.jobId!).get()).data()!
    expect(prep.lastError?.code).toBe("legal_hold_active")
    // Nothing destructive happened: no instruction to the processor, no purge job, no acknowledgement.
    expect(await processorRequests(requestId)).toEqual([])
    expect((await adminDb().collection("jobs").where("firmId", "==", f.firmId).where("jobType", "==", "retention.store.purge").get()).size).toBe(0)
    const halted = await send(statusApi, f, f.P, { requestId })
    expect(halted).toMatchObject({ status: "in_progress", halted: { code: "legal_hold_active" } })
    expect(Object.keys(halted.acked)).toEqual([])
    // Another partner releases the hold; a partner retries the halted job; the saga finishes and the instruction is issued.
    await send(releaseApi, f, f.Q, { matterId: f.matterId })
    // FA-F42-R1-012 (R07): the release itself clears the request's halt, before any job runs again.
    expect((await send(statusApi, f, f.P, { requestId })).halted).toBeNull()
    expect(await retryDead(f, f.P)).toBe(1)
    expect((await drain(f.firmId, clock, deps)).every((o) => o === "done")).toBe(true)
    const done = await send(statusApi, f, f.P, { requestId })
    expect(done).toMatchObject({ status: "completed", halted: null })
    expect(await processorRequests(requestId)).toEqual([{ id: `${requestId}_opik`, status: "pending_operator", traceIds: ["trace-held-1"] }])
  })

  it("a hold placed after prepare holds the issued instruction at once, halts the purge, and its release returns the instruction", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    await adminDb().collection("ai_usage_logs").doc(uniq("u")).set({ firmId: f.firmId, matterId: f.matterId, model: "m", costMicroUsd: 1, trace: { id: "trace-mid-1", status: "exported" }, createdAt: Timestamp.now() })
    const { requestId, approved } = await requestAndApprove(f)
    const clock = new FakeClock(Date.now())
    const deps = testDeps(clock)
    expect(await runJobTask({ jobId: approved.jobId!, seq: 0 }, deps)).toBe("done")
    expect((await processorRequests(requestId)).map((r) => r.status)).toEqual(["pending_operator"])
    await send(holdApi, f, f.P, { matterId: f.matterId, reasonCode: "regulator_request" })
    // The hold's own transaction moved the instruction to held, before any saga step noticed it.
    expect((await processorRequests(requestId)).map((r) => r.status)).toEqual(["held"])
    expect(await drain(f.firmId, clock, deps)).toContain("dead_lettered")
    expect((await send(statusApi, f, f.P, { requestId })).halted).toMatchObject({ code: "legal_hold_active" })
    expect((await processorRequests(requestId)).map((r) => r.status)).toEqual(["held"])
    await send(releaseApi, f, f.Q, { matterId: f.matterId })
    expect((await processorRequests(requestId)).map((r) => r.status)).toEqual(["pending_operator"])
    expect(await retryDead(f, f.P)).toBeGreaterThan(0)
    expect((await drain(f.firmId, clock, deps)).every((o) => o === "done")).toBe(true)
    expect((await send(statusApi, f, f.P, { requestId })).status).toBe("completed")
    expect((await processorRequests(requestId)).map((r) => r.status)).toEqual(["pending_operator"])
  })

  it("a hold placed after the saga finished still stops the operator: the pending instruction moves to held", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    await adminDb().collection("ai_usage_logs").doc(uniq("u")).set({ firmId: f.firmId, matterId: f.matterId, model: "m", costMicroUsd: 1, trace: { id: "trace-late-1", status: "exported" }, createdAt: Timestamp.now() })
    const { requestId } = await requestAndApprove(f)
    await drain(f.firmId, new FakeClock(Date.now()))
    expect((await send(statusApi, f, f.P, { requestId })).status).toBe("completed")
    await send(holdApi, f, f.Q, { matterId: f.matterId, reasonCode: "court_order" })
    expect((await processorRequests(requestId)).map((r) => r.status)).toEqual(["held"])
  })

  it("FA-F42-R1-004-001: halt() moves pending_operator to held when the hold bypasses placeLegalHold's instruction move", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    await adminDb().collection("ai_usage_logs").doc(uniq("u")).set({ firmId: f.firmId, matterId: f.matterId, model: "m", costMicroUsd: 1, trace: { id: "trace-halt-move-1", status: "exported" }, createdAt: Timestamp.now() })
    const { requestId, approved } = await requestAndApprove(f)
    let seededHold = false
    retentionTestSeam.afterStep = async (stepId) => {
      if (seededHold || !stepId.startsWith("external-")) return
      seededHold = true
      // Same pattern as FA-F42-R1-012: an active hold without placeLegalHoldOp's moveInstructions (defence-in-depth is halt()'s job).
      await adminDb().collection("legal_holds").doc(f.matterId).set({
        firmId: f.firmId,
        matterId: f.matterId,
        active: true,
        reasonCode: "litigation_anticipated",
        placedBy: f.P.uid,
        placedAt: Timestamp.now(),
      })
    }
    expect(await runJobTask({ jobId: approved.jobId!, seq: 0 }, testDeps(new FakeClock(Date.now())))).toBe("dead_lettered")
    expect(seededHold).toBe(true)
    expect((await processorRequests(requestId)).map((r) => r.status)).toEqual(["held"])
    expect((await send(statusApi, f, f.P, { requestId })).halted).toMatchObject({ code: "legal_hold_active" })
  })
})

describe.skipIf(!EMULATORS)("FA-F42-R1-002: legacy committee outputs (no matterId) are purged by their documents", () => {
  it("the saga purges every legacy output that names a document of the matter, in batches of 30, and counts it truthfully", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const db = adminDb()
    // 31 documents, so the matter's ids span two array-contains-any batches of 30.
    const docIds = Array.from({ length: 31 }, (_, i) => `${f.matterId}-doc${String(i).padStart(2, "0")}`)
    for (const id of docIds) await db.collection("documents").doc(id).set({ firmId: f.firmId, matterId: f.matterId, classification: "internal" })
    const otherDoc = `${f.matterId}-elsewhere`
    await db.collection("documents").doc(otherDoc).set({ firmId: f.firmId, matterId: "another-matter", classification: "internal" })
    const legacy = (id: string, documentIds: string[], extra: DocumentData = {}) =>
      db.collection("committee_outputs").doc(`${f.matterId}-${id}`).set({ firmId: f.firmId, actorId: f.P.uid, documentIds, text: `${TITLE} legacy answer`, classification: "internal", createdAt: Date.now(), ...extra })
    await legacy("null", [docIds[0]], { matterId: null })
    await legacy("absent", [docIds[5], otherDoc])
    await legacy("second-batch", [docIds[30]], { matterId: null })
    // Kept: a legacy row of another matter's document only, and a row of another matter that names one of ours.
    await legacy("keep-other-doc", [otherDoc], { matterId: null })
    await legacy("keep-other-matter", [docIds[1]], { matterId: "another-matter" })
    // The current shape: matterId set, purged by the store's own query as before.
    await legacy("current", [docIds[2]], { matterId: f.matterId })
    const { requestId } = await requestAndApprove(f)
    await drain(f.firmId, new FakeClock(Date.now()))
    const view = await send(statusApi, f, f.P, { requestId })
    expect(view.status).toBe("completed")
    const exists = async (id: string) => (await db.collection("committee_outputs").doc(`${f.matterId}-${id}`).get()).exists
    for (const id of ["null", "absent", "second-batch", "current"]) expect(await exists(id), id).toBe(false)
    for (const id of ["keep-other-doc", "keep-other-matter"]) expect(await exists(id), id).toBe(true)
    // The acknowledgement counts every output the saga purged, the legacy ones included.
    expect(view.acks.find((a) => a.storeId === "firestore:committee_outputs")).toMatchObject({ outcome: "purged", count: 4 })
    expect(view.acks.find((a) => a.storeId === "firestore:documents")).toMatchObject({ outcome: "purged", count: 31 })
  })

  it("FA-F42-R1-002-001: legacy outputs are purged when document rows were removed before the saga (document_versions ids)", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const db = adminDb()
    const docId = `${f.matterId}-predeleted`
    await db.collection("committee_outputs").doc(`${f.matterId}-legacy-pre`).set({
      firmId: f.firmId,
      actorId: f.P.uid,
      matterId: null,
      documentIds: [docId],
      text: `${TITLE} legacy before docs gone`,
      classification: "internal",
      createdAt: Date.now(),
    })
    // Document row gone before g0; version row still names the matter (typical between manual doc delete and saga).
    await db.collection("document_versions").doc(`${docId}_v1`).set({
      firmId: f.firmId,
      matterId: f.matterId,
      documentId: docId,
      version: 1,
      storagePath: "fs://x",
      classification: "internal",
      createdBy: f.P.uid,
    })
    const keepDoc = `${f.matterId}-other-matter-doc`
    await db.collection("documents").doc(keepDoc).set({ firmId: f.firmId, matterId: "another-matter", classification: "internal" })
    await db.collection("committee_outputs").doc(`${f.matterId}-keep-other`).set({
      firmId: f.firmId,
      actorId: f.P.uid,
      matterId: null,
      documentIds: [keepDoc],
      text: `${TITLE} other matter`,
      classification: "internal",
      createdAt: Date.now(),
    })
    const { requestId } = await requestAndApprove(f)
    await drain(f.firmId, new FakeClock(Date.now()))
    expect((await send(statusApi, f, f.P, { requestId })).status).toBe("completed")
    expect((await db.collection("committee_outputs").doc(`${f.matterId}-legacy-pre`).get()).exists).toBe(false)
    expect((await db.collection("committee_outputs").doc(`${f.matterId}-keep-other`).get()).exists).toBe(true)
  })

  it("FA-F42-R1-002-001-003: absent-matterId legacy output is purged when documents and versions are gone but a matter job still names the document", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const db = adminDb()
    const docId = `${f.matterId}-trail-only`
    await db.collection("committee_outputs").doc(`${f.matterId}-legacy-absent-trail`).set({
      firmId: f.firmId,
      actorId: f.P.uid,
      documentIds: [docId],
      text: `${TITLE} legacy absent field no matterId key`,
      classification: "internal",
      createdAt: Date.now(),
    })
    await db.collection("jobs").doc(`${docId}-job-trail`).set({
      firmId: f.firmId,
      matterId: f.matterId,
      documentId: docId,
      jobType: "ocr",
      classification: "internal",
      engine: "p2",
      status: "done",
    })
    await db.collection("documents").doc(`${f.matterId}-live`).set({ firmId: f.firmId, matterId: f.matterId, classification: "internal" })
    const { requestId } = await requestAndApprove(f)
    await drain(f.firmId, new FakeClock(Date.now()))
    expect((await send(statusApi, f, f.P, { requestId })).status).toBe("completed")
    expect((await db.collection("committee_outputs").doc(`${f.matterId}-legacy-absent-trail`).get()).exists).toBe(false)
  })

  it.each([
    [
      "ocr_texts",
      async (db: ReturnType<typeof adminDb>, f: Firm, docId: string) => {
        await db.collection("ocr_texts").doc(`${docId}-ocr-trail`).set({
          firmId: f.firmId,
          matterId: f.matterId,
          documentId: docId,
          classification: "internal",
          text: `${TITLE} matter ocr trail`,
        })
      },
    ],
    [
      "p1_ocr_operations",
      async (db: ReturnType<typeof adminDb>, f: Firm, docId: string) => {
        await db.collection("p1_ocr_operations").doc(`${docId}-op-trail`).set({
          firmId: f.firmId,
          matterId: f.matterId,
          documentId: docId,
          classification: "internal",
          text: `${TITLE} matter op trail`,
        })
      },
    ],
  ] as const)(
    "FA-F42-R1-002-001-003-004: absent-matterId legacy output is purged when the matter %s trail names its documentId on the first page",
    async (collection, seedMatterTrail) => {
      retentionTestSeam.policy = testPolicy()
      const f = await newFirm()
      const db = adminDb()
      const docId = `${f.matterId}-first-page-${collection}-trail`
      await db.collection("committee_outputs").doc(`${f.matterId}-legacy-${collection}-trail`).set({
        firmId: f.firmId,
        actorId: f.P.uid,
        documentIds: [docId],
        text: `${TITLE} legacy first-page ${collection} trail`,
        classification: "internal",
        createdAt: Date.now(),
      })
      await seedMatterTrail(db, f, docId)
      await db.collection("documents").doc(`${f.matterId}-live`).set({ firmId: f.firmId, matterId: f.matterId, classification: "internal" })
      const { requestId } = await requestAndApprove(f)
      await drain(f.firmId, new FakeClock(Date.now()))
      const prep = await db.collection("deletion_requests").doc(requestId).get()
      expect((prep.get("legacyTrailDocumentIds") as string[] | undefined) ?? []).toContain(docId)
      expect((await send(statusApi, f, f.P, { requestId })).status).toBe("completed")
      expect((await db.collection("committee_outputs").doc(`${f.matterId}-legacy-${collection}-trail`).get()).exists).toBe(false)
    }
  )

  it("FA-F42-R1-002-001-003-001: absent-matterId legacy output is purged via matter document_workflow when version/ocr/job trails are gone", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const db = adminDb()
    const docId = `${f.matterId}-workflow-trail`
    await db.collection("committee_outputs").doc(`${f.matterId}-legacy-workflow-trail`).set({
      firmId: f.firmId,
      actorId: f.P.uid,
      documentIds: [docId],
      text: `${TITLE} legacy absent field workflow trail`,
      classification: "internal",
      createdAt: Date.now(),
    })
    await db.collection("document_workflow").doc(docId).set({
      firmId: f.firmId,
      matterId: f.matterId,
      documentId: docId,
      status: "review_required",
      reviewerId: null,
      updatedAt: Date.now(),
    })
    await db.collection("documents").doc(`${f.matterId}-live`).set({ firmId: f.firmId, matterId: f.matterId, classification: "internal" })
    const { requestId } = await requestAndApprove(f)
    await drain(f.firmId, new FakeClock(Date.now()))
    expect((await send(statusApi, f, f.P, { requestId })).status).toBe("completed")
    expect((await db.collection("committee_outputs").doc(`${f.matterId}-legacy-workflow-trail`).get()).exists).toBe(false)
  })

  it("FA-F42-R1-002-001-003-001: absent-matterId legacy output is purged via a matter-scoped committee output naming the same documentIds", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const db = adminDb()
    const docId = `${f.matterId}-sibling-output-trail`
    await db.collection("committee_outputs").doc(`${f.matterId}-legacy-sibling-trail`).set({
      firmId: f.firmId,
      actorId: f.P.uid,
      documentIds: [docId],
      text: `${TITLE} legacy absent field sibling output`,
      classification: "internal",
      createdAt: Date.now(),
    })
    await db.collection("committee_outputs").doc(`${f.matterId}-modern-sibling`).set({
      firmId: f.firmId,
      matterId: f.matterId,
      actorId: f.P.uid,
      documentIds: [docId],
      text: `${TITLE} modern matter scoped output`,
      classification: "internal",
      createdAt: Date.now(),
    })
    await db.collection("documents").doc(`${f.matterId}-live`).set({ firmId: f.firmId, matterId: f.matterId, classification: "internal" })
    const { requestId } = await requestAndApprove(f)
    await drain(f.firmId, new FakeClock(Date.now()))
    expect((await send(statusApi, f, f.P, { requestId })).status).toBe("completed")
    expect((await db.collection("committee_outputs").doc(`${f.matterId}-legacy-sibling-trail`).get()).exists).toBe(false)
  })

  it("FA-F42-R1-002-001-003-001 PARTIAL: absent-matterId legacy output with no matter-scoped trail naming its documentId is kept", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const db = adminDb()
    const docId = `${f.matterId}-no-trail-anywhere`
    await db.collection("committee_outputs").doc(`${f.matterId}-legacy-no-trail`).set({
      firmId: f.firmId,
      actorId: f.P.uid,
      documentIds: [docId],
      text: `${TITLE} legacy no discovery path`,
      classification: "internal",
      createdAt: Date.now(),
    })
    await db.collection("documents").doc(`${f.matterId}-live`).set({ firmId: f.firmId, matterId: f.matterId, classification: "internal" })
    const { requestId } = await requestAndApprove(f)
    await drain(f.firmId, new FakeClock(Date.now()))
    expect((await send(statusApi, f, f.P, { requestId })).status).toBe("completed")
    expect((await db.collection("committee_outputs").doc(`${f.matterId}-legacy-no-trail`).get()).exists).toBe(true)
  })

  it.each([
    [
      "ocr_texts",
      async (db: ReturnType<typeof adminDb>, f: Firm, docId: string, otherMatter: string) => {
        await db.collection("ocr_texts").doc(`${otherMatter}-${docId}-ocr`).set({
          firmId: f.firmId,
          matterId: otherMatter,
          documentId: docId,
          classification: "internal",
          text: `${TITLE} other matter ocr decoy`,
        })
      },
    ],
    [
      "p1_ocr_operations",
      async (db: ReturnType<typeof adminDb>, f: Firm, docId: string, otherMatter: string) => {
        await db.collection("p1_ocr_operations").doc(`${otherMatter}-${docId}-op`).set({
          firmId: f.firmId,
          matterId: otherMatter,
          documentId: docId,
          classification: "internal",
          text: `${TITLE} other matter op decoy`,
        })
      },
    ],
    [
      "document_workflow",
      async (db: ReturnType<typeof adminDb>, f: Firm, docId: string, otherMatter: string) => {
        await db.collection("document_workflow").doc(`${otherMatter}-${docId}-wf`).set({
          firmId: f.firmId,
          matterId: otherMatter,
          documentId: docId,
          status: "review_required",
          reviewerId: null,
          updatedAt: Date.now(),
        })
      },
    ],
  ] as const)(
    "FA-F42-R1-002-001-003-001-002: absent-matterId legacy output is kept when only other-matter %s names its documentId",
    async (collection, seedOtherMatterTrail) => {
      retentionTestSeam.policy = testPolicy()
      const f = await newFirm()
      const db = adminDb()
      const otherMatter = "another-matter-trail-decoy"
      const docId = `${f.matterId}-no-matter-trail-${collection}`
      await db.collection("committee_outputs").doc(`${f.matterId}-legacy-other-trail-${collection}`).set({
        firmId: f.firmId,
        actorId: f.P.uid,
        documentIds: [docId],
        text: `${TITLE} legacy other matter ${collection} decoy`,
        classification: "internal",
        createdAt: Date.now(),
      })
      await seedOtherMatterTrail(db, f, docId, otherMatter)
      await db.collection("documents").doc(`${f.matterId}-live`).set({ firmId: f.firmId, matterId: f.matterId, classification: "internal" })
      const { requestId } = await requestAndApprove(f)
      await drain(f.firmId, new FakeClock(Date.now()))
      expect((await send(statusApi, f, f.P, { requestId })).status).toBe("completed")
      expect((await db.collection("committee_outputs").doc(`${f.matterId}-legacy-other-trail-${collection}`).get()).exists).toBe(true)
    }
  )

  it("FA-F42-R1-002-001-003-003: absent-matterId legacy output is purged when the matter ocr_texts trail names its documentId past the first page", async () => {
    retentionTestSeam.policy = testPolicy()
    retentionTestSeam.trailDocumentIdPageSize = 2
    const f = await newFirm()
    const db = adminDb()
    const docId = `${f.matterId}-past-first-ocr-page`
    await db.collection("committee_outputs").doc(`${f.matterId}-legacy-paged-ocr-trail`).set({
      firmId: f.firmId,
      actorId: f.P.uid,
      documentIds: [docId],
      text: `${TITLE} legacy paged ocr trail`,
      classification: "internal",
      createdAt: Date.now(),
    })
    // Two filler rows on page one; the legacy id sits on page two (stable orderBy document id).
    await db.collection("ocr_texts").doc(`${f.matterId}-ocr-page-a`).set({
      firmId: f.firmId,
      matterId: f.matterId,
      documentId: `${f.matterId}-decoy-a`,
      classification: "internal",
      text: "decoy",
    })
    await db.collection("ocr_texts").doc(`${f.matterId}-ocr-page-b`).set({
      firmId: f.firmId,
      matterId: f.matterId,
      documentId: `${f.matterId}-decoy-b`,
      classification: "internal",
      text: "decoy",
    })
    await db.collection("ocr_texts").doc(`${f.matterId}-ocr-page-target`).set({
      firmId: f.firmId,
      matterId: f.matterId,
      documentId: docId,
      classification: "internal",
      text: "target trail",
    })
    await db.collection("documents").doc(`${f.matterId}-live`).set({ firmId: f.firmId, matterId: f.matterId, classification: "internal" })
    const { requestId } = await requestAndApprove(f)
    await drain(f.firmId, new FakeClock(Date.now()))
    const prep = await db.collection("deletion_requests").doc(requestId).get()
    expect((prep.get("legacyTrailDocumentIds") as string[] | undefined) ?? []).toContain(docId)
    expect((await send(statusApi, f, f.P, { requestId })).status).toBe("completed")
    expect((await db.collection("committee_outputs").doc(`${f.matterId}-legacy-paged-ocr-trail`).get()).exists).toBe(false)
  })

  it.each([
    [
      "p1_ocr_operations",
      async (db: ReturnType<typeof adminDb>, f: Firm, docId: string) => {
        await db.collection("p1_ocr_operations").doc(`${f.matterId}-op-page-a`).set({
          firmId: f.firmId,
          matterId: f.matterId,
          documentId: `${f.matterId}-decoy-a`,
          classification: "internal",
          text: "decoy",
        })
        await db.collection("p1_ocr_operations").doc(`${f.matterId}-op-page-b`).set({
          firmId: f.firmId,
          matterId: f.matterId,
          documentId: `${f.matterId}-decoy-b`,
          classification: "internal",
          text: "decoy",
        })
        await db.collection("p1_ocr_operations").doc(`${f.matterId}-op-page-target`).set({
          firmId: f.firmId,
          matterId: f.matterId,
          documentId: docId,
          classification: "internal",
          text: "target trail",
        })
      },
    ],
    [
      "jobs",
      async (db: ReturnType<typeof adminDb>, f: Firm, docId: string) => {
        await db.collection("jobs").doc(`${f.matterId}-job-page-a`).set({
          firmId: f.firmId,
          matterId: f.matterId,
          documentId: `${f.matterId}-decoy-a`,
          jobType: "ocr",
          classification: "internal",
          engine: "p2",
          status: "done",
        })
        await db.collection("jobs").doc(`${f.matterId}-job-page-b`).set({
          firmId: f.firmId,
          matterId: f.matterId,
          documentId: `${f.matterId}-decoy-b`,
          jobType: "ocr",
          classification: "internal",
          engine: "p2",
          status: "done",
        })
        await db.collection("jobs").doc(`${f.matterId}-job-page-target`).set({
          firmId: f.firmId,
          matterId: f.matterId,
          documentId: docId,
          jobType: "ocr",
          classification: "internal",
          engine: "p2",
          status: "done",
        })
      },
    ],
  ] as const)(
    "FA-F42-R1-002-001-003-003-001: absent-matterId legacy output is purged when the matter %s trail names its documentId past the first page",
    async (_collection, seedPagedTrail) => {
      retentionTestSeam.policy = testPolicy()
      retentionTestSeam.trailDocumentIdPageSize = 2
      const f = await newFirm()
      const db = adminDb()
      const docId = `${f.matterId}-past-first-${_collection}-page`
      await db.collection("committee_outputs").doc(`${f.matterId}-legacy-paged-${_collection}-trail`).set({
        firmId: f.firmId,
        actorId: f.P.uid,
        documentIds: [docId],
        text: `${TITLE} legacy paged ${_collection} trail`,
        classification: "internal",
        createdAt: Date.now(),
      })
      await seedPagedTrail(db, f, docId)
      await db.collection("documents").doc(`${f.matterId}-live`).set({ firmId: f.firmId, matterId: f.matterId, classification: "internal" })
      const { requestId } = await requestAndApprove(f)
      await drain(f.firmId, new FakeClock(Date.now()))
      const prep = await db.collection("deletion_requests").doc(requestId).get()
      expect((prep.get("legacyTrailDocumentIds") as string[] | undefined) ?? []).toContain(docId)
      expect((await send(statusApi, f, f.P, { requestId })).status).toBe("completed")
      expect((await db.collection("committee_outputs").doc(`${f.matterId}-legacy-paged-${_collection}-trail`).get()).exists).toBe(false)
    }
  )

  it("FA-F42-R1-002-001-001 P3: a firm orphan legacy output is not purged or counted on another matter's deletion", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const db = adminDb()
    const otherMatter = "another-matter-orphan"
    const orphanDoc = `${otherMatter}-gone-doc`
    await db.collection("committee_outputs").doc("firm-orphan-legacy").set({
      firmId: f.firmId,
      actorId: f.P.uid,
      matterId: null,
      documentIds: [orphanDoc],
      text: `${TITLE} unrelated orphan`,
      classification: "internal",
      createdAt: Date.now(),
    })
    await db.collection("documents").doc(`${f.matterId}-only`).set({ firmId: f.firmId, matterId: f.matterId, classification: "internal" })
    const { requestId } = await requestAndApprove(f)
    await drain(f.firmId, new FakeClock(Date.now()))
    const view = await send(statusApi, f, f.P, { requestId })
    expect(view.status).toBe("completed")
    expect((await db.collection("committee_outputs").doc("firm-orphan-legacy").get()).exists).toBe(true)
    expect(view.acks.find((a) => a.storeId === "firestore:committee_outputs")).toMatchObject({ outcome: "purged", count: 0 })
  })

  it("FA-F42-R1-002-001-001 P4: a null-matterId legacy output naming more than three live loose-vault documents is kept", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const db = adminDb()
    const looseIds = Array.from({ length: 4 }, (_, i) => `loose-vault-${i}`)
    for (const id of looseIds) {
      await db.collection("documents").doc(id).set({ firmId: f.firmId, matterId: null, classification: "confidential" })
    }
    await db.collection("committee_outputs").doc("loose-vault-many-ids").set({
      firmId: f.firmId,
      actorId: f.P.uid,
      matterId: null,
      documentIds: looseIds,
      text: `${TITLE} loose vault many docs`,
      classification: "internal",
      createdAt: Date.now(),
    })
    await db.collection("documents").doc(`${f.matterId}-purge-me`).set({ firmId: f.firmId, matterId: f.matterId, classification: "internal" })
    const { requestId } = await requestAndApprove(f)
    await drain(f.firmId, new FakeClock(Date.now()))
    expect((await send(statusApi, f, f.P, { requestId })).status).toBe("completed")
    expect((await db.collection("committee_outputs").doc("loose-vault-many-ids").get()).exists).toBe(true)
  })

  it("a store's first acknowledgement stands: a row purged after it is counted apart and never un-acknowledges the store", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const db = adminDb()
    await db.collection("documents").doc(`${f.matterId}-first`).set({ firmId: f.firmId, matterId: f.matterId, classification: "internal" })
    // The first purge job crashes just after its acknowledgement committed; a row of the matter lands before the retry.
    let crashed = false
    retentionTestSeam.afterStep = async (step) => {
      if (crashed || step !== "ack-g0") return
      crashed = true
      await db.collection("documents").doc(`${f.matterId}-after-ack`).set({ firmId: f.firmId, matterId: f.matterId, classification: "internal" })
      throw new Error("simulated crash after the committed acknowledgement")
    }
    const { requestId, approved } = await requestAndApprove(f)
    const clock = new FakeClock(Date.now())
    const deps = testDeps(clock)
    expect(await runJobTask({ jobId: approved.jobId!, seq: 0 }, deps)).toBe("done")
    // The first group alone, twice: the crash, then its retry while the request is still in progress.
    const g0 = (await db.collection("jobs").where("firmId", "==", f.firmId).where("payload.part", "==", "g0").get()).docs[0]!
    expect(await runJobTask({ jobId: g0.id, seq: g0.get("dispatchSeq") as number }, deps)).toBe("failed")
    expect(crashed).toBe(true)
    const retry = (await db.collection("jobs").doc(g0.id).get()).data()!
    clock.set((retry.nextAttemptAt as Timestamp).toMillis() + 1)
    expect(await runJobTask({ jobId: g0.id, seq: retry.dispatchSeq as number }, deps)).toBe("done")
    await drain(f.firmId, clock, deps)
    const view = await send(statusApi, f, f.P, { requestId })
    expect(view.status).toBe("completed")
    expect(view.acks.find((a) => a.storeId === "firestore:documents")).toMatchObject({ outcome: "purged", count: 1 })
    expect((await db.collection("documents").doc(`${f.matterId}-after-ack`).get()).exists).toBe(false)
    const progress = (await db.collection("deletion_acks").doc(`${requestId}_firestore_documents`).get()).data()
    expect(progress).toMatchObject({ acknowledged: true, count: 1, afterAck: 1 })
  })
})

const brainApi = viaApi<{ outputId?: string; usage?: unknown }>("committeeBrain")

/** The trace ids every part of the request's processor requests holds, and the summary of `processor`. */
async function recordedTraces(requestId: string, processor = "opik"): Promise<{ ids: string[]; summary: DocumentData | undefined }> {
  const snap = await adminDb().collection("deletion_external_requests").where("requestId", "==", requestId).get()
  const ids = snap.docs.filter((d) => typeof d.get("part") === "number").flatMap((d) => d.get("traceIds") as string[])
  return { ids: [...ids].sort(), summary: snap.docs.find((d) => d.id === `${requestId}_${processor}`)?.data() }
}

describe.skipIf(!EMULATORS)("FA-F42-R1-007: the trace of a P1 call in flight at the approval is recorded, never lost", () => {
  it("rows that land after prepare read the ids and before their store's purge: anonymised, and their traces recorded in a new part", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    await adminDb().collection("ai_usage_logs").doc(uniq("u")).set({ firmId: f.firmId, matterId: f.matterId, costMicroUsd: 1, trace: { id: "trace-before", status: "exported" }, createdAt: Timestamp.now() })
    const { requestId, approved } = await requestAndApprove(f)
    const clock = new FakeClock(Date.now())
    const deps = testDeps(clock)
    expect(await runJobTask({ jobId: approved.jobId!, seq: 0 }, deps)).toBe("done")
    // The in-flight call settles now: its usage row and decision record land after prepare read the ids.
    const late = uniq("late-usage")
    await adminDb().collection("ai_usage_logs").doc(late).set({ firmId: f.firmId, matterId: f.matterId, costMicroUsd: 2, trace: { id: "trace-inflight", status: "exported" }, createdAt: Timestamp.now() })
    await adminDb().collection("p1_decisions").doc(late).set({ firmId: f.firmId, matterId: f.matterId, traceId: "trace-inflight", export: { state: "pending", attempts: 0 }, settledAt: Timestamp.now() })
    // A disabled trace never reached the processor: it is not requested.
    await adminDb().collection("ai_usage_logs").doc(uniq("off")).set({ firmId: f.firmId, matterId: f.matterId, costMicroUsd: 1, trace: { id: "trace-disabled", status: "disabled" }, createdAt: Timestamp.now() })
    await drain(f.firmId, clock, deps)
    expect((await send(statusApi, f, f.P, { requestId })).status).toBe("completed")
    const { ids, summary } = await recordedTraces(requestId)
    expect(ids).toEqual(["trace-before", "trace-inflight"])
    expect(summary).toMatchObject({ count: 2, parts: 2, lateIds: 1, status: "pending_operator" })
    expect((await adminDb().collection("ai_usage_logs").doc(late).get()).data()).toMatchObject({ matterId: null, anonymisedBy: requestId })
    expect((await adminDb().collection("p1_decisions").doc(late).get()).data()).toMatchObject({ matterId: null, anonymisedBy: requestId })
  })

  it("a call in flight when prepare found no trace at all: the late trace still creates the processor request", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const { requestId, approved } = await requestAndApprove(f)
    const clock = new FakeClock(Date.now())
    const deps = testDeps(clock)
    expect(await runJobTask({ jobId: approved.jobId!, seq: 0 }, deps)).toBe("done")
    expect((await recordedTraces(requestId)).summary).toBeUndefined()
    await adminDb().collection("ai_usage_logs").doc(uniq("late")).set({ firmId: f.firmId, matterId: f.matterId, costMicroUsd: 2, trace: { id: "trace-only-late", status: "exported" }, createdAt: Timestamp.now() })
    await drain(f.firmId, clock, deps)
    const { ids, summary } = await recordedTraces(requestId)
    expect(ids).toEqual(["trace-only-late"])
    expect(summary).toMatchObject({ count: 1, parts: 1, lateIds: 1, status: "pending_operator" })
  })

  it("a committee call in flight across the approval and the whole saga: its rows lose the matter at write, its trace is recorded, nothing is published", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    await firmConfigRef(f.firmId).set({ monthlyBudgetMicroUsd: 1_000_000_000 })
    setAuthorityStoreForTests(new InMemoryAuthorityStore())
    // Opik on (self-hosted, confirmed) behind a fake fetch, so the call's trace is exported; the provider faked at its transport.
    vi.stubEnv("OPIK_BASE_URL", "http://opik.test.internal")
    vi.stubEnv("OPIK_SELF_HOSTED_CONFIRMED", "true")
    setOpikFetchForTests((async () => new Response(null, { status: 204 })) as typeof fetch)
    setP1TransportForTests({
      id: "f42r1-fake-gateway",
      async send() {
        return { text: "A plain answer.", inputTokens: 100, outputTokens: 50, model: "claude-opus-5.5", responseId: "resp-f42r1" }
      },
    } as never)
    // The approval and the whole saga happen while the call is between its provider answer and its commit.
    let requestId = ""
    p1TestSeam.beforeCommit = async () => {
      requestId = (await requestAndApprove(f)).requestId
      await drain(f.firmId, new FakeClock(Date.now()))
      expect((await send(statusApi, f, f.Q, { requestId })).status).toBe("completed")
    }
    const err = await apiErrorOf(send(brainApi, f, f.P, { matterId: f.matterId, body: "Summarise the position on bail." }))
    expect(`${err.status} ${err.code}`).toBe("403 matter_deleted")
    expect(requestId).not.toBe("")
    const usage = await adminDb().collection("ai_usage_logs").where("firmId", "==", f.firmId).get()
    expect(usage.size).toBe(1)
    const row = usage.docs[0]!
    expect(row.data()).toMatchObject({ matterId: null, anonymisedBy: requestId, trace: { status: "exported" } })
    expect((await adminDb().collection("p1_decisions").doc(row.id).get()).data()).toMatchObject({ matterId: null, anonymisedBy: requestId })
    const { ids, summary } = await recordedTraces(requestId)
    expect(ids).toEqual([row.get("trace.id")])
    expect(summary).toMatchObject({ count: 1, lateIds: 1, status: "pending_operator" })
    // The answer was refused at its publication: no committee output names the deleted matter.
    expect((await adminDb().collection("committee_outputs").where("firmId", "==", f.firmId).get()).size).toBe(0)
  })
})

/** A POST through the router with a fixed Idempotency-Key (FA-F42-R1-001: to replay it). */
async function postWithKey(path: string, m: Member, firmId: string, body: Record<string, unknown>, key: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const { res, out } = mockRes()
  await createRouter(ROUTES)(
    {
      method: "POST",
      path,
      headers: { authorization: `Bearer ${m.token}`, "x-firm-id": firmId, "content-type": "application/json", "idempotency-key": key, "x-forwarded-for": `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
      body,
      query: {},
      ip: "127.0.0.1",
    } as never,
    res as never
  )
  return { status: out.status as number, body: (out.body ?? {}) as Record<string, unknown> }
}

const CREATE_DRAFT = "/api/d4/drafting/createDraft"
const draftBody = (f: Firm) => ({ matterId: f.matterId, documentTypeId: "constitutional_petition_199", title: TITLE, body: "IN THE HIGH COURT. F42R1 replay body." })
const idempotencyRecord = async (firmId: string, key: string) => (await adminDb().collection("idempotency_keys").doc(`${firmId}_${key.toLowerCase()}`).get()).data()

describe.skipIf(!EMULATORS)("FA-F42-R1-001: a stored answer is not replayed for a deleted matter", () => {
  it("createDraft: a same-key replay after the approval is refused 403 matter_deleted, as a fresh call is; before it, it replays", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const key = randomUUID()
    const first = await postWithKey(CREATE_DRAFT, f.P, f.firmId, draftBody(f), key)
    expect(first.status).toBe(200)
    // Control: before the tombstone the key replays its stored answer.
    const again = await postWithKey(CREATE_DRAFT, f.P, f.firmId, draftBody(f), key)
    expect(again).toMatchObject({ status: 200, body: { reused: true } })
    // The record names the matter its operation touched.
    expect((await idempotencyRecord(f.firmId, key))?.matterIds).toEqual([f.matterId])
    await requestAndApprove(f)
    const fresh = await postWithKey(CREATE_DRAFT, f.P, f.firmId, draftBody(f), randomUUID())
    expect(`${fresh.status} ${JSON.stringify(fresh.body)}`).toBe('403 {"error":{"code":"matter_deleted"}}')
    const denies = async () =>
      (await adminDb().collection("audit_log").where("action", "==", "draft.create").where("actorId", "==", f.P.uid).get()).docs
        .map((d) => d.data())
        .filter((r) => r.decision === "deny" && r.reason === "matter_deleted")
    const beforeReplay = (await denies()).length
    const replay = await postWithKey(CREATE_DRAFT, f.P, f.firmId, draftBody(f), key)
    expect(`${replay.status} ${JSON.stringify(replay.body)}`).toBe('403 {"error":{"code":"matter_deleted"}}')
    expect(JSON.stringify(replay.body)).not.toContain(TITLE)
    // The refused replay is audited as a deny like every other idempotency refusal (spec R21), naming no matter content.
    const afterReplay = await denies()
    expect(afterReplay).toHaveLength(beforeReplay + 1)
    expect(afterReplay.map((r) => r.firmId)).toContain(f.firmId)
    expect(JSON.stringify(afterReplay)).not.toContain(TITLE)
    // Nothing was rewritten: the record keeps its answer until its TTL deletes it.
    expect((await idempotencyRecord(f.firmId, key))?.status).toBe("done")
  })

  it("a record stored before this change (no matter list) is judged by the matter ids in its stored answer", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const key = randomUUID()
    expect((await postWithKey(CREATE_DRAFT, f.P, f.firmId, draftBody(f), key)).status).toBe(200)
    await adminDb().collection("idempotency_keys").doc(`${f.firmId}_${key}`).update({ matterIds: FieldValue.delete(), matterIdsTruncated: FieldValue.delete() })
    await requestAndApprove(f)
    expect((await postWithKey(CREATE_DRAFT, f.P, f.firmId, draftBody(f), key)).status).toBe(403)
  })

  it("a record whose matter list was cut short never replays (fail closed); a retention route's answer still replays", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const key = randomUUID()
    expect((await postWithKey(CREATE_DRAFT, f.P, f.firmId, draftBody(f), key)).status).toBe(200)
    await adminDb().collection("idempotency_keys").doc(`${f.firmId}_${key}`).update({ matterIdsTruncated: true })
    const cut = await postWithKey(CREATE_DRAFT, f.P, f.firmId, draftBody(f), key)
    expect(`${cut.status} ${(cut.body.error as { code?: string } | undefined)?.code}`).toBe("409 idempotency_replay_unavailable")
    const unavailable = await adminDb().collection("audit_log").where("action", "==", "draft.create").where("actorId", "==", f.P.uid).where("reason", "==", "idempotency_replay_unavailable").get()
    expect(unavailable.docs.map((d) => d.data().decision)).toEqual(["deny"])
    // Firm administration about the deletion itself names no matter in a permission check: its answer replays.
    const reqKey = randomUUID()
    const requested = await postWithKey("/api/platform/retention/requestMatterDeletion", f.P, f.firmId, { matterId: f.matterId, reasonCode: "client_instruction" }, reqKey)
    expect(requested.status).toBe(200)
    await send(approveApi, f, f.Q, { requestId: (requested.body as { requestId: string }).requestId })
    const replayed = await postWithKey("/api/platform/retention/requestMatterDeletion", f.P, f.firmId, { matterId: f.matterId, reasonCode: "client_instruction" }, reqKey)
    expect(replayed).toMatchObject({ status: 200, body: { reused: true, status: "pending_approval" } })
  })
})


const getJobApi = viaApi<Record<string, unknown>>("getJob")
const listJobsApi = viaApi<{ items: Array<{ jobId: string }> }>("listJobs")
const cancelJobApi = viaApi<Record<string, unknown>>("cancelJob")

describe.skipIf(!EMULATORS)("FA-F42-R1-009: a deleted matter's job rows are hidden", () => {
  it("getJob, the firm queue (listJobs) and cancelJob no longer show the tombstoned matter's job; before the approval they do", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const { jobId } = await adminDb().runTransaction((tx) =>
      enqueueJob(tx, { firmId: f.firmId, jobType: "platform.diagnostic", classification: "internal", matterId: f.matterId, payload: { behaviour: "succeed" }, idempotencyKey: uniq("k"), createdBy: f.P.uid }, { now: Date.now() })
    )
    // Control: the member partner sees the job in full, and the firm queue lists it.
    expect((await send(getJobApi, f, f.P, { jobId })).matterId).toBe(f.matterId)
    expect((await send(listJobsApi, f, f.P, { limit: "50" })).items.map((i) => i.jobId)).toContain(jobId)
    await requestAndApprove(f)
    // No saga job has run: every refusal below comes from the tombstone (the matter row and the job row are intact).
    expect(`${(await apiErrorOf(send(getJobApi, f, f.P, { jobId }))).status}`).toBe("404")
    expect((await send(listJobsApi, f, f.P, { limit: "50" })).items.map((i) => i.jobId)).not.toContain(jobId)
    const cancel = await apiErrorOf(send(cancelJobApi, f, f.P, { jobId, note: "Cancelled after the matter was deleted." }))
    expect(cancel.status).toBe(404)
  })
})

const createFirmUserApi = viaApi<{ uid: string }>("createFirmUser")
const attestIndependentPartnerApi = viaApi<{ uid: string }>("attestIndependentPartner")
const onboardFirmApi = viaApi<{ firmId: string }>("onboardFirm")
const setUserClaimsApi = viaApi<Record<string, unknown>>("setUserClaims")
const PASSWORD = "f42r1-pass-123"

/** Signs in an emulator account with a password set here (stands in for the reset link its owner receives). */
async function signIn(uid: string, email: string): Promise<Member> {
  await adminAuth().updateUser(uid, { password: PASSWORD })
  const res = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  })
  if (!res.ok) throw new Error(`emulator sign-in failed: ${res.status}`)
  return { uid, email, token: ((await res.json()) as { idToken: string }).idToken }
}

/** Backdates the user doc's timestamp fields by the given number of days. */
const ageUser = (uid: string, fields: Record<string, number>) =>
  adminDb().collection("users").doc(uid).set(Object.fromEntries(Object.entries(fields).map(([k, days]) => [k, Timestamp.fromMillis(Date.now() - days * DAY_MS)])), { merge: true })

describe.skipIf(!EMULATORS)("FA-F42-R1-006: the approver must be independent of the requester", () => {
  it("FP7: a sole partner who mints a second partner account cannot approve their own request with it", async () => {
    retentionTestSeam.policy = testPolicy()
    const firmId = uniq("f42r1solo")
    firms.push(firmId)
    await adminDb().collection("firms").doc(firmId).set({ name: "SOLO", plan: "internal", rateLimits: { general: 5000 } })
    const P = await member(firmId, "partner", { independentPartner: true })
    const f: Firm = { firmId, P, Q: P, A: P, matterId: uniq("f42r1solom") }
    await seedMatter(firmId, f.matterId, TITLE, [P.uid])
    const req = await send(requestApi, f, P, { matterId: f.matterId, reasonCode: "client_instruction" })
    const email = `${uniq("puppet")}@example.test`
    const { uid } = await send(createFirmUserApi, f, P, { email, role: "partner", clearanceLevel: "privileged-restricted" })
    uids.push(uid)
    const puppet = await signIn(uid, email)
    // createFirmUser records who made the account.
    expect((await adminDb().collection("users").doc(uid).get()).get("createdBy")).toBe(P.uid)
    // Even backdated past any tenure, the account the requester made cannot approve the requester's deletion.
    await ageUser(uid, { createdAt: 400 })
    const err = await apiErrorOf(send(approveApi, f, puppet, { requestId: req.requestId }))
    expect(`${err.status} ${err.code}`).toBe("403 approver_created_by_requester")
    expect((await adminDb().collection("matter_tombstones").doc(f.matterId).get()).exists).toBe(false)
    // The other way round: the puppet files the request for its creator to approve. Refused too.
    const second = uniq("f42r1solom")
    await seedMatter(firmId, second, TITLE, [P.uid])
    const byPuppet = await send(requestApi, f, puppet, { matterId: second, reasonCode: "client_instruction" })
    expect(byPuppet.status).toBe("pending_approval")
    const reverse = await apiErrorOf(send(approveApi, f, P, { requestId: byPuppet.requestId }))
    expect(`${reverse.status} ${reverse.code}`).toBe("403 requester_created_by_approver")
    expect((await adminDb().collection("matter_tombstones").doc(second).get()).exists).toBe(false)
  })

  it("an approver the requester made partner, and one whose account or partner role is too young or unknown, are refused; an established one approves", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const req = await send(requestApi, f, f.P, { matterId: f.matterId, reasonCode: "client_instruction" })
    // A, an established associate, is made partner by the requester; even backdated, still the requester's pick.
    await send(setUserClaimsApi, f, f.P, { uid: f.A.uid, role: "partner" })
    const grant = (await adminDb().collection("users").doc(f.A.uid).get()).data()
    expect(grant?.partnerGrantedBy).toBe(f.P.uid)
    expect(grant?.partnerSince).toBeInstanceOf(Timestamp)
    await ageUser(f.A.uid, { partnerSince: 400 })
    const promoted = await signIn(f.A.uid, f.A.email!)
    expect((await apiErrorOf(send(approveApi, f, promoted, { requestId: req.requestId }))).code).toBe("approver_promoted_by_requester")
    // An account made by someone else, ten days ago: younger than the PROPOSED 30 days.
    const young = await member(f.firmId, "partner", { independentPartner: true })
    await ageUser(young.uid, { createdAt: 10 })
    expect((await apiErrorOf(send(approveApi, f, young, { requestId: req.requestId }))).code).toBe("approver_tenure_too_short")
    // A partner role granted (by another partner) after the request was made: younger than the request.
    const late = await member(f.firmId, "partner", { independentPartner: false })
    await adminDb().collection("users").doc(late.uid).set({ partnerSince: Timestamp.fromMillis(Date.now() + 1_000), partnerGrantedBy: "another-partner" }, { merge: true })
    expect((await apiErrorOf(send(approveApi, f, late, { requestId: req.requestId }))).code).toBe("approver_not_independent")
    // A partner whose claims were changed (updatedAt) with no partnerSince is judged by the change: here, yesterday.
    const changed = await member(f.firmId, "partner", { independentPartner: true })
    await ageUser(changed.uid, { updatedAt: 1 })
    await adminDb().collection("users").doc(changed.uid).set({ claimsVersion: 2 }, { merge: true })
    expect((await apiErrorOf(send(approveApi, f, changed, { requestId: req.requestId }))).code).toBe("approver_tenure_too_short")
    // An account whose start the store cannot tell is refused (fail closed).
    const unknown = await mintIdToken(claims(f.firmId, "partner"))
    uids.push(unknown.uid)
    await adminDb().collection("users").doc(unknown.uid).set({ independentPartner: true }, { merge: true })
    expect((await apiErrorOf(send(approveApi, f, unknown, { requestId: req.requestId }))).code).toBe("approver_tenure_unknown")
    // Each refusal is a deny row in the audit log, naming its code; nothing was tombstoned.
    const audit = await adminDb().collection("audit_log").where("firmId", "==", f.firmId).where("action", "==", "retention.approve_deletion").get()
    const reasons = audit.docs.map((d) => `${d.get("decision")} ${d.get("reason")}`)
    for (const code of ["approver_promoted_by_requester", "approver_tenure_too_short", "approver_tenure_unknown", "approver_not_independent"]) {
      expect(reasons).toContain(`deny ${code}`)
    }
    expect((await adminDb().collection("matter_tombstones").doc(f.matterId).get()).exists).toBe(false)
    // Control: Q, established and independent, approves.
    expect((await send(approveApi, f, f.Q, { requestId: req.requestId })).status).toBe("in_progress")
  })

  it("FA-F42-R1-006-001: unattested two-step create chain stops at approver_not_independent (does not exercise lineage)", async () => {
    retentionTestSeam.policy = testPolicy()
    const firmId = uniq("f42r1chain")
    firms.push(firmId)
    await adminDb().collection("firms").doc(firmId).set({ name: "CHAIN", plan: "internal", rateLimits: { general: 5000 } })
    const P = await member(firmId, "partner", { independentPartner: true })
    const f: Firm = { firmId, P, Q: P, A: P, matterId: uniq("f42r1chainm") }
    await seedMatter(firmId, f.matterId, TITLE, [P.uid])
    const qEmail = `${uniq("mid")}@example.test`
    const { uid: qUid } = await send(createFirmUserApi, f, P, { email: qEmail, role: "partner", clearanceLevel: "privileged-restricted" })
    uids.push(qUid)
    const Q = await signIn(qUid, qEmail)
    await ageUser(qUid, { createdAt: 400, partnerSince: 400 })
    const rEmail = `${uniq("leaf")}@example.test`
    const { uid: rUid } = await send(createFirmUserApi, f, Q, { email: rEmail, role: "partner", clearanceLevel: "privileged-restricted" })
    uids.push(rUid)
    const R = await signIn(rUid, rEmail)
    await ageUser(rUid, { createdAt: 40, partnerSince: 40 })
    expect((await adminDb().collection("users").doc(rUid).get()).get("createdBy")).toBe(Q.uid)
    expect((await adminDb().collection("users").doc(qUid).get()).get("createdBy")).toBe(P.uid)
    const req = await send(requestApi, f, P, { matterId: f.matterId, reasonCode: "client_instruction" })
    const err = await apiErrorOf(send(approveApi, f, R, { requestId: req.requestId }))
    expect(`${err.status} ${err.code}`).toBe("403 approver_not_independent")
    expect((await adminDb().collection("matter_tombstones").doc(f.matterId).get()).exists).toBe(false)
  })

  it("FA-F42-R1-006-003-001-004: attested multi-hop chain refuses leaf approver on transitive lineage (kills M3 unwire refusePartnerLineage)", async () => {
    retentionTestSeam.policy = testPolicy()
    const bootstrapRef = adminDb().collection("platform").doc("bootstrap")
    const savedBootstrap = (await bootstrapRef.get()).exists ? (await bootstrapRef.get()).data() : null
    if (savedBootstrap) await bootstrapRef.delete()
    const founderEmail = `${uniq("f42r1003001004")}@example.test`
    vi.stubEnv("SIKANDER_BOOTSTRAP_FOUNDER_EMAIL", founderEmail)
    try {
      const founder = await mintIdToken(null, { email: founderEmail, emailVerified: true })
      uids.push(founder.uid)
      const { firmId } = await onboardFirmApi({ token: founder.token, data: { name: "Lineage emu attested chain" } } as never)
      const F = await signIn(founder.uid, founderEmail)
      firms.push(firmId)
      const matterId = uniq("f42r1003001004")
      await seedMatter(firmId, matterId, TITLE, [F.uid])
      const f: Firm = { firmId, P: F, Q: F, A: F, matterId }
      const qEmail = `${uniq("lineage-q")}@example.test`
      const { uid: qUid } = await send(createFirmUserApi, f, F, { email: qEmail, role: "partner", clearanceLevel: "privileged-restricted" })
      uids.push(qUid)
      await send(attestIndependentPartnerApi, f, F, { uid: qUid })
      const Q = await signIn(qUid, qEmail)
      const rEmail = `${uniq("lineage-r")}@example.test`
      const { uid: rUid } = await send(createFirmUserApi, f, Q, { email: rEmail, role: "partner", clearanceLevel: "privileged-restricted" })
      uids.push(rUid)
      await send(attestIndependentPartnerApi, f, Q, { uid: rUid })
      const R = await signIn(rUid, rEmail)
      await ageUser(founder.uid, { createdAt: 400, partnerSince: 400 })
      await ageUser(qUid, { createdAt: 400, partnerSince: 400 })
      await ageUser(rUid, { createdAt: 400, partnerSince: 400 })
      expect((await adminDb().collection("users").doc(rUid).get()).get("createdBy")).toBe(Q.uid)
      expect((await adminDb().collection("users").doc(rUid).get()).get("partnerAttestedBy")).toBe(Q.uid)
      expect((await adminDb().collection("users").doc(qUid).get()).get("partnerAttestedBy")).toBe(F.uid)
      const req = await send(requestApi, f, F, { matterId, reasonCode: "client_instruction" })
      const err = await apiErrorOf(send(approveApi, f, R, { requestId: req.requestId }))
      expect(`${err.status} ${err.code}`).toBe("403 approver_lineage_of_requester")
      const deny = (
        await adminDb()
          .collection("audit_log")
          .where("firmId", "==", firmId)
          .where("action", "==", "retention.approve_deletion")
          .where("actorId", "==", R.uid)
          .where("reason", "==", "approver_lineage_of_requester")
          .get()
      ).docs
      expect(deny.length).toBeGreaterThan(0)
      expect((await adminDb().collection("matter_tombstones").doc(matterId).get()).exists).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      if (savedBootstrap) await bootstrapRef.set(savedBootstrap)
      else await bootstrapRef.delete()
    }
  })

  it("FA-F42-R1-006-003-001 RED: a sole founder who attests one hire cannot have that hire approve the founder's deletion request", async () => {
    retentionTestSeam.policy = testPolicy()
    const bootstrapRef = adminDb().collection("platform").doc("bootstrap")
    const savedBootstrap = (await bootstrapRef.get()).exists ? (await bootstrapRef.get()).data() : null
    if (savedBootstrap) await bootstrapRef.delete()
    const founderEmail = `${uniq("f42r1003red-founder")}@example.test`
    vi.stubEnv("SIKANDER_BOOTSTRAP_FOUNDER_EMAIL", founderEmail)
    try {
      const founder = await mintIdToken(null, { email: founderEmail, emailVerified: true })
      uids.push(founder.uid)
      const { firmId } = await onboardFirmApi({ token: founder.token, data: { name: "Attest RED firm" } } as never)
      const F = await signIn(founder.uid, founderEmail)
      firms.push(firmId)
      const f: Firm = { firmId, P: F, Q: F, A: F, matterId: uniq("f42r1003red") }
      await seedMatter(firmId, f.matterId, TITLE, [F.uid])
      const qEmail = `${uniq("attest-q")}@example.test`
      const { uid: qUid } = await send(createFirmUserApi, f, F, { email: qEmail, role: "partner", clearanceLevel: "privileged-restricted" })
      uids.push(qUid)
      const Q = await signIn(qUid, qEmail)
      await send(attestIndependentPartnerApi, f, F, { uid: qUid })
      await ageUser(qUid, { createdAt: 400, partnerSince: 400 })
      const req = await send(requestApi, f, F, { matterId: f.matterId, reasonCode: "client_instruction" })
      const err = await apiErrorOf(send(approveApi, f, Q, { requestId: req.requestId }))
      expect(["approver_created_by_requester", "approver_attested_by_requester"]).toContain(err.code)
      expect((await adminDb().collection("matter_tombstones").doc(f.matterId).get()).exists).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      if (savedBootstrap) await bootstrapRef.set(savedBootstrap)
      else await bootstrapRef.delete()
    }
  })

  it("FA-F42-R1-006-003-001-003 RED: attested-by refusal when the approver was provisioned by another independent partner (not the requester)", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const hEmail = `${uniq("attest-by-h")}@example.test`
    const { uid: hUid } = await send(createFirmUserApi, f, f.Q, { email: hEmail, role: "partner", clearanceLevel: "privileged-restricted" })
    uids.push(hUid)
    const H = await signIn(hUid, hEmail)
    await send(attestIndependentPartnerApi, f, f.P, { uid: hUid })
    await ageUser(hUid, { createdAt: 400, partnerSince: 400 })
    const hDoc = (await adminDb().collection("users").doc(hUid).get()).data() ?? {}
    expect(hDoc.createdBy).toBe(f.Q.uid)
    expect(hDoc.partnerAttestedBy).toBe(f.P.uid)
    expect(hDoc.createdBy).not.toBe(f.P.uid)
    const req = await send(requestApi, f, f.P, { matterId: f.matterId, reasonCode: "client_instruction" })
    const err = await apiErrorOf(send(approveApi, f, H, { requestId: req.requestId }))
    expect(`${err.status} ${err.code}`).toBe("403 approver_attested_by_requester")
    const deny = (
      await adminDb()
        .collection("audit_log")
        .where("firmId", "==", f.firmId)
        .where("action", "==", "retention.approve_deletion")
        .where("actorId", "==", H.uid)
        .where("reason", "==", "approver_attested_by_requester")
        .get()
    ).docs
    expect(deny.length).toBeGreaterThan(0)
    expect((await adminDb().collection("matter_tombstones").doc(f.matterId).get()).exists).toBe(false)
  })

  it("FA-F42-R1-006-003-001-001: sole founder attesting a provisioned hire records declarative audit reason", async () => {
    retentionTestSeam.policy = testPolicy()
    const bootstrapRef = adminDb().collection("platform").doc("bootstrap")
    const savedBootstrap = (await bootstrapRef.get()).exists ? (await bootstrapRef.get()).data() : null
    if (savedBootstrap) await bootstrapRef.delete()
    const founderEmail = `${uniq("f42r1003001001")}@example.test`
    vi.stubEnv("SIKANDER_BOOTSTRAP_FOUNDER_EMAIL", founderEmail)
    try {
      const founder = await mintIdToken(null, { email: founderEmail, emailVerified: true })
      uids.push(founder.uid)
      const { firmId } = await onboardFirmApi({ token: founder.token, data: { name: "Attest audit firm" } } as never)
      const F = await signIn(founder.uid, founderEmail)
      firms.push(firmId)
      const f: Firm = { firmId, P: F, Q: F, A: F, matterId: uniq("f42r1003001001") }
      const qEmail = `${uniq("audit-q")}@example.test`
      const { uid: qUid } = await send(createFirmUserApi, f, F, { email: qEmail, role: "partner", clearanceLevel: "privileged-restricted" })
      uids.push(qUid)
      await send(attestIndependentPartnerApi, f, F, { uid: qUid })
      const rows = (
        await adminDb()
          .collection("audit_log")
          .where("firmId", "==", firmId)
          .where("action", "==", "identity.attest_independent_partner")
          .where("actorId", "==", F.uid)
          .get()
      ).docs.map((d) => d.data())
      expect(rows.some((r) => r.decision === "allow" && r.reason === "sole_independent_attested_provisioned_partner")).toBe(true)
      expect(shippedPolicy.deletion.allowSoleIndependentAttestationOfProvisionedPartners).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      if (savedBootstrap) await bootstrapRef.set(savedBootstrap)
      else await bootstrapRef.delete()
    }
  })

  it("FA-F42-R1-006-003-001-001 RED: policy false refuses sole-independent attestation of a provisioned partner", async () => {
    retentionTestSeam.policy = testPolicy()
    retentionTestSeam.policy!.deletion.allowSoleIndependentAttestationOfProvisionedPartners = false
    const bootstrapRef = adminDb().collection("platform").doc("bootstrap")
    const savedBootstrap = (await bootstrapRef.get()).exists ? (await bootstrapRef.get()).data() : null
    if (savedBootstrap) await bootstrapRef.delete()
    const founderEmail = `${uniq("f42r1003001001red")}@example.test`
    vi.stubEnv("SIKANDER_BOOTSTRAP_FOUNDER_EMAIL", founderEmail)
    try {
      const founder = await mintIdToken(null, { email: founderEmail, emailVerified: true })
      uids.push(founder.uid)
      const { firmId } = await onboardFirmApi({ token: founder.token, data: { name: "Attest refuse firm" } } as never)
      const F = await signIn(founder.uid, founderEmail)
      firms.push(firmId)
      const f: Firm = { firmId, P: F, Q: F, A: F, matterId: uniq("f42r1003001001red") }
      const qEmail = `${uniq("refuse-q")}@example.test`
      const { uid: qUid } = await send(createFirmUserApi, f, F, { email: qEmail, role: "partner", clearanceLevel: "privileged-restricted" })
      uids.push(qUid)
      const err = await apiErrorOf(send(attestIndependentPartnerApi, f, F, { uid: qUid }))
      expect(`${err.status} ${err.code}`).toBe("403 attestation_sole_independent_provisioned_refused")
      const deny = (
        await adminDb()
          .collection("audit_log")
          .where("firmId", "==", firmId)
          .where("action", "==", "identity.attest_independent_partner")
          .where("actorId", "==", F.uid)
          .where("reason", "==", "attestation_sole_independent_provisioned_refused")
          .get()
      ).docs
      expect(deny.length).toBeGreaterThan(0)
      expect((await adminDb().collection("users").doc(qUid).get()).get("independentPartner")).not.toBe(true)
    } finally {
      vi.unstubAllEnvs()
      if (savedBootstrap) await bootstrapRef.set(savedBootstrap)
      else await bootstrapRef.delete()
    }
  })

  it("FA-F42-R1-006-003-001-001-001: F→Q→R second provisioned puppet still uses sole-provisioned path after Q attested", async () => {
    retentionTestSeam.policy = testPolicy()
    const bootstrapRef = adminDb().collection("platform").doc("bootstrap")
    const savedBootstrap = (await bootstrapRef.get()).exists ? (await bootstrapRef.get()).data() : null
    if (savedBootstrap) await bootstrapRef.delete()
    const founderEmail = `${uniq("f42r1003001001001")}@example.test`
    vi.stubEnv("SIKANDER_BOOTSTRAP_FOUNDER_EMAIL", founderEmail)
    try {
      const founder = await mintIdToken(null, { email: founderEmail, emailVerified: true })
      uids.push(founder.uid)
      const { firmId } = await onboardFirmApi({ token: founder.token, data: { name: "Attest chain firm" } } as never)
      const F = await signIn(founder.uid, founderEmail)
      firms.push(firmId)
      const f: Firm = { firmId, P: F, Q: F, A: F, matterId: uniq("f42r1003001001001") }
      const qEmail = `${uniq("chain-q")}@example.test`
      const { uid: qUid } = await send(createFirmUserApi, f, F, { email: qEmail, role: "partner", clearanceLevel: "privileged-restricted" })
      uids.push(qUid)
      const Q = await signIn(qUid, qEmail)
      await send(attestIndependentPartnerApi, f, F, { uid: qUid })
      const rEmail = `${uniq("chain-r")}@example.test`
      const { uid: rUid } = await send(createFirmUserApi, f, Q, { email: rEmail, role: "partner", clearanceLevel: "privileged-restricted" })
      uids.push(rUid)
      expect((await adminDb().collection("users").doc(rUid).get()).get("createdBy")).toBe(Q.uid)
      await send(attestIndependentPartnerApi, f, F, { uid: rUid })
      const allowRows = (
        await adminDb()
          .collection("audit_log")
          .where("firmId", "==", firmId)
          .where("action", "==", "identity.attest_independent_partner")
          .where("actorId", "==", F.uid)
          .where("target", "==", `users/${rUid}`)
          .get()
      ).docs.map((d) => d.data())
      expect(allowRows.some((r) => r.decision === "allow" && r.reason === "sole_independent_attested_provisioned_partner")).toBe(true)
      expect(allowRows.some((r) => r.decision === "allow" && r.reason === "ok")).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      if (savedBootstrap) await bootstrapRef.set(savedBootstrap)
      else await bootstrapRef.delete()
    }
  })

  it("FA-F42-R1-006-003-001-001-001 RED: policy false after Q attested still refuses R on sole-provisioned path", async () => {
    retentionTestSeam.policy = testPolicy()
    retentionTestSeam.policy!.deletion.allowSoleIndependentAttestationOfProvisionedPartners = false
    const bootstrapRef = adminDb().collection("platform").doc("bootstrap")
    const savedBootstrap = (await bootstrapRef.get()).exists ? (await bootstrapRef.get()).data() : null
    if (savedBootstrap) await bootstrapRef.delete()
    const founderEmail = `${uniq("f42r1003001001001red")}@example.test`
    vi.stubEnv("SIKANDER_BOOTSTRAP_FOUNDER_EMAIL", founderEmail)
    try {
      const founder = await mintIdToken(null, { email: founderEmail, emailVerified: true })
      uids.push(founder.uid)
      const { firmId } = await onboardFirmApi({ token: founder.token, data: { name: "Attest chain refuse firm" } } as never)
      const F = await signIn(founder.uid, founderEmail)
      firms.push(firmId)
      const f: Firm = { firmId, P: F, Q: F, A: F, matterId: uniq("f42r1003001001001red") }
      const qEmail = `${uniq("chain-refuse-q")}@example.test`
      const { uid: qUid } = await send(createFirmUserApi, f, F, { email: qEmail, role: "partner", clearanceLevel: "privileged-restricted" })
      uids.push(qUid)
      const Q = await signIn(qUid, qEmail)
      retentionTestSeam.policy!.deletion.allowSoleIndependentAttestationOfProvisionedPartners = true
      await send(attestIndependentPartnerApi, f, F, { uid: qUid })
      retentionTestSeam.policy!.deletion.allowSoleIndependentAttestationOfProvisionedPartners = false
      const rEmail = `${uniq("chain-refuse-r")}@example.test`
      const { uid: rUid } = await send(createFirmUserApi, f, Q, { email: rEmail, role: "partner", clearanceLevel: "privileged-restricted" })
      uids.push(rUid)
      const err = await apiErrorOf(send(attestIndependentPartnerApi, f, F, { uid: rUid }))
      expect(`${err.status} ${err.code}`).toBe("403 attestation_sole_independent_provisioned_refused")
      expect((await adminDb().collection("users").doc(rUid).get()).get("independentPartner")).not.toBe(true)
    } finally {
      vi.unstubAllEnvs()
      if (savedBootstrap) await bootstrapRef.set(savedBootstrap)
      else await bootstrapRef.delete()
    }
  })

  it("FA-F42-R1-006-003-001 GREEN: onboarded founder with two attested createFirmUser partners — second approves first's deletion", async () => {
    retentionTestSeam.policy = testPolicy()
    const bootstrapRef = adminDb().collection("platform").doc("bootstrap")
    const savedBootstrap = (await bootstrapRef.get()).exists ? (await bootstrapRef.get()).data() : null
    if (savedBootstrap) await bootstrapRef.delete()
    const founderEmail = `${uniq("f42r1003grn-founder")}@example.test`
    vi.stubEnv("SIKANDER_BOOTSTRAP_FOUNDER_EMAIL", founderEmail)
    try {
      const founder = await mintIdToken(null, { email: founderEmail, emailVerified: true })
      uids.push(founder.uid)
      const { firmId } = await onboardFirmApi({ token: founder.token, data: { name: "Attest GREEN firm" } } as never)
      const F = await signIn(founder.uid, founderEmail)
      firms.push(firmId)
      const matterId = uniq("f42r1003grn")
      await seedMatter(firmId, matterId, TITLE, [F.uid])
      const qEmail = `${uniq("green-q")}@example.test`
      const rEmail = `${uniq("green-r")}@example.test`
      const { uid: qUid } = await send(createFirmUserApi, { firmId }, F, { email: qEmail, role: "partner", clearanceLevel: "privileged-restricted" })
      const { uid: rUid } = await send(createFirmUserApi, { firmId }, F, { email: rEmail, role: "partner", clearanceLevel: "privileged-restricted" })
      uids.push(qUid, rUid)
      await send(attestIndependentPartnerApi, { firmId }, F, { uid: qUid })
      await send(attestIndependentPartnerApi, { firmId }, F, { uid: rUid })
      const Q = await signIn(qUid, qEmail)
      const R = await signIn(rUid, rEmail)
      await ageUser(qUid, { createdAt: 400, partnerSince: 400 })
      await ageUser(rUid, { createdAt: 400, partnerSince: 400 })
      const f: Firm = { firmId, P: F, Q, A: F, matterId }
      const req = await send(requestApi, f, Q, { matterId, reasonCode: "client_instruction" })
      expect(req.status).toBe("pending_approval")
      const approved = await send(approveApi, f, R, { requestId: req.requestId })
      expect(approved.status).toBe("in_progress")
      expect((await adminDb().collection("matter_tombstones").doc(matterId).get()).exists).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      if (savedBootstrap) await bootstrapRef.set(savedBootstrap)
      else await bootstrapRef.delete()
    }
  })

  it("FA-F42-R1-006-003-001-002: legacy ambiguous partner is not independent until backfill stamps false", async () => {
    const f = await newFirm()
    const legacyUid = uniq("legacy-ambiguous")
    uids.push(legacyUid)
    await adminDb().collection("users").doc(legacyUid).set({
      firmId: f.firmId,
      role: "partner",
      clearanceLevel: "privileged-restricted",
      active: true,
      mfaEnabled: false,
      createdAt: Timestamp.fromMillis(Date.now() - 400 * DAY_MS),
    })
    const { isIndependentPartner } = await import("../src/retention/partnerIndependence")
    expect(isIndependentPartner((await adminDb().collection("users").doc(legacyUid).get()).data())).toBe(false)
    const { backfillLegacyPartnerIndependencePage } = await import("../src/retention/legacyPartnerIndependenceBackfill")
    await backfillLegacyPartnerIndependencePage(adminDb(), { limit: 500 })
    expect((await adminDb().collection("users").doc(legacyUid).get()).get("independentPartner")).toBe(false)
    expect((await adminDb().collection("users").doc(f.P.uid).get()).get("independentPartner")).toBe(true)
  })

  it("the requester side: a requester the approver made partner, or one too young at the request, cannot have the request approved", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    // A, an established associate, is made partner by Q, then requests; Q may not approve it, P (independent of A) may.
    await send(setUserClaimsApi, f, f.Q, { uid: f.A.uid, role: "partner" })
    await ageUser(f.A.uid, { partnerSince: 400 })
    await send(attestIndependentPartnerApi, f, f.Q, { uid: f.A.uid })
    const promoted = await signIn(f.A.uid, f.A.email!)
    const req = await send(requestApi, f, promoted, { matterId: f.matterId, reasonCode: "client_instruction" })
    expect((await apiErrorOf(send(approveApi, f, f.Q, { requestId: req.requestId }))).code).toBe("requester_promoted_by_approver")
    // A partner whose account is ten days old at the request: younger than the PROPOSED 30 days.
    const g = await newFirm()
    const young = await member(g.firmId, "partner", { independentPartner: true })
    await ageUser(young.uid, { createdAt: 10 })
    const byYoung = await send(requestApi, g, young, { matterId: g.matterId, reasonCode: "client_instruction" })
    expect((await apiErrorOf(send(approveApi, g, g.Q, { requestId: byYoung.requestId }))).code).toBe("requester_tenure_too_short")
    // Control: P, independent of A and established, approves A's request.
    expect((await send(approveApi, f, f.P, { requestId: req.requestId })).status).toBe("in_progress")
  })
})

describe.skipIf(!EMULATORS)("FA-F42-R1-012: the auditor's surviving mutants", () => {
  it("R08: a hold placed between a group's purge and its acknowledgement stops the acknowledgement", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    const { requestId, approved } = await requestAndApprove(f)
    const clock = new FakeClock(Date.now())
    const deps = testDeps(clock)
    expect(await runJobTask({ jobId: approved.jobId!, seq: 0 }, deps)).toBe("done")
    // What prepare acknowledged on its own (stores the matter has no rows in): the halt must add nothing to it.
    const before = Object.keys((await send(statusApi, f, f.P, { requestId })).acked).sort()
    let placedAt: string | null = null
    retentionTestSeam.beforeAck = async (part) => {
      if (placedAt !== null) return
      placedAt = part
      await adminDb().collection("legal_holds").doc(f.matterId).set({ firmId: f.firmId, matterId: f.matterId, active: true, reasonCode: "litigation_anticipated", placedBy: f.P.uid, placedAt: Timestamp.now() })
    }
    expect(await drain(f.firmId, clock, deps)).toContain("dead_lettered")
    expect(placedAt).not.toBeNull()
    const view = await send(statusApi, f, f.P, { requestId })
    expect(view.halted).toMatchObject({ code: "legal_hold_active" })
    expect(Object.keys(view.acked).sort()).toEqual(before)
    expect(view.status).toBe("in_progress")
  })

  it("own: a hold placed between prepare's steps stops the next one: no instruction after the static step, no purge job after the instruction", async () => {
    for (const after of ["static", "external"]) {
      retentionTestSeam.policy = testPolicy()
      const f = await newFirm()
      await adminDb().collection("ai_usage_logs").doc(uniq("u")).set({ firmId: f.firmId, matterId: f.matterId, model: "m", costMicroUsd: 1, trace: { id: `trace-${after}-1`, status: "exported" }, createdAt: Timestamp.now() })
      const { requestId, approved } = await requestAndApprove(f)
      let placed = false
      retentionTestSeam.afterStep = async (stepId) => {
        if (placed || !stepId.startsWith(`${after}-`)) return
        placed = true
        await adminDb().collection("legal_holds").doc(f.matterId).set({ firmId: f.firmId, matterId: f.matterId, active: true, reasonCode: "litigation_anticipated", placedBy: f.P.uid, placedAt: Timestamp.now() })
      }
      expect(await runJobTask({ jobId: approved.jobId!, seq: 0 }, testDeps(new FakeClock(Date.now()))), after).toBe("dead_lettered")
      expect(placed, after).toBe(true)
      expect((await adminDb().collection("jobs").doc(approved.jobId!).get()).get("lastError.code"), after).toBe("legal_hold_active")
      // After the static step the hold stops the instruction to the processor; after the instruction, the purge jobs.
      if (after === "static") expect(await processorRequests(requestId), after).toEqual([])
      expect((await adminDb().collection("jobs").where("firmId", "==", f.firmId).where("jobType", "==", "retention.store.purge").get()).size, after).toBe(0)
      delete retentionTestSeam.afterStep
    }
  })
})
