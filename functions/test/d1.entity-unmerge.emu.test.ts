import { describe, expect, it } from "vitest"
import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { adminDb } from "../src/admin"
import { checkReliesOn, UNMERGE_JOB_TYPES } from "../src/d1/entity/unmergeJobs"
import { jobIdFor } from "../src/p2/enqueue"
import { runJobTask } from "../src/p2/worker"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { apiErrorOf, expectKind, viaApi } from "./api"
import { FakeClock, readJob, testDeps } from "./jobs"

/**
 * Phase 3b (spec P3-24..P3-33): unmergeEntity and the un-merge saga over the emulators, through the
 * HTTP router and the real P2 worker (in-process dispatcher, fake clock). A pair of clients A and B
 * shares one CNIC; a seeded matter carries an opposing party row naming B's entity, so a check for A
 * relies on the pair's link row once it is confirmed.
 */

type Check = { checkId: string; result: string; hits: Array<Record<string, unknown>> }
type Unmerged = { pairId: string; linkIds: string[]; mergeEventId: string; status: string; jobIds: Record<string, string>; classification: string }

const clock = new FakeClock(Date.now())
const route = { now: () => clock.now() }
const registerClient = viaApi<{ clientId: string; entityId: string }>("registerClient")
const runCheck = viaApi<Check>("runConflictCheck")
const confirmMerge = viaApi<{ mergeEventId: string | null; state: string }>("confirmMerge", route)
const disputeLink = viaApi("disputeLink", route)
const rejectLink = viaApi("rejectLink", route)
const unmergeEntity = viaApi<Unmerged>("unmergeEntity", route)
const retryFailedJob = viaApi<{ status: string }>("retryFailedJob", route)

const CNIC = "4210112345671"
const NOTE = "Same CNIC on both files, but they are two cousins."
const claims = (firmId: string, role: string, clearanceLevel = "privileged-restricted") => ({ firmId, role, clearanceLevel })

async function seed(firmExtra: Record<string, unknown> = {}) {
  const firmId = uniq("firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS", ...firmExtra })
  const partner = await mintIdToken(claims(firmId, "partner"))
  const associate = await mintIdToken(claims(firmId, "associate", "internal"))
  let n = 0
  const reg = (name: string, extra: Record<string, unknown> = {}) =>
    registerClient({ token: partner.token, data: { firmId, name, type: "individual", primaryMobile: `0303${String(5000000 + Math.floor(Math.random() * 4000000) + ++n)}`, classification: "internal", ...extra } } as never)
  const a = await reg("Muhammad Ali", { cnic: CNIC })
  const b = await reg("Mohammad Ali Khan", { cnic: CNIC })
  const third = await reg("Third Client")
  const matterRef = adminDb().collection("matters").doc()
  await matterRef.set({ firmId, clientId: third.clientId, matterNo: "NHS/2026/0009", title: "Seeded", stage: "pre_filing", status: "live", conflictCheckId: "seeded", classification: "confidential", createdAt: Timestamp.now() })
  await adminDb().collection("matter_parties").add({ firmId, matterId: matterRef.id, role: "opposing", name: "B Trading", names: ["b trading"], keys: { cnic: CNIC }, entityId: b.entityId, matterClassification: "confidential", matterStatus: "live", classification: "confidential" })
  const [left, right] = [a.entityId, b.entityId].sort()
  const linkId = `${firmId}_${left}_${right}_cnic`
  const check = () => runCheck({ token: partner.token, data: { firmId, client: { clientId: a.clientId }, opposingParties: [{ name: "Kamran Akmal" }] } } as never)
  return { firmId, partner, associate, a, b, linkId, pairId: `${left}_${right}`, check }
}
type Seed = Awaited<ReturnType<typeof seed>>

const link = (s: Seed, token: string, over: Record<string, unknown> = {}) => ({ token, data: { firmId: s.firmId, linkId: s.linkId, note: NOTE, ...over } }) as never
const linkRow = async (s: Seed): Promise<DocumentData> => (await adminDb().collection("entity_links").doc(s.linkId).get()).data()!
const eventDoc = async (id: string) => (await adminDb().collection("merge_events").doc(id).get()).data()!
const unmergedEvents = async (s: Seed) => (await adminDb().collection("events").where("firmId", "==", s.firmId).where("name", "==", "entity.unmerged").get()).docs
const crossing = (c: Check) => c.hits.filter((h) => h.type === "adverse_history")

/** Delivers a saga job's first task through the real worker. */
async function runJob(s: Seed, collection: keyof typeof UNMERGE_JOB_TYPES, mergeEventId: string, deps = testDeps(clock)) {
  const jobId = jobIdFor(s.firmId, UNMERGE_JOB_TYPES[collection], `${mergeEventId}:${collection}`)
  const row = await readJob(jobId)
  return runJobTask({ jobId, seq: row.dispatchSeq }, deps)
}

/** Confirms the pair, runs a check that relies on it (FLAG), and starts the un-merge. */
async function confirmed(s: Seed) {
  const merged = await confirmMerge(link(s, s.associate.token))
  const check = await s.check()
  expect(crossing(check)[0]).toMatchObject({ outcome: "FLAG", identityBasis: "confirmed_identity", reliedOnLinkIds: [s.linkId] })
  return { mergeEventId: merged.mergeEventId!, check }
}

describe.skipIf(!EMULATORS)("unmergeEntity and the un-merge saga (P3-24..P3-33)", () => {
  it("starts the saga: event reverted, rows in progress, one saga job per collection, the pair reads as unresolved identity", async () => {
    const s = await seed()
    const { mergeEventId } = await confirmed(s)
    const out = await unmergeEntity(link(s, s.partner.token))
    expect(out).toMatchObject({ pairId: s.pairId, mergeEventId, status: "in_progress", classification: "internal" })
    expect(out.linkIds).toEqual([s.linkId])
    expect(out.jobIds).toEqual({
      entity_links: jobIdFor(s.firmId, "d1.unmerge.links", `${mergeEventId}:entity_links`),
      conflict_checks: jobIdFor(s.firmId, "d1.unmerge.checks", `${mergeEventId}:conflict_checks`),
    })

    const event = await eventDoc(mergeEventId)
    expect(event).toMatchObject({ reverted: true, revertedBy: s.partner.uid, revertNote: NOTE, unmerge: { status: "in_progress", jobs: { entity_links: "pending", conflict_checks: "pending" } } })
    expect(await linkRow(s)).toMatchObject({ state: "confirmed", unmerge: { status: "in_progress", mergeEventId, by: s.partner.uid } })
    for (const jobId of Object.values(out.jobIds)) {
      const job = await readJob(jobId)
      expect(job).toMatchObject({ status: "queued", firmId: s.firmId, classification: "internal", matterId: null, createdBy: s.partner.uid })
      expect(job.payload).toEqual({ mergeEventId, pairId: s.pairId, leftId: s.pairId.split("_")[0], rightId: s.pairId.split("_")[1], linkIds: [s.linkId] })
    }
    expect(await unmergedEvents(s)).toHaveLength(0)

    // P3-26: unresolved while the saga runs: the role-crossing hit is a review, never a confirmed identity.
    expect(crossing(await s.check())[0]).toMatchObject({ outcome: "POSSIBLE_CANDIDATE_REVIEW", identityBasis: "candidate_only" })
    // No decision and no second un-merge while it runs.
    for (const op of [confirmMerge, disputeLink, rejectLink, unmergeEntity]) {
      expectKind(await apiErrorOf(op(link(s, s.partner.token))), "failed-precondition", "unmerge_in_progress")
    }
    // Not reviewable either: the queue hides the pair.
    const queue = viaApi<{ items: unknown[] }>("listReviewQueue")
    for (const view of ["pending", "disputed"]) expect((await queue({ token: s.partner.token, data: { firmId: s.firmId, view } } as never)).items).toHaveLength(0)
  })

  it("the jobs finish the saga: links reopened as disputed, relying checks stale, entity.unmerged once, even when delivered twice", async () => {
    const s = await seed()
    const { mergeEventId, check } = await confirmed(s)
    const second = await s.check()
    const out = await unmergeEntity(link(s, s.partner.token))

    expect(await runJob(s, "conflict_checks", mergeEventId)).toBe("done")
    expect((await eventDoc(mergeEventId)).unmerge).toMatchObject({ status: "in_progress", jobs: { entity_links: "pending", conflict_checks: "done" } })
    expect(await unmergedEvents(s)).toHaveLength(0)
    expect(await runJob(s, "entity_links", mergeEventId)).toBe("done")

    const event = await eventDoc(mergeEventId)
    expect(event).toMatchObject({ reverted: true, unmerge: { status: "completed", jobs: { entity_links: "done", conflict_checks: "done" } } })
    expect(event.unmerge.completedAt).toBeInstanceOf(Timestamp)
    expect(await linkRow(s)).toMatchObject({ state: "candidate", disputed: true, unmerge: { status: "completed", mergeEventId } })

    const events = await unmergedEvents(s)
    expect(events).toHaveLength(1)
    expect(events[0].id).toBe(`${mergeEventId}_unmerged`)
    expect(events[0].data()).toMatchObject({
      name: "entity.unmerged",
      firmId: s.firmId,
      classification: "internal",
      idempotencyKey: `${mergeEventId}:unmerged`,
      payload: { entityIds: s.pairId.split("_"), mergeEventId, score: 0.99 },
    })

    // P2-21: every check that relied on the reverted link is stale (a stale check cannot open a matter, 2a P2-6).
    for (const id of [check.checkId, second.checkId]) {
      expect((await adminDb().collection("conflict_checks").doc(id).get()).data()).toMatchObject({ stale: true, staleReason: { kind: "unmerge", mergeEventId } })
    }

    // At least once: a redelivery changes nothing and emits nothing more.
    const deps = testDeps(clock)
    for (const id of Object.values(out.jobIds)) expect(await runJobTask({ jobId: id, seq: 0 }, deps)).not.toBe("done")
    expect(await unmergedEvents(s)).toHaveLength(1)
    for (const id of Object.values(out.jobIds)) expect(await readJob(id)).toMatchObject({ status: "done", outputRefs: [`merge_events/${mergeEventId}`] })

    // The reopened pair needs a partner again: unresolved, disputed, so partner-only, and it can be confirmed anew.
    expect(crossing(await s.check())[0]).toMatchObject({ outcome: "POSSIBLE_CANDIDATE_REVIEW", identityBasis: "candidate_only" })
    expectKind(await apiErrorOf(confirmMerge(link(s, s.associate.token))), "permission-denied", "role_not_permitted")
    const again = await confirmMerge(link(s, s.partner.token))
    expect(again).toMatchObject({ state: "confirmed" })
    expect(again.mergeEventId).not.toBe(mergeEventId)
    expect(await eventDoc(mergeEventId)).toMatchObject({ reverted: true })
  })

  it("the links job may finish last or first: the completion is the same", async () => {
    const s = await seed()
    const { mergeEventId } = await confirmed(s)
    await unmergeEntity(link(s, s.partner.token))
    expect(await runJob(s, "entity_links", mergeEventId)).toBe("done")
    // Reopened but still in progress: still unresolved and still closed to decisions.
    expect(await linkRow(s)).toMatchObject({ state: "candidate", disputed: true, unmerge: { status: "in_progress" } })
    expectKind(await apiErrorOf(rejectLink(link(s, s.partner.token))), "failed-precondition", "unmerge_in_progress")
    expect(await unmergedEvents(s)).toHaveLength(0)
    expect(await runJob(s, "conflict_checks", mergeEventId)).toBe("done")
    expect(await linkRow(s)).toMatchObject({ state: "candidate", disputed: true, unmerge: { status: "completed" } })
    expect(await unmergedEvents(s)).toHaveLength(1)
  })

  it("a dead-lettered saga job leaves the pair in progress; only a partner retries it, and the retry finishes the saga", async () => {
    const s = await seed()
    const { mergeEventId } = await confirmed(s)
    const out = await unmergeEntity(link(s, s.partner.token))
    // Break the event so the checks job fails permanently (unmerge_event_invalid), then fix it.
    const eventRef = adminDb().collection("merge_events").doc(mergeEventId)
    await eventRef.update({ pairId: "broken" })
    expect(await runJob(s, "conflict_checks", mergeEventId)).toBe("dead_lettered")
    const dead = await readJob(out.jobIds.conflict_checks)
    expect(dead).toMatchObject({ status: "dead_lettered", lastError: { code: "unmerge_event_invalid" } })
    expect((await eventDoc(mergeEventId)).unmerge.status).toBe("in_progress")
    expect(await linkRow(s)).toMatchObject({ unmerge: { status: "in_progress" } })

    await eventRef.update({ pairId: s.pairId })
    const retry = { jobId: out.jobIds.conflict_checks, note: "Event repaired by the partner after the failure." }
    // A firm-level job is visible to a partner only (P3-11), so an associate cannot even see it.
    expectKind(await apiErrorOf(retryFailedJob({ token: s.associate.token, data: { firmId: s.firmId, ...retry } } as never)), "not-found", "not_found")
    const cancel = viaApi("cancelJob", route)
    expectKind(await apiErrorOf(cancel({ token: s.partner.token, data: { firmId: s.firmId, jobId: out.jobIds.conflict_checks, note: retry.note } } as never)), "failed-precondition", "job_not_cancellable")
    expect(await retryFailedJob({ token: s.partner.token, data: { firmId: s.firmId, ...retry } } as never)).toMatchObject({ status: "queued" })
    expect(await runJobTask({ jobId: out.jobIds.conflict_checks, seq: (await readJob(out.jobIds.conflict_checks)).dispatchSeq }, testDeps(clock))).toBe("done")
    expect(await runJob(s, "entity_links", mergeEventId)).toBe("done")
    expect((await eventDoc(mergeEventId)).unmerge.status).toBe("completed")
    expect(await unmergedEvents(s)).toHaveLength(1)
  })

  it("refusals: role, body, layer flag, state, other firm", async () => {
    const s = await seed()
    // A candidate pair is not confirmed.
    expectKind(await apiErrorOf(unmergeEntity(link(s, s.partner.token))), "failed-precondition", "link_not_confirmed")
    await confirmed(s)
    expectKind(await apiErrorOf(unmergeEntity(link(s, s.associate.token))), "permission-denied", "role_not_permitted")
    expectKind(await apiErrorOf(unmergeEntity(link(s, s.partner.token, { note: "too short" }))), "invalid-argument", "note_too_short")
    expectKind(await apiErrorOf(unmergeEntity(link(s, s.partner.token, { linkId: "a/b" }))), "invalid-argument", "invalid_query")
    expectKind(await apiErrorOf(unmergeEntity(link(s, s.partner.token, { linkId: "missing" }))), "not-found", "not_found")
    const other = await seed()
    expectKind(await apiErrorOf(unmergeEntity({ token: other.partner.token, data: { firmId: other.firmId, linkId: s.linkId, note: NOTE } } as never)), "not-found", "not_found")
    // A clearance below the pair's label is a 404 too.
    const low = await mintIdToken(claims(s.firmId, "partner", "public"))
    expectKind(await apiErrorOf(unmergeEntity(link(s, low.token))), "not-found", "not_found")
    expect(await linkRow(s)).toMatchObject({ state: "confirmed" })
    expect(await linkRow(s)).not.toHaveProperty("unmerge")

    const off = await seed({ featureFlags: { L17_2_ENABLED: false } })
    expectKind(await apiErrorOf(unmergeEntity(link(off, off.partner.token))), "not-found", "feature_disabled")
  })

  it("a finished un-merge cannot be repeated on the reopened pair, and a rejected pair is not confirmed", async () => {
    const s = await seed()
    const { mergeEventId } = await confirmed(s)
    await unmergeEntity(link(s, s.partner.token))
    await runJob(s, "conflict_checks", mergeEventId)
    await runJob(s, "entity_links", mergeEventId)
    expectKind(await apiErrorOf(unmergeEntity(link(s, s.partner.token))), "failed-precondition", "link_not_confirmed")
    await rejectLink(link(s, s.partner.token))
    expectKind(await apiErrorOf(unmergeEntity(link(s, s.partner.token))), "failed-precondition", "link_not_confirmed")
  })

  it("writes one allow audit row and no payload value reaches the job row's logs or error", async () => {
    const s = await seed()
    await confirmed(s)
    const out = await unmergeEntity(link(s, s.partner.token))
    const rows = (await adminDb().collection("audit_log").where("actorId", "==", s.partner.uid).where("action", "==", "entity.unmerge").get()).docs
      .map((d) => d.data())
      .filter((r) => r.decision === "allow" && r.target === `entity_links/${s.linkId}`)
    expect(rows).toHaveLength(1)
    const job = await readJob(out.jobIds.entity_links)
    expect(JSON.stringify([job.logs, job.lastError])).not.toContain(CNIC)
  })

  it("checkReliesOn reads hits[].reliedOnLinkIds and nothing else", () => {
    const ids = new Set(["l1"])
    expect(checkReliesOn({ hits: [{ reliedOnLinkIds: ["x", "l1"] }] }, ids)).toBe(true)
    expect(checkReliesOn({ hits: [{ reliedOnLinkIds: ["x"] }, null, {}] }, ids)).toBe(false)
    expect(checkReliesOn({ hits: "l1" }, ids)).toBe(false)
    expect(checkReliesOn({ subjects: [{ reliedOnLinkIds: ["l1"] }] }, ids)).toBe(false)
  })
})
