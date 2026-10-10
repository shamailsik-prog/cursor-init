import { describe, expect, it } from "vitest"
import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { adminDb } from "../src/admin"
import { AUTO_CONFIRM_JOB_TYPE, AUTO_CONFIRM_STEP_PAIRS } from "../src/d1/entity/autoConfirmJob"
import { LINK_AUTO_CONFIRM_MS } from "../src/d1/entity/linkState"
import { readRegistryVersion } from "../src/d1/registryVersion"
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

/** Enqueues one daily run for the firm and delivers it through the worker at `at`. */
async function runDay(firmId: string, at: number, period = "2026-10-11") {
  clock.set(at)
  const spec = { firmId, jobType: AUTO_CONFIRM_JOB_TYPE, classification: "internal" as const, matterId: null, payload: { period }, idempotencyKey: `${AUTO_CONFIRM_JOB_TYPE}:${period}`, runKey: `${AUTO_CONFIRM_JOB_TYPE}:${period}`, createdBy: "system" }
  await enqueueAt(spec, at)
  const jobId = jobIdFor(firmId, AUTO_CONFIRM_JOB_TYPE, spec.idempotencyKey)
  return { jobId, outcome: await runJobTask({ jobId, seq: (await readJob(jobId)).dispatchSeq }, testDeps(clock)) }
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
      priorState: "candidate",
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
})
