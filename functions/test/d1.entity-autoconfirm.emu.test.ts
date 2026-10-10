import { createHash } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { adminDb } from "../src/admin"
import { AUTO_CONFIRM_JOB_TYPE, AUTO_CONFIRM_MAX_STEPS, AUTO_CONFIRM_STEP_PAIRS, autoConfirmTestSeam } from "../src/d1/entity/autoConfirmJob"
import { LINK_AUTO_CONFIRM_MS } from "../src/d1/entity/linkState"
import { readRegistryVersion } from "../src/d1/registryVersion"
import { MAX_FENCED_STEPS, RETRY_DELAYS_MS } from "../src/p2/constants"
import { jobIdFor } from "../src/p2/enqueue"
import { runJobTask } from "../src/p2/worker"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { apiErrorOf, expectKind, viaApi } from "./api"
import { FakeClock, enqueueAt, readJob, testDeps } from "./jobs"

/**
 * Phase 3c (spec P3-42..P3-50, O-28): the auto-confirm materialisation job over the emulators,
 * through the real P2 worker (in-process dispatcher, fake clock). The pair of clients A and B
 * shares one CNIC, so registerClient writes one candidate link row (key cnic).
 */

const DAY = 86_400_000
const clock = new FakeClock(Date.now())
const route = { now: () => clock.now() }
const registerClient = viaApi<{ clientId: string; entityId: string }>("registerClient")
const disputeLink = viaApi("disputeLink", route)
const unmergeEntity = viaApi<{ mergeEventId: string; jobIds: Record<string, string> }>("unmergeEntity", route)
const NOTE = "Same CNIC on both files, but they are two cousins."
const CNIC = "4210112345671"
const claims = (firmId: string, role: string) => ({ firmId, role, clearanceLevel: "privileged-restricted" })

async function seed(firmExtra: Record<string, unknown> = {}) {
  const firmId = uniq("firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS", ...firmExtra })
  const partner = await mintIdToken(claims(firmId, "partner"))
  let n = 0
  const reg = (name: string) =>
    registerClient({ token: partner.token, data: { firmId, name, type: "individual", primaryMobile: `0303${String(5000000 + Math.floor(Math.random() * 4000000) + ++n)}`, classification: "internal", cnic: CNIC } } as never)
  const a = await reg("Muhammad Ali")
  const b = await reg("Mohammad Ali Khan")
  const [left, right] = [a.entityId, b.entityId].sort()
  return { firmId, partner, a, b, linkId: `${firmId}_${left}_${right}_cnic`, pairId: `${left}_${right}` }
}
type Seed = Awaited<ReturnType<typeof seed>>

const linkRef = (s: Seed) => adminDb().collection("entity_links").doc(s.linkId)
const linkRow = async (s: Seed): Promise<DocumentData> => (await linkRef(s).get()).data()!
const mergeEvents = async (s: Seed) => (await adminDb().collection("merge_events").where("firmId", "==", s.firmId).get()).docs
const events = async (s: Seed, name: string) => (await adminDb().collection("events").where("firmId", "==", s.firmId).where("name", "==", name).get()).docs

/** Enqueues one daily run for the firm and delivers it through the worker at `at`; `deps` delivers its retries. */
async function runDay(firmId: string, at: number, period = "2026-10-11") {
  clock.set(at)
  const spec = { firmId, jobType: AUTO_CONFIRM_JOB_TYPE, classification: "internal" as const, matterId: null, payload: { period }, idempotencyKey: `${AUTO_CONFIRM_JOB_TYPE}:${period}`, runKey: `${AUTO_CONFIRM_JOB_TYPE}:${period}`, createdBy: "system" }
  await enqueueAt(spec, at)
  const jobId = jobIdFor(firmId, AUTO_CONFIRM_JOB_TYPE, spec.idempotencyKey)
  const deps = testDeps(clock)
  return { jobId, deps, outcome: await runJobTask({ jobId, seq: (await readJob(jobId)).dispatchSeq }, deps) }
}

/*
 * Close-out helpers (spec P3-51..P3-56). Pairs are seeded directly so a test can shape each key
 * row; `seedPair` writes two entities and one link row per key (defaults: an undisputed candidate,
 * label internal), and `seedPairs` writes `count` one-key pairs in batches.
 */

const links = () => adminDb().collection("entity_links")

async function bareFirm(): Promise<string> {
  const firmId = uniq("firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
  return firmId
}

type RowSeed = { key: string; createdAt: Timestamp } & Record<string, unknown>

async function seedPair(firmId: string, tag: string, rows: RowSeed[]): Promise<{ pairId: string; linkIds: string[] }> {
  const l = `ent_${firmId}_${tag}_l`
  const r = `ent_${firmId}_${tag}_r`
  const batch = adminDb().batch()
  for (const id of [l, r]) batch.set(adminDb().collection("entities").doc(id), { firmId, canonicalName: id, cnic: CNIC, classification: "internal" })
  const linkIds: string[] = []
  for (const row of rows) {
    const linkId = `${firmId}_${l}_${r}_${row.key}`
    linkIds.push(linkId)
    batch.set(links().doc(linkId), { firmId, leftId: l, rightId: r, state: "candidate", disputed: false, classification: "internal", ...row })
  }
  await batch.commit()
  return { pairId: `${l}_${r}`, linkIds: linkIds.sort() }
}

async function seedPairs(firmId: string, count: number, createdAt: Timestamp): Promise<string[]> {
  const pairIds: string[] = []
  for (let start = 0; start < count; start += 150) {
    const batch = adminDb().batch()
    for (let i = start; i < Math.min(count, start + 150); i += 1) {
      const l = `ent_${firmId}_${String(i).padStart(4, "0")}_l`
      const r = `ent_${firmId}_${String(i).padStart(4, "0")}_r`
      for (const id of [l, r]) batch.set(adminDb().collection("entities").doc(id), { firmId, canonicalName: id, cnic: `35202${String(i).padStart(8, "0")}`, classification: "internal" })
      batch.set(links().doc(`${firmId}_${l}_${r}_cnic`), { firmId, leftId: l, rightId: r, key: "cnic", state: "candidate", disputed: false, createdAt, classification: "internal" })
      pairIds.push(`${l}_${r}`)
    }
    await batch.commit()
  }
  return pairIds
}

const firmMergeEvents = async (firmId: string) => (await adminDb().collection("merge_events").where("firmId", "==", firmId).get()).docs
const firmEvents = async (firmId: string, name: string) => (await adminDb().collection("events").where("firmId", "==", firmId).where("name", "==", name).get()).docs
const confirmAudits = async (firmId: string) => (await adminDb().collection("audit_log").where("firmId", "==", firmId).where("action", "==", "entity.confirm").get()).docs
const rowsOf = async (linkIds: string[]) => Promise.all(linkIds.map(async (id) => (await links().doc(id).get()).data()!))

/** The P3-55 merge event id, computed here from the ruling's formula (not the job's code). */
const expectedEventId = (firmId: string, pairId: string, linkIds: string[]) =>
  "auto_" + createHash("sha256").update(`${firmId}\0${pairId}\0${[...linkIds].sort().join(",")}`).digest("hex").slice(0, 32)

type Step = { attempt: number; index: number; pairIds: readonly string[] }

/** Records every fenced step the job reaches (the pairs the scan admitted to it), then runs `also`. */
function recordSteps(also?: (step: Step) => Promise<void>): Step[] {
  const steps: Step[] = []
  autoConfirmTestSeam.beforeStep = async (step) => {
    steps.push({ ...step, pairIds: [...step.pairIds] })
    await also?.(step)
  }
  return steps
}

/**
 * P3-56: the scan admitted `pairId` to a step, and the step's transaction rejected it: no merge
 * event, no `entity.confirmed`, no audit row, rows as seeded, and (unless another writer bumped it)
 * the registry version unchanged.
 */
async function expectAdmittedAndRejected(firmId: string, pairId: string, linkIds: string[], steps: Step[], seeded: DocumentData[], registryBefore: number | null) {
  expect(steps.flatMap((s) => s.pairIds)).toContain(pairId)
  expect(await firmMergeEvents(firmId)).toHaveLength(0)
  expect(await firmEvents(firmId, "entity.confirmed")).toHaveLength(0)
  expect(await confirmAudits(firmId)).toHaveLength(0)
  expect(await rowsOf(linkIds)).toEqual(seeded)
  if (registryBefore !== null) expect(await readRegistryVersion(firmId)).toBe(registryBefore)
}

describe.skipIf(!EMULATORS)("auto-confirm materialisation (P3-42..P3-50, O-28)", () => {
  it("materialises an aged undisputed pair: a system merge event, rows confirmed, entity.confirmed once, registry bumped; a second run writes nothing", async () => {
    const s = await seed()
    const created = (await linkRow(s)).createdAt as Timestamp
    const before = await readRegistryVersion(s.firmId)
    const at = created.toMillis() + LINK_AUTO_CONFIRM_MS + DAY
    const { outcome } = await runDay(s.firmId, at)
    expect(outcome).toBe("done")

    const [event] = await mergeEvents(s)
    expect(await mergeEvents(s)).toHaveLength(1)
    expect(event.data()).toMatchObject({
      kind: "link_confirmed",
      basis: "auto_confirm",
      priorState: "auto_confirmed",
      actorId: "system",
      actorRole: "system",
      pairId: s.pairId,
      linkIds: [s.linkId],
      keys: ["cnic"],
      reverted: false,
      classification: "internal",
    })
    expect(event.data().evidence.keyValues).toEqual({ cnic: CNIC })
    expect((event.data().effectiveAt as Timestamp).toMillis()).toBe(created.toMillis() + LINK_AUTO_CONFIRM_MS)
    expect(event.data().snapshot.left.entityId).toBe(s.pairId.split("_")[0])
    expect(await linkRow(s)).toMatchObject({ state: "confirmed", disputed: false, confirmation: { by: "system", role: "system", mergeEventId: event.id, auto: true } })
    const emitted = await events(s, "entity.confirmed")
    expect(emitted).toHaveLength(1)
    expect(emitted[0].data()).toMatchObject({ payload: { entityIds: s.pairId.split("_"), mergeEventId: event.id }, idempotencyKey: `${event.id}:confirmed` })
    expect(await readRegistryVersion(s.firmId)).toBeGreaterThan(before)

    const after = await readRegistryVersion(s.firmId)
    expect((await runDay(s.firmId, at + DAY, "2026-10-12")).outcome).toBe("done")
    expect(await mergeEvents(s)).toHaveLength(1)
    expect(await events(s, "entity.confirmed")).toHaveLength(1)
    expect(await readRegistryVersion(s.firmId)).toBe(after)
  })

  it("leaves alone a pair younger than 30 days, a disputed pair, a rejected pair, and every pair when the L17.2 layer is off", async () => {
    const young = await seed()
    const createdMs = ((await linkRow(young)).createdAt as Timestamp).toMillis()
    await runDay(young.firmId, createdMs + LINK_AUTO_CONFIRM_MS - DAY)
    expect(await mergeEvents(young)).toHaveLength(0)
    expect(await linkRow(young)).toMatchObject({ state: "candidate", disputed: false })

    const disputed = await seed()
    clock.set(Date.now())
    await disputeLink({ token: disputed.partner.token, data: { firmId: disputed.firmId, linkId: disputed.linkId, note: NOTE } } as never)
    await runDay(disputed.firmId, createdMs + 2 * LINK_AUTO_CONFIRM_MS)
    expect(await mergeEvents(disputed)).toHaveLength(0)
    expect(await linkRow(disputed)).toMatchObject({ state: "candidate", disputed: true })

    const rejected = await seed()
    await linkRef(rejected).update({ state: "rejected" })
    await runDay(rejected.firmId, createdMs + 2 * LINK_AUTO_CONFIRM_MS)
    expect(await mergeEvents(rejected)).toHaveLength(0)

    const off = await seed({ featureFlags: { L17_2_ENABLED: false } })
    const { outcome } = await runDay(off.firmId, createdMs + 2 * LINK_AUTO_CONFIRM_MS)
    expect(outcome).toBe("done")
    expect(await mergeEvents(off)).toHaveLength(0)
    expect(await linkRow(off)).toMatchObject({ state: "candidate", disputed: false })
  })

  it("an auto-confirmed pair is un-mergeable (a late dispute is no longer possible); the saga reopens it as disputed and no later run confirms it again", async () => {
    const s = await seed()
    const at = ((await linkRow(s)).createdAt as Timestamp).toMillis() + LINK_AUTO_CONFIRM_MS + DAY
    await runDay(s.firmId, at)
    const [event] = await mergeEvents(s)
    expectKind(await apiErrorOf(disputeLink({ token: s.partner.token, data: { firmId: s.firmId, linkId: s.linkId, note: NOTE } } as never)), "failed-precondition", "link_not_candidate")

    clock.set(at)
    const out = await unmergeEntity({ token: s.partner.token, data: { firmId: s.firmId, linkId: s.linkId, note: NOTE } } as never)
    expect(out.mergeEventId).toBe(event.id)
    for (const jobId of Object.values(out.jobIds)) {
      expect(await runJobTask({ jobId, seq: (await readJob(jobId)).dispatchSeq }, testDeps(clock))).toBe("done")
    }
    expect(await linkRow(s)).toMatchObject({ state: "candidate", disputed: true, unmerge: { status: "completed" } })
    expect((await events(s, "entity.unmerged"))).toHaveLength(1)

    expect((await runDay(s.firmId, at + 60 * DAY, "2026-12-01")).outcome).toBe("done")
    expect(await mergeEvents(s)).toHaveLength(1)
    expect(await linkRow(s)).toMatchObject({ state: "candidate", disputed: true })
  })

  it("more pairs than one step holds are all materialised, each once", async () => {
    const s = await seed()
    const at = ((await linkRow(s)).createdAt as Timestamp).toMillis() + LINK_AUTO_CONFIRM_MS + DAY
    // Seeded directly: pairs of entities with one aged candidate link row each.
    const total = AUTO_CONFIRM_STEP_PAIRS * 2 + 3
    const old = Timestamp.fromMillis(at - LINK_AUTO_CONFIRM_MS - DAY)
    const batch = adminDb().batch()
    const ids: string[] = []
    for (let i = 0; i < total; i += 1) {
      const l = `ent_${s.firmId}_${String(i).padStart(3, "0")}_l`
      const r = `ent_${s.firmId}_${String(i).padStart(3, "0")}_r`
      for (const id of [l, r]) batch.set(adminDb().collection("entities").doc(id), { firmId: s.firmId, canonicalName: id, cnic: `35202${String(i).padStart(8, "0")}`, classification: "internal" })
      const linkId = `${s.firmId}_${l}_${r}_cnic`
      ids.push(linkId)
      batch.set(adminDb().collection("entity_links").doc(linkId), { firmId: s.firmId, leftId: l, rightId: r, key: "cnic", state: "candidate", disputed: false, createdAt: old, classification: "internal" })
    }
    await batch.commit()
    const { jobId, outcome } = await runDay(s.firmId, at)
    expect(outcome).toBe("done")
    expect((await readJob(jobId)).status).toBe("done")
    expect(await mergeEvents(s)).toHaveLength(total + 1)
    for (const id of ids) expect((await adminDb().collection("entity_links").doc(id).get()).data()).toMatchObject({ state: "confirmed", confirmation: { auto: true } })
    expect(await events(s, "entity.confirmed")).toHaveLength(total + 1)
  })

  // Close-out (spec P3-51..P3-56). The seams are set in a test and cleared here.
  afterEach(() => {
    delete autoConfirmTestSeam.beforeStep
    delete autoConfirmTestSeam.beforeFlagRead
  })

  it("P3-56(a): an aged row with a young sibling for another key is admitted by the scan and rejected in the transaction; nothing is written", async () => {
    const firmId = await bareFirm()
    const at = Date.now()
    const { pairId, linkIds } = await seedPair(firmId, "a", [
      { key: "cnic", createdAt: Timestamp.fromMillis(at - LINK_AUTO_CONFIRM_MS - DAY) },
      { key: "phone", createdAt: Timestamp.fromMillis(at - DAY) },
    ])
    const seeded = await rowsOf(linkIds)
    const before = await readRegistryVersion(firmId)
    const steps = recordSteps()
    expect((await runDay(firmId, at)).outcome).toBe("done")
    await expectAdmittedAndRejected(firmId, pairId, linkIds, steps, seeded, before)
  })

  it("P3-56(b): a confirmed row plus an aged candidate row is admitted by the scan and rejected in the transaction; nothing is written", async () => {
    const firmId = await bareFirm()
    const at = Date.now()
    const old = Timestamp.fromMillis(at - LINK_AUTO_CONFIRM_MS - DAY)
    const { pairId, linkIds } = await seedPair(firmId, "b", [
      { key: "cnic", createdAt: old, state: "confirmed", confirmation: { by: "uid-partner", role: "partner", at: old, note: NOTE, mergeEventId: "evt-human" } },
      { key: "phone", createdAt: old },
    ])
    const seeded = await rowsOf(linkIds)
    const before = await readRegistryVersion(firmId)
    const steps = recordSteps()
    expect((await runDay(firmId, at)).outcome).toBe("done")
    await expectAdmittedAndRejected(firmId, pairId, linkIds, steps, seeded, before)
  })

  it("P3-56(c): a dispute that lands between the scan and the step is rejected in the transaction; nothing is written", async () => {
    const s = await seed()
    const at = ((await linkRow(s)).createdAt as Timestamp).toMillis() + LINK_AUTO_CONFIRM_MS + DAY
    // The dispute goes through the real route after the scan, before step 0's transaction (a late dispute, P2-28).
    const steps = recordSteps(async ({ index }) => {
      if (index === 0) await disputeLink({ token: s.partner.token, data: { firmId: s.firmId, linkId: s.linkId, note: NOTE } } as never)
    })
    expect((await runDay(s.firmId, at)).outcome).toBe("done")
    const disputed = await rowsOf([s.linkId])
    expect(disputed[0]).toMatchObject({ state: "candidate", disputed: true })
    // disputeLink bumps the registry itself, so the version is not compared here.
    await expectAdmittedAndRejected(s.firmId, s.pairId, [s.linkId], steps, disputed, null)
  })

  it("P3-56(d): a row with an un-merge in progress is admitted by the scan and rejected in the transaction; nothing is written", async () => {
    const firmId = await bareFirm()
    const at = Date.now()
    const old = Timestamp.fromMillis(at - LINK_AUTO_CONFIRM_MS - DAY)
    const { pairId, linkIds } = await seedPair(firmId, "d", [
      { key: "cnic", createdAt: old, unmerge: { status: "in_progress", mergeEventId: "evt-unmerging", by: "uid-partner", role: "partner", at: old, note: NOTE } },
    ])
    const seeded = await rowsOf(linkIds)
    const before = await readRegistryVersion(firmId)
    const steps = recordSteps()
    expect((await runDay(firmId, at)).outcome).toBe("done")
    await expectAdmittedAndRejected(firmId, pairId, linkIds, steps, seeded, before)
  })

  it("P3-51: a retry after three committed steps with more than 480 pairs waiting never reaches fenced_step_limit, and every pair gets exactly one merge event across both attempts and the next day", async () => {
    const firmId = await bareFirm()
    const at = Date.now()
    // 520 pairs: the first attempt commits steps 0-2 (30 pairs) and fails; 490 then wait, more than one run's 480.
    const total = AUTO_CONFIRM_STEP_PAIRS * AUTO_CONFIRM_MAX_STEPS + 40
    const pairIds = await seedPairs(firmId, total, Timestamp.fromMillis(at - LINK_AUTO_CONFIRM_MS - DAY))
    const steps = recordSteps(async ({ attempt, index }) => {
      if (attempt === 1 && index === 3) throw new Error("seam: the attempt fails after three committed steps")
    })

    const { jobId, deps, outcome } = await runDay(firmId, at)
    expect(outcome).toBe("failed")
    const failed = await readJob(jobId)
    expect(failed).toMatchObject({ status: "failed", attempts: 1, lastError: { code: "internal" } })
    expect(Object.keys(failed.fencedSteps ?? {}).sort()).toEqual(["autoconfirm-0", "autoconfirm-1", "autoconfirm-2"])
    expect(await firmMergeEvents(firmId)).toHaveLength(3 * AUTO_CONFIRM_STEP_PAIRS)

    // The retry reuses positions 0..47: 0-2 are skipped (their new pairs wait a day), 3..47 commit.
    expect(await deps.dispatcher.drainDue(at + RETRY_DELAYS_MS[0])).toEqual(["done"])
    const retried = await readJob(jobId)
    expect(retried).toMatchObject({ status: "done", attempts: 2, lastError: null })
    const recorded = Object.keys(retried.fencedSteps ?? {})
    expect(recorded.sort()).toEqual(Array.from({ length: AUTO_CONFIRM_MAX_STEPS }, (_, n) => `autoconfirm-${n}`).sort())
    expect(recorded.length).toBeLessThanOrEqual(MAX_FENCED_STEPS)
    expect(retried.logs.map((l) => l.code)).not.toContain("fenced_step_limit")
    expect(steps.filter((s) => s.attempt === 2).map((s) => s.index)).toEqual(Array.from({ length: AUTO_CONFIRM_MAX_STEPS }, (_, n) => n))
    expect(await firmMergeEvents(firmId)).toHaveLength(AUTO_CONFIRM_STEP_PAIRS * AUTO_CONFIRM_MAX_STEPS)

    // The next day's run (a new job, so attempt 1 again: the seam is disarmed) confirms the pairs that sat at the skipped positions.
    delete autoConfirmTestSeam.beforeStep
    expect((await runDay(firmId, at + DAY, "2026-10-12")).outcome).toBe("done")
    const merged = await firmMergeEvents(firmId)
    const perPair = new Map<string, number>()
    for (const e of merged) perPair.set(e.data().pairId, (perPair.get(e.data().pairId) ?? 0) + 1)
    expect([...perPair.keys()].sort()).toEqual([...pairIds].sort())
    expect([...perPair.values()].every((n) => n === 1)).toBe(true)
    expect(merged).toHaveLength(total)
    expect(await firmEvents(firmId, "entity.confirmed")).toHaveLength(total)
    expect(await confirmAudits(firmId)).toHaveLength(total)
    const confirmed = await links().where("firmId", "==", firmId).where("state", "==", "confirmed").get()
    expect(confirmed.size).toBe(total)
  }, 300_000)

  it("P3-52: each materialised pair writes one system entity.confirm audit row that targets its merge event", async () => {
    const s = await seed()
    const at = ((await linkRow(s)).createdAt as Timestamp).toMillis() + LINK_AUTO_CONFIRM_MS + DAY
    expect((await runDay(s.firmId, at)).outcome).toBe("done")
    const [event] = await mergeEvents(s)
    const audits = await confirmAudits(s.firmId)
    expect(audits).toHaveLength(1)
    expect(audits[0].data()).toEqual({
      firmId: s.firmId,
      actorId: "system",
      onBehalfOf: "system",
      action: "entity.confirm",
      target: `merge_events/${event.id}`,
      classification: "internal",
      decision: "allow",
      reason: "auto_confirm",
      occurredAt: expect.any(Timestamp),
    })
    expect((await runDay(s.firmId, at + DAY, "2026-10-12")).outcome).toBe("done")
    expect(await confirmAudits(s.firmId)).toHaveLength(1)
  })

  it("P3-55: the merge event id is derived from firm, pair and sorted link ids, and a pair whose event already exists is left alone", async () => {
    const firmId = await bareFirm()
    const at = Date.now()
    const old = Timestamp.fromMillis(at - LINK_AUTO_CONFIRM_MS - DAY)
    const fresh = await seedPair(firmId, "fresh", [
      { key: "phone", createdAt: old },
      { key: "cnic", createdAt: old },
    ])
    const done = await seedPair(firmId, "done", [{ key: "cnic", createdAt: old }])
    const doneId = expectedEventId(firmId, done.pairId, done.linkIds)
    await adminDb().collection("merge_events").doc(doneId).set({ firmId, kind: "link_confirmed", pairId: done.pairId, linkIds: done.linkIds, basis: "auto_confirm", reverted: false, classification: "internal" })
    const doneSeeded = await rowsOf(done.linkIds)

    expect((await runDay(firmId, at)).outcome).toBe("done")
    const freshId = expectedEventId(firmId, fresh.pairId, fresh.linkIds)
    expect((await firmMergeEvents(firmId)).map((d) => d.id).sort()).toEqual([doneId, freshId].sort())
    const event = (await adminDb().collection("merge_events").doc(freshId).get()).data()!
    expect(event).toMatchObject({ pairId: fresh.pairId, linkIds: fresh.linkIds, priorState: "auto_confirmed", actorId: "system" })
    for (const row of await rowsOf(fresh.linkIds)) expect(row).toMatchObject({ state: "confirmed", confirmation: { mergeEventId: freshId, auto: true } })
    expect((await firmEvents(firmId, "entity.confirmed")).map((d) => d.id)).toEqual([`${freshId}_confirmed`])
    expect((await confirmAudits(firmId)).map((d) => d.data().target)).toEqual([`merge_events/${freshId}`])
    // The pair whose event already exists: nothing written, and the run still succeeds.
    expect(await rowsOf(done.linkIds)).toEqual(doneSeeded)
  })

  it("P3-54: L17.2 switched off between two steps stops every later step from writing", async () => {
    const firmId = await bareFirm()
    const at = Date.now()
    const total = AUTO_CONFIRM_STEP_PAIRS * 2 + 5
    const pairIds = await seedPairs(firmId, total, Timestamp.fromMillis(at - LINK_AUTO_CONFIRM_MS - DAY))
    const steps = recordSteps(async ({ index }) => {
      if (index === 1) await adminDb().collection("firms").doc(firmId).update({ "featureFlags.L17_2_ENABLED": false })
    })
    expect((await runDay(firmId, at)).outcome).toBe("done")
    const first = steps.find((s) => s.index === 0)!.pairIds
    expect(first).toHaveLength(AUTO_CONFIRM_STEP_PAIRS)
    expect((await firmMergeEvents(firmId)).map((d) => d.data().pairId).sort()).toEqual([...first].sort())
    const candidates = await links().where("firmId", "==", firmId).where("state", "==", "candidate").get()
    expect(candidates.docs.map((d) => `${d.data().leftId}_${d.data().rightId}`).sort()).toEqual(pairIds.filter((p) => !first.includes(p)).sort())
    expect(await confirmAudits(firmId)).toHaveLength(AUTO_CONFIRM_STEP_PAIRS)
  })

  it("P3-54: a failed flag read fails the attempt with the retryable flag_read_failed, and the retry materialises the pair", async () => {
    const s = await seed()
    const at = ((await linkRow(s)).createdAt as Timestamp).toMillis() + LINK_AUTO_CONFIRM_MS + DAY
    autoConfirmTestSeam.beforeFlagRead = async () => {
      throw Object.assign(new Error("seam: the flag read fails"), { code: 14 })
    }
    const { jobId, deps, outcome } = await runDay(s.firmId, at)
    expect(outcome).toBe("failed")
    expect(await readJob(jobId)).toMatchObject({ status: "failed", attempts: 1, lastError: { code: "flag_read_failed" } })
    expect(await mergeEvents(s)).toHaveLength(0)

    delete autoConfirmTestSeam.beforeFlagRead
    expect(await deps.dispatcher.drainDue(at + RETRY_DELAYS_MS[0])).toEqual(["done"])
    expect(await mergeEvents(s)).toHaveLength(1)
    expect(await linkRow(s)).toMatchObject({ state: "confirmed", confirmation: { auto: true } })
  })
})
