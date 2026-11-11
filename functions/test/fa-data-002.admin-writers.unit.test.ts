/**
 * FA-DATA-002: the Admin SDK writers in functions/src/d1/entity and d1/matter/ops.ts, given a
 * stored row at privileged-restricted and a lower label on the pair or the request, persist a
 * label at least as high as the stored one.
 */
import { describe, expect, it, vi } from "vitest"
import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { adminDb } from "../src/admin"
import { AUTO_CONFIRM_JOB_TYPE } from "../src/d1/entity/autoConfirmJob"
import { LINK_AUTO_CONFIRM_MS } from "../src/d1/entity/linkState"
import { jobIdFor } from "../src/p2/enqueue"
import { runJobTask } from "../src/p2/worker"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { viaApi } from "./api"
import { enqueueAt, FakeClock, readJob, testDeps } from "./jobs"

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const RANKS: Record<string, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  privileged: 3,
  "privileged-restricted": 4,
}
const rank = (label: unknown) => RANKS[String(label)] ?? -1
const NOTE = "Same CNIC and mobile on both intake forms, checked."
const HIGH = "privileged-restricted"

const confirmMerge = viaApi<{ classification: string }>("confirmMerge")
const disputeLink = viaApi<{ classification: string }>("disputeLink")
const rejectLink = viaApi<{ classification: string }>("rejectLink")
const unmergeEntity = viaApi<{ classification: string }>("unmergeEntity")
const registerClient = viaApi<{ clientId: string; entityId: string }>("registerClient")
const runCheck = viaApi<{ checkId: string; result: string }>("runConflictCheck")
const openMatter = viaApi<{ matterId: string }>("openMatter")

let cnicSeq = 4210100000000
let mobileSeq = 1000000
const nextCnic = () => {
  cnicSeq += 1
  const n = String(cnicSeq).padStart(13, "0")
  return `${n.slice(0, 5)}-${n.slice(5, 12)}-${n.slice(12)}`
}
const nextMobile = () => `0300${String(++mobileSeq).padStart(7, "0")}`

async function firmWithPair() {
  const firmId = uniq("fa002")
  await adminDb().collection("firms").doc(firmId).set({ name: "FA-DATA-002", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
  const partner = await mintIdToken({ firmId, role: "partner", clearanceLevel: HIGH })
  const cnic = nextCnic()
  const mobile = nextMobile()
  const reg = (name: string) =>
    registerClient({
      token: partner.token,
      data: { firmId, name, type: "individual", primaryMobile: mobile, cnic, classification: "public" },
    } as never)
  const a = await reg("Muhammad Ali")
  const b = await reg("Mohammad Ali")
  const [left, right] = [a.entityId, b.entityId].sort()
  const ids = [`${firmId}_${left}_${right}_cnic`, `${firmId}_${left}_${right}_phone`]
  await adminDb().collection("entity_links").doc(ids[0]).update({ classification: HIGH })
  await adminDb().collection("entity_links").doc(ids[1]).update({ classification: "public" })
  return { firmId, partner, ids }
}

async function labelsOf(ids: string[]): Promise<string[]> {
  const rows = await Promise.all(ids.map(async (id) => (await adminDb().collection("entity_links").doc(id).get()).data() as DocumentData))
  return rows.map((row) => String(row.classification))
}

function atLeastStored(before: string[], after: string[]) {
  expect(after).toHaveLength(before.length)
  after.forEach((label, i) => expect(rank(label)).toBeGreaterThanOrEqual(rank(before[i])))
  expect(after).toContain(HIGH)
}

describe.skipIf(!EMULATORS)("FA-DATA-002 admin writers never lower a stored label", () => {
  it("confirmMerge, then unmergeEntity, keeps every link at least as high as it was stored", async () => {
    const s = await firmWithPair()
    const before = await labelsOf(s.ids)
    expect(before).toEqual([HIGH, "public"])
    const confirmed = await confirmMerge({ token: s.partner.token, data: { firmId: s.firmId, linkId: s.ids[0], note: NOTE } } as never)
    expect(confirmed.classification).toBe(HIGH)
    atLeastStored(before, await labelsOf(s.ids))
    const unmerged = await unmergeEntity({ token: s.partner.token, data: { firmId: s.firmId, linkId: s.ids[0], note: NOTE } } as never)
    expect(unmerged.classification).toBe(HIGH)
    atLeastStored(before, await labelsOf(s.ids))
  })

  it("disputeLink keeps every link at least as high as it was stored", async () => {
    const s = await firmWithPair()
    const before = await labelsOf(s.ids)
    const out = await disputeLink({ token: s.partner.token, data: { firmId: s.firmId, linkId: s.ids[1], note: NOTE } } as never)
    expect(out.classification).toBe(HIGH)
    atLeastStored(before, await labelsOf(s.ids))
  })

  it("rejectLink keeps every link at least as high as it was stored", async () => {
    const s = await firmWithPair()
    const before = await labelsOf(s.ids)
    const out = await rejectLink({ token: s.partner.token, data: { firmId: s.firmId, linkId: s.ids[0], note: NOTE } } as never)
    expect(out.classification).toBe(HIGH)
    atLeastStored(before, await labelsOf(s.ids))
  })

  it("the auto-confirm job keeps a privileged-restricted link when the entities are public", async () => {
    const firmId = uniq("fa002ac")
    await adminDb().collection("firms").doc(firmId).set({ name: "FA-DATA-002", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
    const left = `ent_${firmId}_l`
    const right = `ent_${firmId}_r`
    const linkId = `${firmId}_${left}_${right}_cnic`
    const createdAt = Timestamp.fromMillis(Date.now() - LINK_AUTO_CONFIRM_MS - 86_400_000)
    const batch = adminDb().batch()
    for (const id of [left, right]) {
      batch.set(adminDb().collection("entities").doc(id), { firmId, canonicalName: id, cnic: nextCnic(), classification: "public" })
    }
    batch.set(adminDb().collection("entity_links").doc(linkId), {
      firmId, leftId: left, rightId: right, key: "cnic", state: "candidate", disputed: false, createdAt, classification: HIGH,
    })
    await batch.commit()
    const at = Date.now()
    const clock = new FakeClock(at)
    const spec = {
      firmId,
      jobType: AUTO_CONFIRM_JOB_TYPE,
      classification: "public" as const,
      matterId: null,
      payload: { period: "2026-11-11" },
      idempotencyKey: `${AUTO_CONFIRM_JOB_TYPE}:2026-11-11`,
      runKey: `${AUTO_CONFIRM_JOB_TYPE}:2026-11-11`,
      createdBy: "system",
    }
    await enqueueAt(spec, at)
    const jobId = jobIdFor(firmId, AUTO_CONFIRM_JOB_TYPE, spec.idempotencyKey)
    const outcome = await runJobTask({ jobId, seq: (await readJob(jobId)).dispatchSeq }, testDeps(clock))
    expect(outcome).toBe("done")
    const row = (await adminDb().collection("entity_links").doc(linkId).get()).data()!
    expect(row.state).toBe("confirmed")
    expect(rank(row.classification)).toBeGreaterThanOrEqual(rank(HIGH))
  })

  it("openMatter does not lower a stored conflict check, and party rows take that label", async () => {
    const firmId = uniq("fa002m")
    await adminDb().collection("firms").doc(firmId).set({ name: "FA-DATA-002", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
    const partner = await mintIdToken({ firmId, role: "partner", clearanceLevel: HIGH })
    const client = await registerClient({
      token: partner.token,
      data: { firmId, name: "Tariq Zarvani", type: "individual", primaryMobile: nextMobile(), classification: "public" },
    } as never)
    const check = await runCheck({
      token: partner.token,
      data: { firmId, client: { clientId: client.clientId }, opposingParties: [{ name: "Zzz Qqq" }] },
    } as never)
    expect(check.result).toBe("CLEAR")
    await adminDb().collection("conflict_checks").doc(check.checkId).update({ classification: HIGH })
    const opened = await openMatter({
      token: partner.token,
      data: { firmId, conflictCheckId: check.checkId, title: "Recovery suit", classification: "public" },
    } as never)
    const stored = (await adminDb().collection("conflict_checks").doc(check.checkId).get()).data()!
    expect(stored.classification).toBe(HIGH)
    expect(stored.boundMatterId).toBe(opened.matterId)
    const parties = await adminDb().collection("matter_parties").where("firmId", "==", firmId).where("matterId", "==", opened.matterId).get()
    expect(parties.size).toBeGreaterThan(0)
    for (const party of parties.docs) expect(party.data().classification).toBe(HIGH)
    const matter = (await adminDb().collection("matters").doc(opened.matterId).get()).data()!
    expect(matter.classification).toBe("public")
  })
})
