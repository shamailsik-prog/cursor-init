import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import shippedPolicy from "@/infra/retention/policy.json"
import { canonicalMatterDocument } from "@/platform/d1/matterDocument"
import { adminDb } from "../src/admin"
import { retentionTestSeam, type RetentionPolicy } from "../src/retention/config"
import { runJobTask } from "../src/p2/worker"
import { apiErrorOf, viaApi } from "./api"
import { EMULATORS, mintIdToken, uniq } from "./emu"
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
