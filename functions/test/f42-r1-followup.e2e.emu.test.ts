import { randomUUID } from "node:crypto"
import { FieldValue, Timestamp, type DocumentData } from "firebase-admin/firestore"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import shippedPolicy from "@/infra/retention/policy.json"
import { canonicalMatterDocument } from "@/platform/d1/matterDocument"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { adminDb } from "../src/admin"
import { InMemoryAuthorityStore, setAuthorityStoreForTests } from "../src/d4/authority"
import { ROUTES, createRouter } from "../src/http/router"
import { firmConfigRef } from "../src/p1/config"
import { p1TestSeam } from "../src/p1/gateway"
import { setOpikFetchForTests } from "../src/p1/opik"
import { setP1TransportForTests } from "../src/p1/transport"
import { retentionTestSeam, type RetentionPolicy } from "../src/retention/config"
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

type Member = { uid: string; token: string }
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

async function member(firmId: string, role: string): Promise<Member> {
  const m = await mintIdToken(claims(firmId, role))
  uids.push(m.uid)
  // An established account: created long before any request (spec R26 judges an approver's tenure).
  await adminDb().collection("users").doc(m.uid).set({ createdAt: Timestamp.fromMillis(Date.now() - 400 * DAY_MS) }, { merge: true })
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
  const P = await member(firmId, "partner")
  const Q = await member(firmId, "partner")
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
