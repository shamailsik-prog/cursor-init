import { createHash } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Timestamp, type DocumentData, type DocumentReference } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { adminDb } from "../src/admin"
import { AUTO_CONFIRM_JOB_TYPE, AUTO_CONFIRM_SPEC, AUTO_CONFIRM_STEP_PAIRS, autoConfirmTestSeam, mergeEventIdOf } from "../src/d1/entity/autoConfirmJob"
import { LINK_AUTO_CONFIRM_MS } from "../src/d1/entity/linkState"
import { JOB_LEASE_MS, RETRY_DELAYS_MS } from "../src/p2/constants"
import { jobIdFor, type JobSpec } from "../src/p2/enqueue"
import { onJobCreatedCore } from "../src/p2/functions"
import { enqueueScheduledRuns, periodKey } from "../src/p2/scheduled"
import { runJobTask } from "../src/p2/worker"
import { EMULATORS, uniq } from "./emu"
import { FakeClock, enqueueAt, readJob, testDeps } from "./jobs"

/**
 * Audit F38 (spec docs/superpowers/specs/2026-10-18-f38-auto-confirm-progress-design.md): the auto-confirm job
 * reaches every eligible pair however many ineligible pairs sit ahead of it. End to end over the Firestore and
 * Auth emulators, through the real engine: the scheduled tick (`enqueueScheduledRuns`), the job-created trigger's
 * core (`onJobCreatedCore`), the worker (`runJobTask`) and the in-process Cloud Tasks stand-in, on a fake clock.
 *
 * The spec's values are pinned here, not imported, so the tests check the spec rather than the code.
 * Every document a test creates is deleted after it (firm-scoped collections, plus the tick's job rows for every
 * other firm in the emulator).
 */

const DAY = 86_400_000
const HOUR = 3_600_000
const DEFERRALS = "autoconfirm_deferrals"
const MAX_CONTINUATIONS = 23
const STALE_MS = 36 * HOUR
const RECHECK_MS = 7 * DAY
const RUN_PAIRS = 480
const NOTE = "Same CNIC on both files, but they are two cousins."
/** Simulated days start here (PKT 2033-03-01), a period no other suite uses. */
const T = Date.parse("2033-03-01T00:00:00Z")
const HEAD_AT = T - 60 * DAY
const TAIL_AT = T - 40 * DAY

const db = () => adminDb()
const links = () => db().collection("entity_links")
const jobs = () => db().collection("jobs")
const progressRef = (firmId: string) => db().collection("counters").doc(`${firmId}_autoconfirm`)
const deferralIdOf = (firmId: string, pairId: string) => "acd_" + createHash("sha256").update(`${firmId}\0${pairId}`).digest("hex").slice(0, 40)
const clock = new FakeClock(T)

// ---------------------------------------------------------------- seeding

type Kind =
  | "eligible"
  | "young_row"
  | "confirmed_row"
  | "rejected_row"
  | "disputed_row"
  | "unmerge_in_progress"
  | "invalid_row"
  | "entity_missing"
  | "entity_other_firm"
  | "event_exists"
  | "no_pair"

const INELIGIBLE: readonly Kind[] = ["young_row", "confirmed_row", "rejected_row", "disputed_row", "unmerge_in_progress", "invalid_row", "entity_missing", "entity_other_firm", "event_exists"]

type Seeded = { kind: Kind; left: string; right: string; pairId: string; linkIds: string[]; scanLinkId: string }

/** Firms a test created; afterEach deletes everything they own. */
const created: string[] = []
/** Periods a test ticked for every firm; afterEach deletes those job rows and their audit rows. */
const ticked: string[] = []

async function newFirm(extra: Record<string, unknown> = {}): Promise<string> {
  const firmId = uniq("f38")
  created.push(firmId)
  await db().collection("firms").doc(firmId).set({ name: "F38", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS", ...extra })
  return firmId
}

/**
 * Seeds pairs of the given kinds, one per entry, in batches. The pair's row that the scan matches (an aged
 * undisputed candidate) is created at `at + i` ms, so pairs reach the frontier in the order given.
 */
async function seedPairs(firmId: string, kinds: readonly Kind[], at: number, tag: string): Promise<Seeded[]> {
  const out: Seeded[] = []
  let batch = db().batch()
  let writes = 0
  const write = async (ref: DocumentReference, data: DocumentData) => {
    batch.set(ref, data)
    writes += 1
    if (writes >= 450) {
      await batch.commit()
      batch = db().batch()
      writes = 0
    }
  }
  for (let i = 0; i < kinds.length; i += 1) {
    const kind = kinds[i]
    const n = `${tag}${String(i).padStart(5, "0")}`
    const l = kind === "no_pair" ? `e_${firmId}_${n}_x` : `e_${firmId}_${n}_l`
    const r = kind === "no_pair" ? l : `e_${firmId}_${n}_r`
    const old = Timestamp.fromMillis(at + i)
    const row = (key: string, extra: Record<string, unknown> = {}) => ({ firmId, leftId: l, rightId: r, key, state: "candidate", disputed: false, createdAt: old, classification: "internal", ...extra })
    const rows: Array<[string, DocumentData]> = [[`${firmId}_${l}_${r}_cnic`, row("cnic", kind === "unmerge_in_progress" ? { unmerge: { status: "in_progress", mergeEventId: "evt-unmerging", by: "uid-partner", role: "partner", at: old, note: NOTE } } : {})]]
    let scanLinkId = rows[0][0]
    if (kind === "young_row") rows.push([`${firmId}_${l}_${r}_phone`, row("phone", { createdAt: Timestamp.fromMillis(T - DAY) })])
    if (kind === "confirmed_row" || kind === "rejected_row" || kind === "disputed_row") {
      const decided =
        kind === "confirmed_row"
          ? { state: "confirmed", confirmation: { by: "uid-partner", role: "partner", at: old, note: NOTE, mergeEventId: "evt-human" } }
          : kind === "rejected_row"
            ? { state: "rejected", rejection: { by: "uid-partner", role: "partner", at: old, note: NOTE } }
            : { disputed: true, dispute: { by: "uid-partner", role: "partner", at: old, note: NOTE } }
      rows[0] = [rows[0][0], row("cnic", decided)]
      rows.push([`${firmId}_${l}_${r}_phone`, row("phone")])
      scanLinkId = rows[1][0]
    }
    if (kind === "invalid_row") rows.push([`${firmId}_${l}_${r}_ntn`, row("ntn", { state: "pending" })])
    const entityFirm = kind === "entity_other_firm" ? `${firmId}-other` : firmId
    if (kind !== "entity_missing" && kind !== "no_pair") {
      for (const id of [l, r]) await write(db().collection("entities").doc(id), { firmId: entityFirm, canonicalName: id, cnic: `35202${String(i).padStart(8, "0")}`, classification: "internal" })
    }
    for (const [id, data] of rows) await write(links().doc(id), data)
    const pairId = `${l}_${r}`
    const linkIds = rows.map(([id]) => id).sort()
    if (kind === "event_exists") {
      await write(db().collection("merge_events").doc(mergeEventIdOf(firmId, pairId, linkIds)), { firmId, kind: "link_confirmed", pairId, linkIds, basis: "auto_confirm", reverted: false, classification: "internal" })
    }
    out.push({ kind, left: l, right: r, pairId, linkIds, scanLinkId })
  }
  if (writes > 0) await batch.commit()
  return out
}

/** `count` kinds cycling through every ineligible reason. */
const mixedIneligible = (count: number): Kind[] => Array.from({ length: count }, (_, i) => INELIGIBLE[i % INELIGIBLE.length])
const many = (kind: Kind, count: number): Kind[] => Array.from({ length: count }, () => kind)

// ---------------------------------------------------------------- running

const periodOf = (at: number) => periodKey("day", at)
const runKeyOf = (period: string, n: number) => (n === 0 ? `${AUTO_CONFIRM_JOB_TYPE}:${period}` : `${AUTO_CONFIRM_JOB_TYPE}:${period}:c${n}`)
const runIdOf = (firmId: string, period: string, n: number) => jobIdFor(firmId, AUTO_CONFIRM_JOB_TYPE, runKeyOf(period, n))
const runSpec = (firmId: string, period: string, n = 0): JobSpec => ({
  firmId,
  jobType: AUTO_CONFIRM_JOB_TYPE,
  classification: "internal",
  matterId: null,
  payload: n === 0 ? { period } : { period, continuation: n },
  idempotencyKey: runKeyOf(period, n),
  runKey: runKeyOf(period, n),
  createdBy: "system",
})

type Deps = ReturnType<typeof testDeps>

/**
 * Delivers the period's run for the firm and then each continuation it enqueues, as production does: the
 * job-created trigger dispatches the new row and the queue delivers it. Returns how many runs were delivered.
 */
async function deliverChain(firmId: string, period: string, deps: Deps, from = 0): Promise<number> {
  let runs = 0
  for (let n = from; n <= MAX_CONTINUATIONS; n += 1) {
    const jobId = runIdOf(firmId, period, n)
    const snap = await jobs().doc(jobId).get()
    if (!snap.exists) break
    await onJobCreatedCore(jobId, snap.data(), deps)
    await deps.dispatcher.drainDue(clock.now())
    runs += 1
  }
  return runs
}

/** One simulated day through the scheduled tick: every firm's run is enqueued, the given firm's chain delivered. */
async function tickDay(firmId: string, at: number): Promise<number> {
  clock.set(at)
  const period = periodOf(at)
  ticked.push(period)
  await enqueueScheduledRuns(AUTO_CONFIRM_SPEC, at)
  return deliverChain(firmId, period, testDeps(clock))
}

/** One simulated day without the tick: the same run spec, for one firm. */
async function runDay(firmId: string, at: number, deps: Deps = testDeps(clock)): Promise<number> {
  clock.set(at)
  await enqueueAt(runSpec(firmId, periodOf(at)), at)
  return deliverChain(firmId, periodOf(at), deps)
}

// ---------------------------------------------------------------- reading

const rowsOf = async (ids: string[]) => Promise.all(ids.map(async (id) => (await links().doc(id).get()).data()))
const progress = async (firmId: string) => (await progressRef(firmId).get()).data()
const deferralsOf = async (firmId: string) => (await db().collection(DEFERRALS).where("firmId", "==", firmId).get()).docs
const mergeEventsOf = async (firmId: string) => (await db().collection("merge_events").where("firmId", "==", firmId).get()).docs

/** Pairs (of `pairs`) with an `auto_confirm` merge event, counted once each, and the largest count any pair has. */
async function confirmedOf(firmId: string, pairs: Seeded[]): Promise<{ confirmed: number; maxPerPair: number }> {
  const want = new Set(pairs.map((p) => p.pairId))
  const per = new Map<string, number>()
  for (const e of await mergeEventsOf(firmId)) {
    const { pairId, basis } = e.data()
    if (want.has(pairId) && basis === "auto_confirm" && e.data().actorId === "system") per.set(pairId, (per.get(pairId) ?? 0) + 1)
  }
  return { confirmed: per.size, maxPerPair: Math.max(0, ...per.values()) }
}

const firmCount = async (collection: string, firmId: string, field: string, value: string) =>
  (await db().collection(collection).where("firmId", "==", firmId).where(field, "==", value).count().get()).data().count

// ---------------------------------------------------------------- cleanup

async function deleteAll(refs: DocumentReference[]): Promise<void> {
  for (let i = 0; i < refs.length; i += 450) {
    const batch = db().batch()
    for (const ref of refs.slice(i, i + 450)) batch.delete(ref)
    await batch.commit()
  }
}

const FIRM_COLLECTIONS = ["entity_links", "entities", "merge_events", "events", "audit_log", "jobs", "counters", DEFERRALS, "clients"]

async function purgeFirm(firmId: string): Promise<void> {
  for (const owner of [firmId, `${firmId}-other`]) {
    for (const name of FIRM_COLLECTIONS) {
      const snap = await db().collection(name).where("firmId", "==", owner).select().get()
      await deleteAll(snap.docs.map((d) => d.ref))
    }
  }
  await db().collection("firms").doc(firmId).delete()
}

async function purgeTicks(period: string): Promise<void> {
  const rows = await jobs().where("runKey", "==", runKeyOf(period, 0)).select().get()
  // Their job.enqueue audit rows, 30 targets per query (the `in` limit), so a crowded emulator costs few queries.
  const targets = rows.docs.map((row) => `jobs/${row.id}`)
  for (let i = 0; i < targets.length; i += 30) {
    const audits = await db().collection("audit_log").where("target", "in", targets.slice(i, i + 30)).select().get()
    await deleteAll(audits.docs.map((d) => d.ref))
  }
  await deleteAll(rows.docs.map((d) => d.ref))
}

afterEach(async () => {
  delete autoConfirmTestSeam.beforeStep
  delete (autoConfirmTestSeam as Record<string, unknown>).beforeCheckpoint
  vi.restoreAllMocks()
  for (const period of ticked.splice(0)) await purgeTicks(period)
  for (const firmId of created.splice(0)) await purgeFirm(firmId)
}, 300_000)

type StepInfo = { attempt: number; index: number; pairIds: readonly string[]; continuation?: number; phase?: string }
type CheckpointInfo = { attempt: number; continuation: number }
const seam = autoConfirmTestSeam as {
  beforeStep?: (s: StepInfo) => Promise<void>
  beforeCheckpoint?: (c: CheckpointInfo) => Promise<void>
}

const logged = (spy: { mock: { calls: unknown[][] } }, message: string) => spy.mock.calls.filter(([m]) => m === message).map(([, data]) => data)

// ---------------------------------------------------------------- tests

describe.skipIf(!EMULATORS)("F38 auto-confirm progress (audit F38)", () => {
  it("F38 RED/GREEN: more than 2,000 ineligible head pairs never starve the eligible pairs behind them", async () => {
    const firmId = await newFirm()
    const head = await seedPairs(firmId, mixedIneligible(2002), HEAD_AT, "h")
    const tail = await seedPairs(firmId, many("eligible", 15), TAIL_AT, "t")
    const headLinks = head.flatMap((p) => p.linkIds)
    const seededHead = await rowsOf(headLinks)

    const confirmedByDay: number[] = []
    const runsByDay: number[] = []
    for (let day = 0; day < 3; day += 1) {
      runsByDay.push(await tickDay(firmId, T + day * DAY))
      confirmedByDay.push((await confirmedOf(firmId, tail)).confirmed)
    }
    console.log(`F38 RED/GREEN: eligible pairs confirmed (cumulative) by day ${JSON.stringify(confirmedByDay)} of ${tail.length}; runs by day ${JSON.stringify(runsByDay)}`)

    // Every eligible pair on day 1, within ceil((2,002 + 15) / 480) = 5 runs; nothing more to do on days 2 and 3.
    expect(confirmedByDay).toEqual([15, 15, 15])
    expect(runsByDay).toEqual([5, 1, 1])
    expect((await confirmedOf(firmId, tail)).maxPerPair).toBe(1)
    // The ineligible pairs: still candidates, rows exactly as seeded, no merge event written by the job.
    expect(await rowsOf(headLinks)).toEqual(seededHead)
    expect((await confirmedOf(firmId, head)).confirmed).toBe(0)
    // ...each with a deferral record carrying its reason, by code and ids only.
    const records = new Map((await deferralsOf(firmId)).map((d) => [d.id, d.data()]))
    expect(records.size).toBe(head.length)
    for (const p of head) {
      const record = records.get(deferralIdOf(firmId, p.pairId))
      expect(record, p.pairId).toMatchObject({ firmId, pairId: p.pairId, reason: p.kind, linkIds: p.linkIds, classification: "internal" })
    }
    // The backlog drained: no stale alert left on the progress record.
    expect(await progress(firmId)).toMatchObject({ firmId, backlog: { alert: null, pendingSince: null }, lastRun: { outcome: "drained" } })
  }, 900_000)

  it("F38 alert: a stale backlog logs autoconfirm.backlog_stale and records it; the run that drains it logs autoconfirm.backlog_cleared", async () => {
    const firmId = await newFirm()
    await seedPairs(firmId, many("entity_missing", RUN_PAIRS + 1), HEAD_AT, "h")
    const tail = await seedPairs(firmId, many("eligible", 5), TAIL_AT, "t")
    const error = vi.spyOn(logger, "error")
    const info = vi.spyOn(logger, "info")
    clock.set(T)
    const period = periodOf(T)
    await enqueueAt(runSpec(firmId, period), T)
    expect(await deliverChain(firmId, period, testDeps(clock))).toBe(2)

    // The first run left 1 head pair: its row became due at HEAD_AT + 480 ms + 30 days, far more than 36 h ago.
    const stale = logged(error, "autoconfirm.backlog_stale")
    expect(stale).toEqual([{ firmId, jobId: runIdOf(firmId, period, 0), source: "frontier", ageMs: T - (HEAD_AT + RUN_PAIRS + LINK_AUTO_CONFIRM_MS) }])
    expect((stale[0] as { ageMs: number }).ageMs).toBeGreaterThan(STALE_MS)
    expect(logged(info, "autoconfirm.backlog_cleared")).toEqual([{ firmId, jobId: runIdOf(firmId, period, 1) }])
    expect((await confirmedOf(firmId, tail)).confirmed).toBe(5)
    expect(await progress(firmId)).toMatchObject({ backlog: { alert: null, pendingSince: null }, lastRun: { jobId: runIdOf(firmId, period, 1), outcome: "drained" } })
    expect((await readJob(runIdOf(firmId, period, 0))).status).toBe("done")
  }, 300_000)

  it("F38 alert: the stale state is recorded on the progress doc while the backlog waits", async () => {
    const firmId = await newFirm()
    await seedPairs(firmId, many("entity_missing", RUN_PAIRS + 1), HEAD_AT, "h")
    clock.set(T)
    const period = periodOf(T)
    await enqueueAt(runSpec(firmId, period), T)
    // Only the first run: its continuation is left undelivered.
    const deps = testDeps(clock)
    await onJobCreatedCore(runIdOf(firmId, period, 0), (await jobs().doc(runIdOf(firmId, period, 0)).get()).data(), deps)
    expect(await deps.dispatcher.drainDue(T)).toEqual(["done"])
    const p = await progress(firmId)
    expect(p).toMatchObject({ backlog: { alert: "stale", source: "frontier", alertSince: Timestamp.fromMillis(T) }, lastRun: { jobId: runIdOf(firmId, period, 0), continuation: 0, outcome: "continued", confirmed: 0, deferred: RUN_PAIRS } })
    expect((p!.backlog.pendingSince as Timestamp).toMillis()).toBe(HEAD_AT + RUN_PAIRS + LINK_AUTO_CONFIRM_MS)
    expect((await readJob(runIdOf(firmId, period, 1))).payload).toEqual({ period, continuation: 1 })
  }, 300_000)

  it("F38 the period's last continuation leaves the rest to the next day and says so (autoconfirm.backlog_remaining)", async () => {
    const firmId = await newFirm()
    await seedPairs(firmId, many("entity_missing", RUN_PAIRS + 1), HEAD_AT, "h")
    const warn = vi.spyOn(logger, "warn")
    clock.set(T)
    const period = periodOf(T)
    await enqueueAt(runSpec(firmId, period, MAX_CONTINUATIONS), T)
    const deps = testDeps(clock)
    expect(await deliverChain(firmId, period, deps, MAX_CONTINUATIONS)).toBe(1)
    expect(logged(warn, "autoconfirm.backlog_remaining")).toEqual([{ firmId, jobId: runIdOf(firmId, period, MAX_CONTINUATIONS), period, continuation: MAX_CONTINUATIONS }])
    expect((await jobs().doc(runIdOf(firmId, period, MAX_CONTINUATIONS + 1)).get()).exists).toBe(false)
    expect(await progress(firmId)).toMatchObject({ lastRun: { outcome: "backlog_remaining" } })
    // The next day's run picks up where it stopped.
    expect(await runDay(firmId, T + DAY)).toBe(1)
    expect(await deferralsOf(firmId)).toHaveLength(RUN_PAIRS + 1)
  }, 300_000)

  it("F38 crash and retry: a failed checkpoint and a continuation failing mid-run are retried; one continuation each; duplicates are dropped; every pair confirmed once", async () => {
    const firmId = await newFirm()
    const pairs = await seedPairs(firmId, many("eligible", 500), TAIL_AT, "t")
    seam.beforeCheckpoint = async ({ attempt, continuation }) => {
      if (continuation === 0 && attempt === 1) throw new Error("seam: the run's checkpoint fails after its steps")
    }
    seam.beforeStep = async ({ attempt, index, continuation }) => {
      if (continuation === 1 && attempt === 1 && index === 1) throw new Error("seam: the continuation fails after one committed step")
    }
    const deps = testDeps(clock)
    clock.set(T)
    const period = periodOf(T)
    const run = runIdOf(firmId, period, 0)
    const c1 = runIdOf(firmId, period, 1)
    await enqueueAt(runSpec(firmId, period), T)
    await onJobCreatedCore(run, (await jobs().doc(run).get()).data(), deps)
    expect(await deps.dispatcher.drainDue(T)).toEqual(["failed"])
    expect(await readJob(run)).toMatchObject({ status: "failed", attempts: 1, lastError: { code: "internal" } })
    expect((await confirmedOf(firmId, pairs)).confirmed).toBe(RUN_PAIRS)
    expect((await jobs().doc(c1).get()).exists).toBe(false)

    // The retry spends every recorded position, then checkpoints: one continuation.
    expect(await deps.dispatcher.drainDue(T + RETRY_DELAYS_MS[0])).toEqual(["done"])
    expect((await jobs().where("firmId", "==", firmId).where("jobType", "==", AUTO_CONFIRM_JOB_TYPE).get()).size).toBe(2)
    expect((await confirmedOf(firmId, pairs)).confirmed).toBe(RUN_PAIRS)
    // A duplicate delivery of the finished run is dropped.
    expect(await runJobTask({ jobId: run, seq: 0 }, deps)).toBe("dropped")

    clock.set(T + RETRY_DELAYS_MS[0])
    await onJobCreatedCore(c1, (await jobs().doc(c1).get()).data(), deps)
    expect(await deps.dispatcher.drainDue(clock.now())).toEqual(["failed"])
    expect((await confirmedOf(firmId, pairs)).confirmed).toBe(RUN_PAIRS + AUTO_CONFIRM_STEP_PAIRS)
    expect(await deps.dispatcher.drainDue(clock.now() + RETRY_DELAYS_MS[0])).toEqual(["done"])
    const finished = await readJob(c1)
    expect(finished).toMatchObject({ status: "done", attempts: 2 })
    expect(Object.keys(finished.fencedSteps ?? {}).sort()).toEqual(["autoconfirm-0", "autoconfirm-1"])
    // The trigger firing again and a duplicate delivery change nothing.
    await onJobCreatedCore(c1, (await jobs().doc(c1).get()).data(), deps)
    expect(await runJobTask({ jobId: c1, seq: 0 }, deps)).toBe("dropped")

    expect(await confirmedOf(firmId, pairs)).toEqual({ confirmed: 500, maxPerPair: 1 })
    expect(await firmCount("events", firmId, "name", "entity.confirmed")).toBe(500)
    expect(await firmCount("audit_log", firmId, "action", "entity.confirm")).toBe(500)
    expect((await jobs().doc(runIdOf(firmId, period, 2)).get()).exists).toBe(false)
    expect(await progress(firmId)).toMatchObject({ lastRun: { jobId: c1, outcome: "drained" } })
  }, 600_000)

  it("F38 fencing: a continuation attempt whose lease is reclaimed mid-run commits nothing after it loses the fence", async () => {
    const firmId = await newFirm()
    const pairs = await seedPairs(firmId, many("eligible", 30), TAIL_AT, "t")
    clock.set(T)
    const period = periodOf(T)
    const c1 = runIdOf(firmId, period, 1)
    await enqueueAt(runSpec(firmId, period, 1), T)
    const deps = testDeps(clock)
    let reclaim: string | undefined
    seam.beforeStep = async ({ attempt, index }) => {
      if (attempt !== 1 || index !== 1 || reclaim !== undefined) return
      // The first attempt stalls past its lease after one committed step; another delivery reclaims and finishes.
      clock.advance(JOB_LEASE_MS + 1000)
      reclaim = await runJobTask({ jobId: c1, seq: 0 }, deps)
    }
    expect(await runJobTask({ jobId: c1, seq: 0 }, deps)).toBe("lease_lost")
    expect(reclaim).toBe("done")
    const row = await readJob(c1)
    expect(row).toMatchObject({ status: "done", attempts: 2 })
    expect(Object.keys(row.fencedSteps ?? {}).sort()).toEqual(["autoconfirm-0", "autoconfirm-1", "autoconfirm-2"])
    expect(await confirmedOf(firmId, pairs)).toEqual({ confirmed: 30, maxPerPair: 1 })
    expect(await firmCount("audit_log", firmId, "action", "entity.confirm")).toBe(30)
  }, 300_000)

  // PR #84 review round 1 (Codex P1): the checkpoint is fenced like a step (spec R7 amendment).
  it("F38 checkpoint fence: an attempt whose claim another delivery took before its checkpoint writes no progress and enqueues no continuation", async () => {
    const firmId = await newFirm()
    await seedPairs(firmId, many("entity_missing", RUN_PAIRS + 1), HEAD_AT, "h")
    clock.set(T)
    const period = periodOf(T)
    const run = runIdOf(firmId, period, 0)
    await enqueueAt(runSpec(firmId, period), T)
    seam.beforeCheckpoint = async ({ attempt }) => {
      // Another delivery holds the claim now (its own lease), while this attempt is about to checkpoint.
      if (attempt === 1) await jobs().doc(run).update({ attempts: 2, totalAttempts: 2, lease: { owner: "newer-claim", expiresAt: Timestamp.fromMillis(T + 2 * JOB_LEASE_MS) } })
    }
    expect(await runJobTask({ jobId: run, seq: 0 }, testDeps(clock))).toBe("lease_lost")
    expect((await jobs().doc(runIdOf(firmId, period, 1)).get()).exists).toBe(false)
    const p = await progress(firmId)
    // The steps committed under the fence (480 records, the cursor); the stale checkpoint wrote nothing.
    expect(await deferralsOf(firmId)).toHaveLength(RUN_PAIRS)
    expect(p!.cursor).toBeDefined()
    expect(p!.lastRun).toBeUndefined()
    expect(p!.backlog).toBeUndefined()
  }, 300_000)

  it("F38 checkpoint fence: an attempt reclaimed and finished by a newer attempt neither overwrites its progress nor enqueues a continuation", async () => {
    const firmId = await newFirm()
    const head = await seedPairs(firmId, many("entity_missing", RUN_PAIRS + 1), HEAD_AT, "h")
    clock.set(T)
    const period = periodOf(T)
    const run = runIdOf(firmId, period, 0)
    await enqueueAt(runSpec(firmId, period), T)
    const deps = testDeps(clock)
    let newer: string | undefined
    seam.beforeCheckpoint = async ({ attempt }) => {
      if (attempt !== 1) return
      // The attempt stalls past its lease before its checkpoint. Meanwhile the last waiting pair leaves the backlog,
      // and a redelivery reclaims the job and finishes it: the frontier is drained, so no continuation.
      await links().doc(head[RUN_PAIRS].scanLinkId).update({ disputed: true })
      clock.advance(JOB_LEASE_MS + 1000)
      newer = await runJobTask({ jobId: run, seq: 0 }, deps)
    }
    expect(await runJobTask({ jobId: run, seq: 0 }, deps)).toBe("lease_lost")
    expect(newer).toBe("done")
    expect(await readJob(run)).toMatchObject({ status: "done", attempts: 2 })
    expect((await jobs().doc(runIdOf(firmId, period, 1)).get()).exists).toBe(false)
    // The newer attempt's record stands: drained, at its own clock.
    const p = await progress(firmId)
    expect(p!.lastRun).toMatchObject({ outcome: "drained", at: Timestamp.fromMillis(T + JOB_LEASE_MS + 1000) })
    expect(p!.backlog).toMatchObject({ alert: null, pendingSince: null })
  }, 300_000)

  it("F38 checkpoint fence: an attempt whose job was dead-lettered meanwhile writes nothing at its checkpoint", async () => {
    const firmId = await newFirm()
    await seedPairs(firmId, many("entity_missing", RUN_PAIRS + 1), HEAD_AT, "h")
    clock.set(T)
    const period = periodOf(T)
    const run = runIdOf(firmId, period, 0)
    await enqueueAt(runSpec(firmId, period), T)
    const deps = testDeps(clock)
    let reclaim: string | undefined
    seam.beforeCheckpoint = async ({ attempt }) => {
      // Attempts 1 to 3 fail just before their checkpoint, so each is retried.
      if (attempt < 4) throw new Error("seam: the checkpoint's store call fails")
      // The fourth and last attempt stalls past its lease; a redelivery finds the lease expired at attempt 4 and dead-letters the job.
      clock.advance(JOB_LEASE_MS + 1000)
      reclaim = await runJobTask({ jobId: run, seq: (await readJob(run)).dispatchSeq }, deps)
    }
    expect(await runJobTask({ jobId: run, seq: 0 }, deps)).toBe("failed")
    const [r1, r2, r3] = RETRY_DELAYS_MS
    expect(await deps.dispatcher.drainDue(T + r1)).toEqual(["failed"])
    expect(await deps.dispatcher.drainDue(T + r1 + r2)).toEqual(["failed"])
    expect(await deps.dispatcher.drainDue(T + r1 + r2 + r3)).toEqual(["lease_lost"])
    expect(reclaim).toBe("dead_lettered")
    expect(await readJob(run)).toMatchObject({ status: "dead_lettered", attempts: 4 })
    expect((await jobs().doc(runIdOf(firmId, period, 1)).get()).exists).toBe(false)
    const p = await progress(firmId)
    expect(p!.lastRun).toBeUndefined()
    expect(p!.backlog).toBeUndefined()
  }, 300_000)

  it("F38 flag off mid-continuation: that step and the rest write nothing, no further continuation, and the next run resumes after the last committed step", async () => {
    const firmId = await newFirm()
    await seedPairs(firmId, many("entity_missing", RUN_PAIRS), HEAD_AT, "h")
    const tail = await seedPairs(firmId, many("eligible", 20), TAIL_AT, "t")
    seam.beforeStep = async ({ index, continuation }) => {
      if (continuation === 1 && index === 1) await db().collection("firms").doc(firmId).update({ "featureFlags.L17_2_ENABLED": false })
    }
    clock.set(T)
    const period = periodOf(T)
    await enqueueAt(runSpec(firmId, period), T)
    expect(await deliverChain(firmId, period, testDeps(clock))).toBe(2)
    expect((await confirmedOf(firmId, tail)).confirmed).toBe(10)
    expect((await jobs().doc(runIdOf(firmId, period, 2)).get()).exists).toBe(false)
    const p = await progress(firmId)
    // The cursor is the tenth eligible pair's row (the last row step 0 of the continuation handled).
    expect(p!.cursor).toEqual({ createdAt: Timestamp.fromMillis(TAIL_AT + 9), linkId: tail[9].scanLinkId })
    // The continuation checkpointed nothing: the progress still reports the first run.
    expect(p!.lastRun).toMatchObject({ jobId: runIdOf(firmId, period, 0) })
    for (const t of tail.slice(10)) expect((await rowsOf(t.linkIds))[0]).toMatchObject({ state: "candidate" })

    delete seam.beforeStep
    await db().collection("firms").doc(firmId).update({ "featureFlags.L17_2_ENABLED": true })
    expect(await runDay(firmId, T + DAY)).toBe(1)
    expect(await confirmedOf(firmId, tail)).toEqual({ confirmed: 20, maxPerPair: 1 })
  }, 300_000)

  it("F38 flag off at the checkpoint: nothing is checkpointed and no continuation is enqueued", async () => {
    const firmId = await newFirm()
    await seedPairs(firmId, many("entity_missing", RUN_PAIRS + 1), HEAD_AT, "h")
    seam.beforeCheckpoint = async () => {
      await db().collection("firms").doc(firmId).update({ "featureFlags.L17_2_ENABLED": false })
    }
    clock.set(T)
    const period = periodOf(T)
    await enqueueAt(runSpec(firmId, period), T)
    expect(await deliverChain(firmId, period, testDeps(clock))).toBe(1)
    expect((await readJob(runIdOf(firmId, period, 0))).status).toBe("done")
    expect((await jobs().doc(runIdOf(firmId, period, 1)).get()).exists).toBe(false)
    const p = await progress(firmId)
    // The steps checkpointed their cursor; the run's checkpoint wrote nothing.
    expect(p).toMatchObject({ firmId, kind: "autoconfirm" })
    expect(p!.lastRun).toBeUndefined()
    expect(p!.backlog).toBeUndefined()
  }, 300_000)

  it("F38 rechecks: a repaired pair is confirmed when its recheck falls due, a pair that left the backlog loses its record, a record not yet due is not re-read", async () => {
    const firmId = await newFirm()
    const [repaired, unmerged, stuck] = await seedPairs(firmId, ["entity_missing", "unmerge_in_progress", "entity_missing"], HEAD_AT, "h")
    const recheckSteps: StepInfo[] = []
    seam.beforeStep = async (s) => {
      if (s.phase === "recheck") recheckSteps.push({ ...s, pairIds: [...s.pairIds] })
    }
    expect(await runDay(firmId, T)).toBe(1)
    const first = new Map((await deferralsOf(firmId)).map((d) => [d.data().pairId as string, d.data()]))
    expect([...first.keys()].sort()).toEqual([repaired.pairId, unmerged.pairId, stuck.pairId].sort())
    for (const r of first.values()) expect((r.recheckAt as Timestamp).toMillis()).toBe(T + RECHECK_MS)
    expect(first.get(unmerged.pairId)).toMatchObject({ reason: "unmerge_in_progress", rowId: unmerged.linkIds[0], checks: 1 })

    // The repair: the missing entities are restored. The un-merge ends: the row is disputed (out of the scan).
    for (const id of [repaired.left, repaired.right]) await db().collection("entities").doc(id).set({ firmId, canonicalName: id, cnic: "4210112345671", classification: "internal" })
    await links().doc(unmerged.linkIds[0]).update({ disputed: true, "unmerge.status": "completed" })

    // Not due yet: no recheck step, the repaired pair waits.
    expect(await runDay(firmId, T + DAY)).toBe(1)
    expect(recheckSteps).toEqual([])
    expect((await confirmedOf(firmId, [repaired])).confirmed).toBe(0)

    // Due: one recheck step takes all three.
    expect(await runDay(firmId, T + RECHECK_MS + HOUR)).toBe(1)
    expect(recheckSteps.map((s) => [...s.pairIds].sort())).toEqual([[repaired.pairId, unmerged.pairId, stuck.pairId].sort()])
    expect((await confirmedOf(firmId, [repaired])).confirmed).toBe(1)
    const after = new Map((await deferralsOf(firmId)).map((d) => [d.data().pairId as string, d.data()]))
    expect([...after.keys()]).toEqual([stuck.pairId])
    expect(after.get(stuck.pairId)).toMatchObject({ reason: "entity_missing", checks: 2, since: Timestamp.fromMillis(T) })
    expect((after.get(stuck.pairId)!.recheckAt as Timestamp).toMillis()).toBe(T + RECHECK_MS + HOUR + RECHECK_MS)
  }, 300_000)

  it("F38 cross-firm: one firm's chain never touches another firm's rows, records or progress; the same pair id defers separately per firm", async () => {
    const a = await newFirm()
    const b = await newFirm()
    for (const firmId of [a, b]) {
      await seedPairs(firmId, many("entity_missing", RUN_PAIRS + 1), HEAD_AT, "h")
      // A pair id both firms share (its entities exist in neither firm).
      await links().doc(`${firmId}_ghost-l_ghost-r_cnic`).set({ firmId, leftId: "ghost-l", rightId: "ghost-r", key: "cnic", state: "candidate", disputed: false, createdAt: Timestamp.fromMillis(HEAD_AT - 1), classification: "internal" })
    }
    const tailA = await seedPairs(a, many("eligible", 5), TAIL_AT, "t")
    const tailB = await seedPairs(b, many("eligible", 5), TAIL_AT, "t")
    const bLinks = (await links().where("firmId", "==", b).get()).docs.map((d) => d.id)
    const bSeeded = await rowsOf(bLinks)

    clock.set(T)
    const period = periodOf(T)
    await enqueueAt(runSpec(a, period), T)
    expect(await deliverChain(a, period, testDeps(clock))).toBe(2)
    expect((await confirmedOf(a, tailA)).confirmed).toBe(5)
    expect(await deferralsOf(a)).toHaveLength(RUN_PAIRS + 2)
    // Firm B: untouched.
    expect(await rowsOf(bLinks)).toEqual(bSeeded)
    expect(await deferralsOf(b)).toHaveLength(0)
    expect(await progress(b)).toBeUndefined()
    expect((await jobs().where("firmId", "==", b).get()).size).toBe(0)

    await enqueueAt(runSpec(b, period), T)
    expect(await deliverChain(b, period, testDeps(clock))).toBe(2)
    expect((await confirmedOf(b, tailB)).confirmed).toBe(5)
    const ghostA = (await db().collection(DEFERRALS).doc(deferralIdOf(a, "ghost-l_ghost-r")).get()).data()
    const ghostB = (await db().collection(DEFERRALS).doc(deferralIdOf(b, "ghost-l_ghost-r")).get()).data()
    expect(ghostA).toMatchObject({ firmId: a, pairId: "ghost-l_ghost-r", reason: "entity_missing" })
    expect(ghostB).toMatchObject({ firmId: b, pairId: "ghost-l_ghost-r", reason: "entity_missing" })
    expect(deferralIdOf(a, "ghost-l_ghost-r")).not.toBe(deferralIdOf(b, "ghost-l_ghost-r"))
  }, 300_000)

  it("F38 a pair whose rows straddle the cursor is judged whole each time and confirmed once", async () => {
    const firmId = await newFirm()
    const [eligible, rejected] = await seedPairs(firmId, ["eligible", "rejected_row"], HEAD_AT, "p")
    await seedPairs(firmId, many("entity_missing", RUN_PAIRS + 120), HEAD_AT + 10, "h")
    // A second aged row of each pair, read after the cursor has passed their first rows.
    const ntnOf = (p: Seeded) => `${firmId}_${p.left}_${p.right}_ntn`
    for (const p of [eligible, rejected]) {
      await links().doc(ntnOf(p)).set({ firmId, leftId: p.left, rightId: p.right, key: "ntn", state: "candidate", disputed: false, createdAt: Timestamp.fromMillis(TAIL_AT), classification: "internal" })
    }
    const rejectedRows = [...rejected.linkIds, ntnOf(rejected)]
    const seeded = await rowsOf(rejectedRows)
    expect(await runDay(firmId, T)).toBe(2)
    expect(await confirmedOf(firmId, [eligible])).toEqual({ confirmed: 1, maxPerPair: 1 })
    const [event] = (await mergeEventsOf(firmId)).filter((e) => e.data().pairId === eligible.pairId)
    expect([...event.data().linkIds].sort()).toEqual([...eligible.linkIds, ntnOf(eligible)].sort())
    expect(await rowsOf(rejectedRows)).toEqual(seeded)
    expect((await db().collection(DEFERRALS).doc(deferralIdOf(firmId, rejected.pairId)).get()).data()).toMatchObject({ reason: "rejected_row", checks: 2 })
  }, 300_000)

  it("F38 rows that cannot name a pair are passed over and counted, and never starve the pairs behind them", async () => {
    const firmId = await newFirm()
    await seedPairs(firmId, many("no_pair", 2001), HEAD_AT, "x")
    const tail = await seedPairs(firmId, many("eligible", 5), TAIL_AT, "t")
    clock.set(T)
    const period = periodOf(T)
    await enqueueAt(runSpec(firmId, period), T)
    const deps = testDeps(clock)
    await onJobCreatedCore(runIdOf(firmId, period, 0), (await jobs().doc(runIdOf(firmId, period, 0)).get()).data(), deps)
    expect(await deps.dispatcher.drainDue(T)).toEqual(["done"])
    expect(await progress(firmId)).toMatchObject({ lastRun: { skippedRows: 2000, confirmed: 0, outcome: "continued" } })
    expect(await deliverChain(firmId, period, deps, 1)).toBe(1)
    expect(await progress(firmId)).toMatchObject({ lastRun: { skippedRows: 1, confirmed: 5, outcome: "drained" } })
    expect(await confirmedOf(firmId, tail)).toEqual({ confirmed: 5, maxPerPair: 1 })
    expect(await deferralsOf(firmId)).toHaveLength(0)
  }, 300_000)

  it("F38 two periods' chains of one firm at once: every pair confirmed once and both chains end", async () => {
    const firmId = await newFirm()
    const head = await seedPairs(firmId, many("entity_missing", RUN_PAIRS + 1), HEAD_AT, "h")
    const tail = await seedPairs(firmId, many("eligible", 30), TAIL_AT, "t")
    clock.set(T)
    const p1 = periodOf(T)
    const p2 = periodOf(T - DAY)
    await enqueueAt(runSpec(firmId, p1), T)
    await enqueueAt(runSpec(firmId, p2), T)
    const deps = testDeps(clock)
    let nested: number | undefined
    seam.beforeStep = async ({ index, continuation, attempt }) => {
      // While the p1 run is at step 5, the whole p2 chain runs (a backfill delivering two periods at once).
      if (nested === undefined && index === 5 && continuation === 0 && attempt === 1) {
        nested = -1
        nested = await deliverChain(firmId, p2, deps)
      }
    }
    expect(await deliverChain(firmId, p1, deps)).toBeGreaterThanOrEqual(1)
    expect(nested).toBeGreaterThanOrEqual(1)
    expect(await confirmedOf(firmId, tail)).toEqual({ confirmed: 30, maxPerPair: 1 })
    const ours = await jobs().where("firmId", "==", firmId).get()
    expect(ours.docs.map((d) => d.data().status).sort()).toEqual(ours.docs.map(() => "done"))
    expect(await deferralsOf(firmId)).toHaveLength(head.length)
  }, 600_000)
})
