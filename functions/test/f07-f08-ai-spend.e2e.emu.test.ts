import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { adminDb } from "../src/admin"
import { firmConfigRef, monthRef, platformConfigRef } from "../src/p1/config"
import { MAX_OUTPUT_TOKENS, costMicroUsd, estimateTokens } from "../src/p1/costTable"
import * as gateway from "../src/p1/gateway"
import { callP1, p1TestSeam, type P1Request, type P1Result } from "../src/p1/gateway"
import { setOpikFetchForTests } from "../src/p1/opik"
import { setP1TransportForTests, type P1Transport } from "../src/p1/transport"
import { viaApi } from "./api"
import { EMULATORS, mintIdToken, uniq } from "./emu"

/**
 * Audit findings F07 and F08 (both HIGH, 2026-10-13), end to end over the Firestore and Auth emulators: the real
 * `callP1` with a stub Gateway transport, and the real HTTP router for `committeeBrain`.
 *
 * F07 "AI budget is a stale pre-call check, not a spending limit". The audit admitted ten calls against a synthetic
 * 100 micro-USD budget; all returned ok and committed 140,000 micro-USD, and a single request could exceed the
 * remainder. The correction: reserve each call's worst-case cost (the estimated input plus the 4,096-token output
 * ceiling) atomically before dispatch, refuse unless spent + reserved + the new reservation fits the budget, bound the
 * firm's concurrent calls, settle the actual cost after the call, and release abandoned reservations by a lease
 * reconciler.
 *
 * F08 "Usage-commit failure leaves accepted AI spend unaccounted". The audit injected a usage-write failure: the call
 * returned ok, no usage row existed and later calls read understated spend. The correction: a durable reservation
 * and provider-attempt record before the provider is called, kept while accounting is unresolved; further spend
 * blocked once accounting is indeterminate; reconciliation by the scheduled reconciler; and an operation state that
 * tells result availability apart from accounting completion.
 *
 * Every number below is derived from the repo's own pricing (costTable.ts): the default stub reply costs 14,000
 * micro-USD (1,000 tokens in, 500 out) and the worst case of the body "Draft a reply to the notice." is its estimated
 * input plus 4,096 output tokens.
 */

const T = Date.parse("2026-10-11T10:00:00.000Z") // PKT month 2026-10
const MONTH = "2026-10"
const OPUS = "anthropic/claude-opus-5.5"
const BODY = "Draft a reply to the notice."
const BIG_BUDGET = 1_000_000_000
/** The worst case the gateway must reserve for BODY: estimated input plus the 4,096-token output ceiling. */
const WORST = costMicroUsd(OPUS, estimateTokens(BODY), MAX_OUTPUT_TOKENS)!
/** What the default stub reply costs: 1,000 tokens in, 500 out. */
const REPLY_COST = costMicroUsd(OPUS, 1000, 500)!
/** One second past the reservation lease of a call made at T (read lazily: the constant is part of the fix). */
const afterLease = () => T + (gateway as unknown as { RESERVATION_LEASE_MS: number }).RESERVATION_LEASE_MS + 1_000

type Sent = { model: string; body: string; maxTokens: number }
type Reply = { text: string; inputTokens: number | null; outputTokens: number | null }
const DEFAULT_REPLY: Reply = { text: "REPLY", inputTokens: 1000, outputTokens: 500 }

/** A stub Gateway that answers at once. */
function stubTransport(reply: Reply = DEFAULT_REPLY): Sent[] {
  const sent: Sent[] = []
  const t: P1Transport = {
    async send(r) {
      sent.push({ ...r })
      return { ...reply }
    },
  }
  setP1TransportForTests(t)
  return sent
}

/** A stub Gateway that holds every call until `release()`: the calls it admitted stay in flight together. */
function heldTransport(reply: Reply = DEFAULT_REPLY): { sent: Sent[]; release: () => void } {
  const sent: Sent[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  setP1TransportForTests({
    async send(r) {
      sent.push({ ...r })
      await gate
      return { ...reply }
    },
  })
  return { sent, release }
}

async function waitFor(what: string, ok: () => boolean, ms = 30_000): Promise<void> {
  const until = Date.now() + ms
  while (!ok()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Starts every call at once and records which have settled. */
function concurrently<R>(n: number, call: (i: number) => Promise<R>): { all: Promise<PromiseSettledResult<R>[]>; done: R[] } {
  const done: R[] = []
  const calls = Array.from({ length: n }, (_, i) =>
    call(i).then((r) => {
      done.push(r)
      return r
    })
  )
  return { all: Promise.allSettled(calls), done }
}

const db = () => adminDb()
const req = (firmId: string, extra: Partial<P1Request> = {}): P1Request => ({
  firmId,
  actorId: "uid-1",
  matterId: "matter-1",
  jobId: null,
  taskType: "committee",
  classification: "internal",
  body: BODY,
  purpose: "committee-brain",
  ...extra,
})
const at = (ms: number) => ({ now: () => ms })

async function seedFirm(cfg: Record<string, unknown>, spentMicroUsd?: number): Promise<string> {
  const firmId = uniq("firm")
  await firmConfigRef(firmId).set(cfg)
  if (spentMicroUsd !== undefined) await monthRef(firmId, MONTH).set({ firmId, monthKey: MONTH, spentMicroUsd })
  return firmId
}

const byFirm = async (collection: string, firmId: string): Promise<Array<{ id: string; data: DocumentData }>> =>
  (await db().collection(collection).where("firmId", "==", firmId).get()).docs.map((d) => ({ id: d.id, data: d.data() }))
const monthOf = async (firmId: string) => (await monthRef(firmId, MONTH).get()).data()
const usageRowOf = async (id: string) => (await db().collection("ai_usage_logs").doc(id).get()).data()
const reservationOf = async (id: string) => (await db().collection("ai_reservations").doc(id).get()).data()
const spentOf = (m: DocumentData | undefined) => (typeof m?.spentMicroUsd === "number" ? m.spentMicroUsd : 0)
const reservedOf = (m: DocumentData | undefined) => (typeof m?.reservedMicroUsd === "number" ? m.reservedMicroUsd : 0)

/**
 * One run of the reconciler core at `nowMs`, reported for `firmId`'s reservations only: the emulator is shared, and
 * other suites leave lapsed reservations of their own firms (their usage commits fail on purpose) for any run to
 * settle. Imported when used, so the F07 cases still run (and fail on behaviour) where the module does not exist.
 */
async function reconcileFor(firmId: string, nowMs: number): Promise<{ settled: string[]; released: string[] }> {
  // A computed specifier: resolved when called, so this file loads where the module does not exist yet.
  const specifier = ["..", "src", "p1", "reconciler"].join("/")
  const mod = (await import(specifier)) as { reconcileReservations: (o: { now: () => number }) => Promise<{ settled: string[]; released: string[] }> }
  const run = await mod.reconcileReservations({ now: () => nowMs })
  const mine = new Set((await byFirm("ai_reservations", firmId)).map((r) => r.id))
  return { settled: run.settled.filter((id) => mine.has(id)), released: run.released.filter((id) => mine.has(id)) }
}

function resetSeam() {
  for (const k of Object.keys(p1TestSeam)) delete (p1TestSeam as Record<string, unknown>)[k]
}

function seam(): Record<string, unknown> {
  return p1TestSeam as unknown as Record<string, unknown>
}

describe.skipIf(!EMULATORS)("audit F07 and F08: AI spend is reserved before dispatch and accounted after it (e2e)", () => {
  beforeEach(() => {
    vi.stubEnv("OPIK_BASE_URL", undefined)
    vi.stubEnv("OPIK_SELF_HOSTED_CONFIRMED", undefined)
    vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
    setProviderConfigForTests(null)
    resetSeam()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    setP1TransportForTests(null)
    setOpikFetchForTests(null)
    setProviderConfigForTests(null)
    resetSeam()
    await platformConfigRef().delete()
  })

  describe("F07 through callP1", () => {
    it("the audit scenario: ten concurrent calls against a 100 micro-USD budget dispatch nothing and commit no spend", { timeout: 60_000 }, async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: 100 })
      const sent = stubTransport()
      const results = await Promise.all(Array.from({ length: 10 }, () => callP1(req(firmId), at(T))))

      // Main: all ten ok and 140,000 micro-USD committed. Here: no call's worst case fits a 100 micro-USD budget.
      const month = await monthOf(firmId)
      expect(spentOf(month)).toBe(0)
      expect(results.map((r) => r.outcome)).toEqual(Array(10).fill("blocked"))
      expect(results.map((r) => r.blockReason)).toEqual(Array(10).fill("budget_exhausted"))
      expect(sent).toHaveLength(0)
      expect(reservedOf(month)).toBe(0)
      expect(month?.calls).toEqual({ ok: 0, failed: 0, blocked: 10 })
      expect(await byFirm("ai_reservations", firmId)).toHaveLength(0)
      expect((await byFirm("ai_usage_logs", firmId)).map((r) => r.data.outcome)).toEqual(Array(10).fill("blocked"))
    })

    it("of ten concurrent calls only those whose worst case fits are dispatched, and spent plus reserved never exceeds the budget", { timeout: 60_000 }, async () => {
      // Room for three worst cases and half of a fourth; concurrency is not the limit here.
      const budget = 3 * WORST + Math.floor(WORST / 2)
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: budget, maxConcurrentCalls: 10 })
      const { sent, release } = heldTransport()
      const run = concurrently(10, () => callP1(req(firmId), at(T)))
      try {
        await waitFor("every call to be dispatched or refused", () => run.done.length + sent.length >= 10)
        // Main dispatches all ten.
        expect(sent).toHaveLength(3)
        expect(run.done.map((r) => [r.outcome, r.blockReason])).toEqual(Array(7).fill(["blocked", "budget_exhausted"]))
        // While the three are in flight their worst cases are held, and the books never exceed the budget.
        const held = await monthOf(firmId)
        expect(reservedOf(held)).toBe(3 * WORST)
        expect(spentOf(held) + reservedOf(held)).toBeLessThanOrEqual(budget)
        const live = await byFirm("ai_reservations", firmId)
        expect(live.map((r) => [r.data.state, r.data.reservedMicroUsd, r.data.providerAttempt?.outcome])).toEqual(Array(3).fill(["reserved", WORST, "pending"]))
      } finally {
        release()
      }
      const settled = (await run.all).map((s) => (s.status === "fulfilled" ? s.value : null))
      const ok = settled.filter((r): r is P1Result => r?.outcome === "ok")
      expect(ok).toHaveLength(3)
      expect(ok.map((r) => (r as P1Result & { accounting?: string }).accounting)).toEqual(["settled", "settled", "settled"])
      const month = await monthOf(firmId)
      expect(spentOf(month)).toBe(3 * REPLY_COST)
      expect(reservedOf(month)).toBe(0)
      expect(spentOf(month) + reservedOf(month)).toBeLessThanOrEqual(budget)
      const reservations = await byFirm("ai_reservations", firmId)
      expect(reservations.map((r) => [r.data.state, r.data.actualMicroUsd]).sort()).toEqual(Array(3).fill(["settled", REPLY_COST]))
      expect(reservations.map((r) => r.id).sort()).toEqual(ok.map((r) => r.usageLogId).sort())
    })

    it("calls on separate instances (no shared ledger queue) still never over-admit: the transaction alone keeps spent plus reserved within the budget", { timeout: 90_000 }, async () => {
      // Each call's reservation and commit transactions contend directly, as calls on different instances do. Under
      // the emulator's lock timeouts some reservations run out of time; those calls are refused, never admitted.
      const budget = 3 * WORST + Math.floor(WORST / 2)
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: budget, maxConcurrentCalls: 10 })
      seam().unqueued = "all"
      const { sent, release } = heldTransport()
      const run = concurrently(10, () => callP1(req(firmId), at(T)))
      try {
        await waitFor("every call to be dispatched or refused", () => run.done.length + sent.length >= 10, 80_000)
        expect(sent.length).toBeGreaterThanOrEqual(1)
        expect(sent.length).toBeLessThanOrEqual(3)
        for (const r of run.done) {
          expect(r.outcome).toBe("blocked")
          expect(["budget_exhausted", "concurrency_exhausted", "reservation_failed"]).toContain(r.blockReason)
        }
        const held = await monthOf(firmId)
        expect(reservedOf(held)).toBe(sent.length * WORST)
        expect(spentOf(held) + reservedOf(held)).toBeLessThanOrEqual(budget)
      } finally {
        release()
      }
      const ok = (await run.all).flatMap((s) => (s.status === "fulfilled" && s.value.outcome === "ok" ? [s.value] : []))
      expect(ok).toHaveLength(sent.length)
      const month = await monthOf(firmId)
      expect(spentOf(month)).toBe(sent.length * REPLY_COST)
      expect(reservedOf(month)).toBe(0)
    })

    it("a single request whose worst case exceeds the remaining budget is refused before dispatch; one that fits exactly is sent", async () => {
      const sent = stubTransport()
      // Remaining budget one micro-USD short of the worst case: main sends it, because spent is still below the budget.
      const short = await seedFirm({ monthlyBudgetMicroUsd: 100_000 }, 100_000 - WORST + 1)
      const refused = await callP1(req(short), at(T))
      expect([refused.outcome, refused.blockReason]).toEqual(["blocked", "budget_exhausted"])
      expect(sent).toHaveLength(0)
      expect(spentOf(await monthOf(short))).toBe(100_000 - WORST + 1)

      // Remaining budget exactly the worst case: spent + reserved + new reservation == budget is allowed.
      const exact = await seedFirm({ monthlyBudgetMicroUsd: 100_000 }, 100_000 - WORST)
      const allowed = await callP1(req(exact), at(T))
      expect(allowed.outcome).toBe("ok")
      expect(sent).toHaveLength(1)
    })

    it("a firm's concurrent calls are bounded: the fifth live reservation is refused concurrency_exhausted by default, and a freed slot admits again", { timeout: 60_000 }, async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      const { sent, release } = heldTransport()
      const run = concurrently(10, () => callP1(req(firmId), at(T)))
      try {
        await waitFor("every call to be dispatched or refused", () => run.done.length + sent.length >= 10)
        // Main dispatches all ten.
        expect(sent).toHaveLength(4)
        expect(run.done.map((r) => [r.outcome, r.blockReason])).toEqual(Array(6).fill(["blocked", "concurrency_exhausted"]))
        expect(reservedOf(await monthOf(firmId))).toBe(4 * WORST)
      } finally {
        release()
      }
      await run.all
      const next = await callP1(req(firmId), at(T))
      expect(next.outcome).toBe("ok")
      expect(sent).toHaveLength(5)
    })

    it("the firm's configured maxConcurrentCalls replaces the default, and an invalid value falls back to it", { timeout: 60_000 }, async () => {
      const two = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET, maxConcurrentCalls: 2 })
      const held = heldTransport()
      const run = concurrently(5, () => callP1(req(two), at(T)))
      try {
        await waitFor("every call to be dispatched or refused", () => run.done.length + held.sent.length >= 5)
        expect(held.sent).toHaveLength(2)
        expect(run.done.map((r) => r.blockReason)).toEqual(Array(3).fill("concurrency_exhausted"))
      } finally {
        held.release()
      }
      await run.all

      const invalid = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET, maxConcurrentCalls: "8" })
      const again = heldTransport()
      const run2 = concurrently(6, () => callP1(req(invalid), at(T)))
      try {
        await waitFor("every call to be dispatched or refused", () => run2.done.length + again.sent.length >= 6)
        expect(again.sent).toHaveLength(4)
      } finally {
        again.release()
      }
      await run2.all
    })

    it("a reservation that cannot be written or an attempt that cannot be recorded sends nothing: blocked reservation_failed, and the held amount is released", async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      const sent = stubTransport()
      // A non-retryable failure of the reservation transaction (gRPC PERMISSION_DENIED): nothing is reserved or sent.
      seam().reserveAttemptFailures = [Object.assign(new Error("denied"), { code: 7 })]
      const noReservation = await callP1(req(firmId), at(T))
      expect([noReservation.outcome, noReservation.blockReason]).toEqual(["blocked", "reservation_failed"])
      expect(sent).toHaveLength(0)
      expect(await reservationOf(noReservation.usageLogId)).toBeUndefined()

      // The reservation lands but the provider attempt cannot be recorded: nothing is sent and the reservation is released.
      seam().attemptMarkFailures = [Object.assign(new Error("unavailable"), { code: 14 })]
      const noMark = await callP1(req(firmId), at(T))
      expect([noMark.outcome, noMark.blockReason]).toEqual(["blocked", "reservation_failed"])
      expect(sent).toHaveLength(0)
      expect(await reservationOf(noMark.usageLogId)).toMatchObject({ state: "released", reservedMicroUsd: WORST, actualMicroUsd: 0 })
      expect(reservedOf(await monthOf(firmId))).toBe(0)
      expect((await usageRowOf(noMark.usageLogId))?.outcome).toBe("blocked")
    })

    it("the lease reconciler releases an abandoned reservation that never reached the provider, and spending resumes", { timeout: 60_000 }, async () => {
      // Budget for one worst case and a half: an abandoned reservation's hold blocks the next call until released.
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: WORST + Math.floor(WORST / 2) })
      const sent = stubTransport()
      // The instance dies after the reservation commits and before the provider attempt is recorded.
      seam().crashAt = "reserved"
      await expect(callP1(req(firmId), at(T))).rejects.toThrow("p1TestSeam.crashAt")
      delete seam().crashAt
      expect(sent).toHaveLength(0)
      const [abandoned] = await byFirm("ai_reservations", firmId)
      expect(abandoned?.data).toMatchObject({ state: "reserved", reservedMicroUsd: WORST })
      expect(abandoned?.data.providerAttempt).toBeUndefined()

      // Held: the next call does not fit, inside or past the lease, until the reconciler releases it.
      expect((await callP1(req(firmId), at(T))).blockReason).toBe("budget_exhausted")
      expect((await callP1(req(firmId), at(afterLease()))).blockReason).toBe("budget_exhausted")
      expect(sent).toHaveLength(0)

      // Before its lease ends the reconciler leaves it alone.
      expect(await reconcileFor(firmId, T + 1_000)).toEqual({ settled: [], released: [] })
      expect(await reconcileFor(firmId, afterLease())).toEqual({ settled: [], released: [abandoned!.id] })
      expect(await reservationOf(abandoned!.id)).toMatchObject({ state: "released", actualMicroUsd: 0 })
      const month = await monthOf(firmId)
      expect(reservedOf(month)).toBe(0)
      expect(spentOf(month)).toBe(0)
      expect(await usageRowOf(abandoned!.id)).toBeUndefined()

      const resumed = await callP1(req(firmId), at(afterLease()))
      expect(resumed.outcome).toBe("ok")
      expect(sent).toHaveLength(1)
    })
  })

  describe("F08 through callP1", () => {
    it("the audit scenario: a usage-commit failure keeps a durable reservation with its provider attempt, says accounting pending, blocks the firm once the lease lapses, and the reconciler settles it", { timeout: 60_000 }, async () => {
      const budget = WORST + Math.floor(WORST / 2)
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: budget })
      const sent = stubTransport()
      p1TestSeam.failCommit = true
      const r = (await callP1(req(firmId), at(T))) as P1Result & { accounting?: string }

      // The result is available; its accounting is not complete (main: outcome ok and nothing else to tell them apart).
      expect(r).toMatchObject({ outcome: "ok", text: "REPLY", costMicroUsd: REPLY_COST })
      expect(r.accounting).toBe("pending")
      expect(await usageRowOf(r.usageLogId)).toBeUndefined()
      // The provider attempt is durable and still holds the worst case against the budget.
      const reservation = await reservationOf(r.usageLogId)
      expect(reservation).toMatchObject({ firmId, state: "reserved", reservedMicroUsd: WORST, model: OPUS, classification: "internal", taskType: "committee" })
      expect(reservation?.providerAttempt).toMatchObject({ outcome: "returned", costMicroUsd: REPLY_COST })
      expect(reservation?.providerAttempt.attemptedAt).toBeInstanceOf(Timestamp)
      expect(reservation?.leaseUntil).toBeInstanceOf(Timestamp)
      const held = await monthOf(firmId)
      expect([spentOf(held), reservedOf(held)]).toEqual([0, WORST])

      // Inside the lease the budget counts the unsettled attempt: main read 0 spent and sent this one.
      p1TestSeam.failCommit = false
      const counted = await callP1(req(firmId), at(T))
      expect([counted.outcome, counted.blockReason]).toEqual(["blocked", "budget_exhausted"])
      // Past the lease, accounting is indeterminate: the firm is blocked, even once the partner raises the budget.
      await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: BIG_BUDGET }, { merge: true })
      const blocked = await callP1(req(firmId), at(afterLease()))
      expect([blocked.outcome, blocked.blockReason]).toEqual(["blocked", "accounting_indeterminate"])
      expect(sent).toHaveLength(1)

      // The reconciler settles it at the charge the attempt recorded, writes the missing usage row, audit row and event.
      expect(await reconcileFor(firmId, afterLease())).toEqual({ settled: [r.usageLogId], released: [] })
      expect(await usageRowOf(r.usageLogId)).toMatchObject({ firmId, outcome: "reconciled", costMicroUsd: REPLY_COST, inputTokens: 1000, outputTokens: 500, tokensEstimated: false, monthKey: MONTH })
      expect(await reservationOf(r.usageLogId)).toMatchObject({ state: "settled", actualMicroUsd: REPLY_COST })
      const month = await monthOf(firmId)
      expect([spentOf(month), reservedOf(month)]).toEqual([REPLY_COST, 0])
      expect(month?.calls).toMatchObject({ reconciled: 1 })
      expect((await byFirm("events", firmId)).filter((e) => e.data.name === "ai.call.reconciled").map((e) => e.id)).toEqual([`${r.usageLogId}_reconciled`])
      expect((await byFirm("audit_log", firmId)).filter((a) => a.data.action === "ai.gateway.reconciled").map((a) => a.data.target)).toEqual([`ai_usage_logs/${r.usageLogId}`])

      // Calls resume, and their accounting completes.
      const resumed = (await callP1(req(firmId), at(afterLease()))) as P1Result & { accounting?: string }
      expect([resumed.outcome, resumed.accounting]).toEqual(["ok", "settled"])
      expect(sent).toHaveLength(2)
    })

    it("an attempt whose outcome was never recorded is reconciled at the reserved worst case", { timeout: 60_000 }, async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      const sent = stubTransport()
      // The provider was called and the instance died before anything after the call was written.
      seam().crashAt = "dispatched"
      await expect(callP1(req(firmId), at(T))).rejects.toThrow("p1TestSeam.crashAt")
      delete seam().crashAt
      expect(sent).toHaveLength(1)
      const [attempt] = await byFirm("ai_reservations", firmId)
      expect(attempt?.data).toMatchObject({ state: "reserved", reservedMicroUsd: WORST, providerAttempt: { outcome: "pending" } })

      expect((await callP1(req(firmId), at(afterLease()))).blockReason).toBe("accounting_indeterminate")
      expect(await reconcileFor(firmId, afterLease())).toEqual({ settled: [attempt!.id], released: [] })
      expect(await usageRowOf(attempt!.id)).toMatchObject({
        outcome: "reconciled",
        costMicroUsd: WORST,
        inputTokens: estimateTokens(BODY),
        outputTokens: MAX_OUTPUT_TOKENS,
        tokensEstimated: true,
      })
      expect([spentOf(await monthOf(firmId)), reservedOf(await monthOf(firmId))]).toEqual([WORST, 0])
      expect((await callP1(req(firmId), at(afterLease()))).outcome).toBe("ok")
    })

    it("a reconciler that settles a call still in flight is never double-counted by that call's own commit", { timeout: 60_000 }, async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      const { sent, release } = heldTransport()
      const call = callP1(req(firmId), at(T)) as Promise<P1Result & { accounting?: string }>
      let reconciled: { settled: string[]; released: string[] } | undefined
      try {
        await waitFor("the call to reach the provider", () => sent.length === 1)
        reconciled = await reconcileFor(firmId, afterLease())
      } finally {
        release()
      }
      const r = await call
      expect(reconciled).toEqual({ settled: [r.usageLogId], released: [] })
      expect([r.outcome, r.accounting]).toEqual(["ok", "settled"])
      expect((await byFirm("ai_usage_logs", firmId)).map((u) => [u.id, u.data.outcome])).toEqual([[r.usageLogId, "reconciled"]])
      expect([spentOf(await monthOf(firmId)), reservedOf(await monthOf(firmId))]).toEqual([WORST, 0])
    })
  })

  describe("F07 and F08 through the HTTP router (committeeBrain)", () => {
    type Out = { outputId: string; blocked: boolean; reason?: string; text?: string; accounting?: string; usage: { costMicroUsd: number } }
    type Member = { uid: string; token: string }

    async function newFirm(cfg: Record<string, unknown>): Promise<{ firmId: string; matterId: string; members: Member[] }> {
      const firmId = uniq("firm")
      await db().collection("firms").doc(firmId).set({ name: "F", plan: "internal" })
      await firmConfigRef(firmId).set(cfg)
      const matterId = uniq("matter")
      await db().collection("matters").doc(matterId).set({ firmId, classification: "internal", title: "Recovery suit", stage: "pre_filing", status: "open", createdAt: Timestamp.now() })
      const members: Member[] = []
      for (const role of ["partner", "associate", "clerk"]) {
        const m = await mintIdToken({ firmId, role, clearanceLevel: "privileged-restricted" })
        await db().collection("matter_members").doc(`${matterId}_${m.uid}`).set({ firmId, matterId, userId: m.uid, classification: "internal" })
        members.push(m)
      }
      return { firmId, matterId, members }
    }

    it("ten concurrent committeeBrain requests against a budget for two worst cases dispatch two and refuse the rest; spent plus reserved never exceeds it", { timeout: 90_000 }, async () => {
      const budget = 2 * WORST + 1_000
      const f = await newFirm({ monthlyBudgetMicroUsd: budget })
      const brain = viaApi<Out>("committeeBrain", { now: () => T })
      const { sent, release } = heldTransport()
      // Three members share the ten requests: the per-user limit of ten a minute is not what refuses them.
      const run = concurrently(10, (i) => brain({ token: f.members[i % 3]!.token, data: { firmId: f.firmId, matterId: f.matterId, body: BODY } } as never))
      try {
        await waitFor("every request to be dispatched or refused", () => run.done.length + sent.length >= 10, 60_000)
        // Main dispatches all ten.
        expect(sent).toHaveLength(2)
        expect(run.done.map((o) => [o.blocked, o.reason, o.accounting])).toEqual(Array(8).fill([true, "budget_exhausted", "settled"]))
        const held = await monthOf(f.firmId)
        expect(reservedOf(held)).toBe(2 * WORST)
        expect(spentOf(held) + reservedOf(held)).toBeLessThanOrEqual(budget)
      } finally {
        release()
      }
      const answers = (await run.all).map((s) => (s.status === "fulfilled" ? s.value : null))
      const ok = answers.filter((o): o is Out => o?.blocked === false)
      expect(ok.map((o) => [o.text, o.accounting])).toEqual([
        ["REPLY", "settled"],
        ["REPLY", "settled"],
      ])
      const month = await monthOf(f.firmId)
      expect([spentOf(month), reservedOf(month)]).toEqual([2 * REPLY_COST, 0])
      const outputs = await byFirm("committee_outputs", f.firmId)
      expect(outputs).toHaveLength(10)
      expect(outputs.map((o) => o.data.accounting)).toEqual(Array(10).fill("settled"))
    })

    it("a usage-commit failure answers with the text and accounting pending, stores accounting pending, blocks the firm accounting_indeterminate past the lease, and the reconciler restores service", { timeout: 90_000 }, async () => {
      const f = await newFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      let clock = T
      const brain = viaApi<Out>("committeeBrain", { now: () => clock })
      const ask = () => brain({ token: f.members[0]!.token, data: { firmId: f.firmId, matterId: f.matterId, body: BODY } } as never)
      const sent = stubTransport()
      p1TestSeam.failCommit = true
      const first = await ask()
      // Main answers ok with no accounting state: the caller cannot tell the books are incomplete.
      expect([first.blocked, first.text, first.accounting]).toEqual([false, "REPLY", "pending"])
      const [row] = await byFirm("committee_outputs", f.firmId)
      expect(row?.data).toMatchObject({ blocked: false, accounting: "pending" })
      const usageLogId = row!.data.usageLogId as string
      expect(await usageRowOf(usageLogId)).toBeUndefined()
      expect(await reservationOf(usageLogId)).toMatchObject({ state: "reserved", reservedMicroUsd: WORST })

      p1TestSeam.failCommit = false
      clock = afterLease()
      const refused = await ask()
      expect([refused.blocked, refused.reason]).toEqual([true, "accounting_indeterminate"])
      expect(sent).toHaveLength(1)

      expect(await reconcileFor(f.firmId, clock)).toEqual({ settled: [usageLogId], released: [] })
      expect(await usageRowOf(usageLogId)).toMatchObject({ outcome: "reconciled", costMicroUsd: REPLY_COST })
      const resumed = await ask()
      expect([resumed.blocked, resumed.text, resumed.accounting]).toEqual([false, "REPLY", "settled"])
      expect(sent).toHaveLength(2)
      expect(spentOf(await monthOf(f.firmId))).toBe(2 * REPLY_COST)
    })
  })
})
