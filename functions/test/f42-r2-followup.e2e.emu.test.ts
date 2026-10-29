import { Timestamp } from "firebase-admin/firestore"
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
 * Audit F42 R2 (independent re-audit at 30069057): FA-F42-R2-001 and FA-F42-R2-002 only.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 })

type Member = { uid: string; token: string }
type Firm = { firmId: string; P: Member; Q: Member; matterId: string }
type RequestView = { requestId: string; status: string; jobId?: string }

const requestApi = viaApi<RequestView>("requestMatterDeletion")
const approveApi = viaApi<RequestView>("approveMatterDeletion")
const statusApi = viaApi<{ requestId: string; status: string; halted: { code: string } | null }>("getDeletionRequest")
const holdApi = viaApi<Record<string, unknown>>("placeLegalHold")
const releaseApi = viaApi<Record<string, unknown>>("releaseLegalHold")

const firms: string[] = []
const uids: string[] = []
const DAY_MS = 86_400_000

function testPolicy(): RetentionPolicy {
  const p = structuredClone(shippedPolicy) as unknown as RetentionPolicy
  p.policyVersion = "test-f42-r2"
  for (const name of ["matter_access", "matter_content", "derived_index", "job_record", "legacy_matter_ops"]) {
    p.classes[name] = { ...p.classes[name], onMatterDeletion: "purge", legalHold: false }
  }
  p.classes.matter_record = { ...p.classes.matter_record, onMatterDeletion: "anonymise", legalHold: false }
  p.classes.ai_record = { ...p.classes.ai_record, onMatterDeletion: "anonymise", legalHold: false }
  p.classes.vault_object = { ...p.classes.vault_object, onMatterDeletion: "lock", legalHold: false }
  p.classes.third_party_trace = { ...p.classes.third_party_trace, onMatterDeletion: "external" }
  return p
}

const claims = (firmId: string, role: string) => ({ firmId, role, clearanceLevel: "privileged-restricted" })
const send = <T>(api: (c: never) => Promise<T>, f: Firm, m: Member, data: Record<string, unknown>): Promise<T> =>
  api({ token: m.token, data: { firmId: f.firmId, ...data } } as never)

async function member(firmId: string, role: string): Promise<Member> {
  const m = await mintIdToken(claims(firmId, role))
  uids.push(m.uid)
  await adminDb().collection("users").doc(m.uid).set(
    {
      createdAt: Timestamp.fromMillis(Date.now() - 400 * DAY_MS),
      ...(role === "partner" ? { independentPartner: true } : {}),
    },
    { merge: true }
  )
  return m
}

async function newFirm(): Promise<Firm> {
  const firmId = uniq("f42r2")
  firms.push(firmId)
  await adminDb().collection("firms").doc(firmId).set({ name: "F42R2", plan: "internal", rateLimits: { general: 5000 } })
  const P = await member(firmId, "partner")
  const Q = await member(firmId, "partner")
  const matterId = uniq("f42r2m")
  await adminDb()
    .collection("matters")
    .doc(matterId)
    .set({
      ...canonicalMatterDocument({
        firmId,
        clientId: `client-${firmId}`,
        title: "R2 matter",
        classification: "internal",
        status: "live",
        stage: "pre_filing",
        courtId: "SHC",
        caseNumber: null,
        matterNo: null,
        conflictCheckId: null,
        createdBy: P.uid,
      }),
      createdAt: Timestamp.now(),
    })
  for (const uid of [P.uid, Q.uid]) {
    await adminDb().collection("matter_members").doc(`${matterId}_${uid}`).set({ firmId, matterId, uid, role: "partner" })
  }
  return { firmId, P, Q, matterId }
}

afterAll(async () => {
  if (EMULATORS) await deleteFirmScopedData(firms, uids)
}, 300_000)

afterEach(() => {
  delete retentionTestSeam.policy
  delete retentionTestSeam.beforeHaltCommit
})

describe.skipIf(!EMULATORS)("FA-F42-R2-001: halt() re-reads the hold inside its transaction", () => {
  it("when the hold is released between assertNoHold and halt's commit, the saga is not wedged halted with no active hold", async () => {
    retentionTestSeam.policy = testPolicy()
    const f = await newFirm()
    await adminDb()
      .collection("ai_usage_logs")
      .doc(uniq("u"))
      .set({ firmId: f.firmId, matterId: f.matterId, model: "m", costMicroUsd: 1, trace: { id: "trace-r2-1", status: "exported" }, createdAt: Timestamp.now() })
    const req = await send(requestApi, f, f.P, { matterId: f.matterId, reasonCode: "client_instruction" })
    const approved = await send(approveApi, f, f.Q, { requestId: req.requestId })
    await send(holdApi, f, f.P, { matterId: f.matterId, reasonCode: "litigation_anticipated" })

    retentionTestSeam.beforeHaltCommit = async () => {
      await send(releaseApi, f, f.Q, { matterId: f.matterId })
    }

    const clock = new FakeClock(Date.now())
    const deps = testDeps(clock)
    expect(await runJobTask({ jobId: approved.jobId!, seq: 0 }, deps)).toBe("dead_lettered")

    const view = await send(statusApi, f, f.P, { requestId: req.requestId })
    expect(view.halted).toBeNull()
    const opik = await adminDb().collection("deletion_external_requests").doc(`${req.requestId}_opik`).get()
    if (opik.exists) expect(opik.get("status")).not.toBe("held")

    const again = await apiErrorOf(send(releaseApi, f, f.Q, { matterId: f.matterId }))
    expect(`${again.status} ${again.code}`).toBe("409 no_active_hold")
  })
})
