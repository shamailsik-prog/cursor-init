import { randomUUID } from "node:crypto"
import { FieldValue, Timestamp, type DocumentData } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { SYSTEM_POLICIES } from "@/platform/p1/systemPolicy"
import { adminDb } from "../src/admin"
import { firmConfigRef, monthRef, platformConfigRef } from "../src/p1/config"
import * as costTable from "../src/p1/costTable"
import { MAX_OUTPUT_TOKENS, MESSAGE_OVERHEAD_TOKENS, costMicroUsd } from "../src/p1/costTable"
import * as gateway from "../src/p1/gateway"
import { callP1, ledgerQueue, p1TestSeam, type P1Request, type P1Result } from "../src/p1/gateway"
import { setOpikFetchForTests } from "../src/p1/opik"
import { p1OpsTestSeam } from "../src/p1/ops"
import { P1TransportError, setP1TransportForTests, type P1Transport } from "../src/p1/transport"
import { ApiError, viaApi } from "./api"
import { recordSent, type Sent } from "./sent"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { spyRegisteredErrors } from "./registeredErrorLog"

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
 * micro-USD (1,000 tokens in, 500 out) and the worst case of the body "Draft a reply to the notice." is its input
 * ceiling (one token per UTF-8 byte plus the per-request overhead: re-audit R1-D1) plus 4,096 output tokens.
 */

const T = Date.parse("2026-10-11T10:00:00.000Z") // PKT month 2026-10
const MONTH = "2026-10"
const OPUS = "anthropic/claude-opus-5.5"
const BODY = "Draft a reply to the notice."
const BIG_BUDGET = 1_000_000_000
/**
 * The per-request input overhead the gateway reserves (REQUEST_OVERHEAD_TOKENS). Read from the module, with its value
 * as the fallback, so this file also runs against the code before re-audit R1-D1 (where it does not exist).
 */
const OVERHEAD = (costTable as unknown as { REQUEST_OVERHEAD_TOKENS?: number }).REQUEST_OVERHEAD_TOKENS ?? 64
/**
 * Audit F16: every request is role-separated, the registry's system message for the purpose ("committee-brain" here)
 * and then the body as the user's turn, and the reservation holds the content ceiling of both: each message's bytes
 * (one token per UTF-8 byte of its largest normal form) plus MESSAGE_OVERHEAD_TOKENS. `contentOf(n)` is that ceiling for
 * a body whose own ceiling is `n`; the committee policy text is ASCII, so its ceiling is its byte length.
 */
const SYSTEM_BYTES = Buffer.byteLength(SYSTEM_POLICIES["committee-brain"].text, "utf8")
const contentOf = (bodyCeiling: number) => SYSTEM_BYTES + bodyCeiling + 2 * MESSAGE_OVERHEAD_TOKENS
/** The input ceiling of a body: its request's content ceiling (a byte-level BPE token covers at least one byte) plus overhead. */
const inputCeiling = (body: string) => contentOf(Buffer.byteLength(body, "utf8")) + OVERHEAD
/** The worst case the gateway must reserve for BODY: its input ceiling plus the 4,096-token output ceiling. */
const WORST = costMicroUsd(OPUS, inputCeiling(BODY), MAX_OUTPUT_TOKENS)!
/** What the default stub reply costs: 1,000 tokens in, 500 out. */
const REPLY_COST = costMicroUsd(OPUS, 1000, 500)!
/** One second past the reservation lease of a call made at T (read lazily: the constant is part of the fix). */
const afterLease = () => T + (gateway as unknown as { RESERVATION_LEASE_MS: number }).RESERVATION_LEASE_MS + 1_000

// Audit F16: the transport receives role-separated messages; `recordSent` keeps them and the user turn as `body`.
type Reply = { text: string; inputTokens: number | null; outputTokens: number | null; responseId?: string; requestId?: string }
const DEFAULT_REPLY: Reply = { text: "REPLY", inputTokens: 1000, outputTokens: 500 }

/** A stub Gateway that answers at once. */
function stubTransport(reply: Reply = DEFAULT_REPLY): Sent[] {
  const sent: Sent[] = []
  const t: P1Transport = {
    async send(r) {
      sent.push(recordSent(r))
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
      sent.push(recordSent(r))
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

/**
 * callP1 as a client calls it (re-audit R3-D3): a call refused reservation_failed, whose reservation or attempt record
 * ran out of time under contention, is retried up to five attempts in all, after a jittered back-off of 200 ms doubling;
 * any other answer is final.
 */
async function callP1Retrying(request: P1Request, opts: { now: () => number }): Promise<P1Result> {
  for (let attempt = 1; ; attempt++) {
    const r = await callP1(request, opts)
    if (r.blockReason !== "reservation_failed" || attempt >= 5) return r
    await new Promise((resolve) => setTimeout(resolve, Math.round(200 * 2 ** (attempt - 1) * (0.5 + Math.random()))))
  }
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
  for (const k of Object.keys(p1OpsTestSeam)) delete (p1OpsTestSeam as Record<string, unknown>)[k]
}

/**
 * A reservation as a call that died after dispatching leaves it: held, lease lapsed at T, a pending provider attempt,
 * and its hold on the month total. `over` replaces fields; an `undefined` value removes one (a malformed record).
 */
async function seedLapsedAttempt(firmId: string, over: Record<string, unknown> = {}, id?: string): Promise<string> {
  const ref = id === undefined ? db().collection("ai_reservations").doc() : db().collection("ai_reservations").doc(id)
  const doc: Record<string, unknown> = {
    firmId,
    actorId: "uid-1",
    matterId: "matter-1",
    jobId: null,
    taskType: "committee",
    model: OPUS,
    classification: "internal",
    provider: "ai-gateway",
    traceId: `trace-${ref.id}`,
    usageLogId: ref.id,
    monthKey: MONTH,
    reservedInputTokens: inputCeiling(BODY),
    reservedOutputTokens: MAX_OUTPUT_TOKENS,
    reservedMicroUsd: WORST,
    state: "reserved",
    leaseUntil: Timestamp.fromMillis(T),
    createdAt: Timestamp.fromMillis(T),
    providerAttempt: { attemptedAt: Timestamp.fromMillis(T), outcome: "pending" },
    ...over,
  }
  for (const [k, v] of Object.entries(doc)) if (v === undefined) delete doc[k]
  await ref.set(doc)
  if (typeof doc.reservedMicroUsd === "number") {
    await monthRef(firmId, MONTH).set({ firmId, monthKey: MONTH, reservedMicroUsd: FieldValue.increment(doc.reservedMicroUsd) }, { merge: true })
  }
  return ref.id
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
    await db().collection("platform").doc("p1Overhead").delete()
    await db().collection("platform").doc("p1ReconcileCursor").delete()
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

    it("ten calls on separate instances, all past the first look and then reserving one at a time, admit exactly the three that fit: the reservation transaction alone keeps spent plus reserved within the budget (re-audit R4-D1)", { timeout: 120_000 }, async () => {
      // Ten calls of one firm, each as on its own instance (no ledger queue). Each does its first reads and passes the
      // first look (nothing is spent or held yet, so all ten would fit by it), then waits at a barrier just before its
      // reservation transaction (p1TestSeam.beforeReserve). Once all ten wait there, their reservations run one at a
      // time, each after the last has been admitted or refused. Nothing contends and nothing is retried, so the only
      // thing that can refuse the fourth and later calls is the transaction's own re-read of what the earlier ones hold.
      // With that check removed (the auditor's mutant, `> budget * 100`), all ten are admitted and this test fails.
      const budget = 3 * WORST + Math.floor(WORST / 2)
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: budget, maxConcurrentCalls: 10 })
      seam().unqueued = "all"
      const { sent, release } = heldTransport()
      const waiting: Array<() => void> = []
      seam().beforeReserve = () => new Promise<void>((resolve) => waiting.push(resolve))
      const run = concurrently(10, () => callP1(req(firmId), at(T)))
      try {
        await waitFor("all ten calls to reach the reservation barrier", () => waiting.length >= 10, 60_000)
        // All ten passed the first look on the same figures: none was refused, none was sent, nothing is held.
        expect([run.done.length, sent.length, reservedOf(await monthOf(firmId))]).toEqual([0, 0, 0])
        for (let i = 0; i < 10; i++) {
          waiting[i]!()
          await waitFor(`reservation ${i + 1} to be admitted or refused`, () => run.done.length + sent.length >= i + 1, 30_000)
        }
        expect(sent).toHaveLength(3)
        expect(run.done.map((r) => [r.outcome, r.blockReason])).toEqual(Array(7).fill(["blocked", "budget_exhausted"]))
        const held = await monthOf(firmId)
        expect([spentOf(held), reservedOf(held)]).toEqual([0, 3 * WORST])
        expect(spentOf(held) + reservedOf(held)).toBeLessThanOrEqual(budget)
      } finally {
        for (const go of waiting) go()
        release()
      }
      const ok = (await run.all).flatMap((s) => (s.status === "fulfilled" && s.value.outcome === "ok" ? [s.value] : []))
      expect(ok).toHaveLength(3)
      const month = await monthOf(firmId)
      expect([spentOf(month), reservedOf(month)]).toEqual([3 * REPLY_COST, 0])
    })

    it("calls on separate instances (no shared ledger queue) contending at once, retried like a client's, still admit at least one and never more than fit: liveness and the upper bound under contention", { timeout: 240_000 }, async () => {
      // Each call's reservation and commit transactions contend directly, as calls on different instances do. Under
      // the emulator's lock timeouts some reservations run out of time; those calls are refused, never admitted. This
      // shows liveness and the upper bound under contention; the test above is the one that isolates the reservation
      // transaction's own budget check (re-audit R4-D1).
      const budget = 3 * WORST + Math.floor(WORST / 2)
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: budget, maxConcurrentCalls: 10 })
      seam().unqueued = "all"
      const { sent, release } = heldTransport()
      // Re-audit R3-D3: a caller refused reservation_failed (its reservation ran out of time under contention) retries,
      // as a client would, up to five attempts with jittered back-off (callP1Retrying); any other answer is final. Under
      // host load all ten first attempts can time out, so this keeps "at least one is admitted" a statement about the
      // system's liveness, not about one lucky round, while the safety bound below is unchanged.
      const run = concurrently(10, () => callP1Retrying(req(firmId), at(T)))
      try {
        await waitFor("every call to be dispatched or refused", () => run.done.length + sent.length >= 10, 220_000)
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

    // Re-audit R1-D1, the audit's chaos row "provider usage discrepancy": a 100,000-byte body that the provider bills at
    // one input token per byte (the most a byte-level tokenizer can bill) and the full 4,096 output tokens. Its charge,
    // 481,920 micro-USD, is three times what a bytes/3 estimate (215,256 with the output ceiling) would have reserved.
    const HEAVY = "!@#$%^&*()".repeat(10_000)
    const heavyReply = (): Reply => ({ text: "REPLY", inputTokens: Buffer.byteLength(HEAVY, "utf8"), outputTokens: MAX_OUTPUT_TOKENS })

    it("provider usage discrepancy, one call: a provider billing one input token per byte never takes spent above the budget", async () => {
      const charge = costMicroUsd(OPUS, Buffer.byteLength(HEAVY, "utf8"), MAX_OUTPUT_TOKENS)!
      const sent = stubTransport(heavyReply())
      // 300,000 fits a bytes/3 reservation (215,256) but not the call's real charge: before the fix it was sent and spent 481,920.
      const tight = await seedFirm({ monthlyBudgetMicroUsd: 300_000 })
      const refused = await callP1(req(tight, { body: HEAVY }), at(T))
      const month = await monthOf(tight)
      expect(spentOf(month) + reservedOf(month)).toBeLessThanOrEqual(300_000)
      expect([refused.outcome, refused.blockReason, sent.length]).toEqual(["blocked", "budget_exhausted", 0])
      // A budget that holds the input ceiling admits it, and the real charge stays inside it.
      const roomy = await seedFirm({ monthlyBudgetMicroUsd: 500_000 })
      const allowed = await callP1(req(roomy, { body: HEAVY }), at(T))
      expect([allowed.outcome, allowed.costMicroUsd]).toEqual(["ok", charge])
      const after = await monthOf(roomy)
      expect([spentOf(after), reservedOf(after)]).toEqual([charge, 0])
      expect(spentOf(after)).toBeLessThanOrEqual(500_000)
    })

    it("provider usage discrepancy, four parallel calls: spent plus reserved stays within the budget while they are in flight and after they settle", { timeout: 60_000 }, async () => {
      const budget = 1_000_000
      const ceiling = costMicroUsd(OPUS, inputCeiling(HEAVY), MAX_OUTPUT_TOKENS)!
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: budget })
      const { sent, release } = heldTransport(heavyReply())
      const run = concurrently(4, () => callP1(req(firmId, { body: HEAVY }), at(T)))
      try {
        await waitFor("every call to be dispatched or refused", () => run.done.length + sent.length >= 4)
        // Before the fix all four were sent (4 x 215,256 fits) and spent 1,927,680: 1.93 x the budget.
        expect(sent).toHaveLength(Math.floor(budget / ceiling))
        const held = await monthOf(firmId)
        expect(spentOf(held) + reservedOf(held)).toBeLessThanOrEqual(budget)
        expect(run.done.map((r) => r.blockReason)).toEqual(Array(4 - sent.length).fill("budget_exhausted"))
      } finally {
        release()
      }
      await run.all
      const month = await monthOf(firmId)
      expect(spentOf(month) + reservedOf(month)).toBeLessThanOrEqual(budget)
      expect([spentOf(month), reservedOf(month)]).toEqual([sent.length * costMicroUsd(OPUS, Buffer.byteLength(HEAVY, "utf8"), MAX_OUTPUT_TOKENS)!, 0])
    })

    it("a provider that bills beyond the reservation is charged in full, and the excess is recorded on the reservation, raised as ai.reservation.exceeded and logged p1.reservation_exceeded", async () => {
      // 50,000 input tokens for a 28-byte body: more than any byte-level tokenizer can bill, so beyond the reservation.
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      stubTransport({ text: "REPLY", inputTokens: 50_000, outputTokens: MAX_OUTPUT_TOKENS })
      const registered = spyRegisteredErrors()
      const r = await callP1(req(firmId), at(T))
      const charge = costMicroUsd(OPUS, 50_000, MAX_OUTPUT_TOKENS)!
      // What the provider billed is owed: it is recorded as it is, never capped.
      expect([r.outcome, r.costMicroUsd, spentOf(await monthOf(firmId))]).toEqual(["ok", charge, charge])
      expect(await reservationOf(r.usageLogId)).toMatchObject({ state: "settled", reservedMicroUsd: WORST, actualMicroUsd: charge, exceededMicroUsd: charge - WORST })
      const raised = (await byFirm("events", firmId)).filter((e) => e.data.name === "ai.reservation.exceeded")
      expect(raised.map((e) => [e.id, e.data.payload])).toEqual([[`${r.usageLogId}_reservation_exceeded`, { monthKey: MONTH, reservedMicroUsd: WORST, actualMicroUsd: charge, excessMicroUsd: charge - WORST }]])
      expect(registered.fieldsOf("p1.reservation_exceeded")).toEqual([
        { firmId, usageLogId: r.usageLogId, monthKey: MONTH, reservedMicroUsd: WORST, actualMicroUsd: charge, excessMicroUsd: charge - WORST },
      ])
      registered.restore()
    })

    it("a kill switch set after the call's first read is honoured by the reservation transaction: refused, nothing sent", { timeout: 60_000 }, async () => {
      const killSwitch = { disableAll: true, disabledModels: [], reason: "stop", setBy: "uid-partner", setAt: Timestamp.fromMillis(T) }
      for (const scope of ["firm", "platform"] as const) {
        const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
        const sent = stubTransport()
        // Hold the firm's ledger queue so the call waits, its first read done, before its reservation transaction.
        let release!: () => void
        const holder = ledgerQueue(firmId, 10_000, 10_000, () => new Error("held"), () => new Promise<void>((resolve) => (release = resolve)))
        const call = callP1(req(firmId), at(T))
        await new Promise((resolve) => setTimeout(resolve, 500))
        if (scope === "firm") await firmConfigRef(firmId).set({ killSwitch }, { merge: true })
        else await platformConfigRef().set({ killSwitch })
        release()
        await holder
        const r = await call
        // Before the fix the in-flight call was sent: the switch was read only before the reservation.
        expect([scope, r.outcome, r.blockReason, sent.length]).toEqual([scope, "blocked", `kill_switch_${scope}`, 0])
        expect(await reservationOf(r.usageLogId)).toBeUndefined()
        await platformConfigRef().delete()
      }
    })

    // Re-audit R2-D3 (N1): U+FDFA, common in Pakistani text, is 3 UTF-8 bytes but its compatibility normalisation
    // (NFKC, NFKD) is 33. A tokenizer that normalises before splitting bills up to 33 tokens for it.
    const NFKC_HEAVY = "ﷺ".repeat(20_000)
    const normalisedBytes = Math.max(...(["NFC", "NFD", "NFKC", "NFKD"] as const).map((f) => Buffer.byteLength(NFKC_HEAVY.normalize(f), "utf8")))

    it("a body whose Unicode normalisation expands is reserved at its largest normal form: spent plus reserved stays within the budget", async () => {
      const charge = costMicroUsd(OPUS, normalisedBytes, MAX_OUTPUT_TOKENS)!
      // The provider normalises and bills one token per byte of the normalised text: 660,000 input tokens.
      const sent = stubTransport({ text: "REPLY", inputTokens: normalisedBytes, outputTokens: MAX_OUTPUT_TOKENS })
      // 1,000,000 fits a raw-byte reservation (322,176) but not the real charge (2,721,920): before the fix it was sent.
      const tight = await seedFirm({ monthlyBudgetMicroUsd: 1_000_000 })
      const refused = await callP1(req(tight, { body: NFKC_HEAVY }), at(T))
      const month = await monthOf(tight)
      expect(spentOf(month) + reservedOf(month)).toBeLessThanOrEqual(1_000_000)
      expect([refused.outcome, refused.blockReason, sent.length]).toEqual(["blocked", "budget_exhausted", 0])
      // A budget of exactly the normalised ceiling admits it, and the charge stays inside the reservation: no excess.
      const ceiling = costMicroUsd(OPUS, contentOf(normalisedBytes) + OVERHEAD, MAX_OUTPUT_TOKENS)!
      const exact = await seedFirm({ monthlyBudgetMicroUsd: ceiling })
      const allowed = await callP1(req(exact, { body: NFKC_HEAVY }), at(T))
      expect([allowed.outcome, allowed.costMicroUsd]).toEqual(["ok", charge])
      const after = await monthOf(exact)
      expect([spentOf(after), reservedOf(after)]).toEqual([charge, 0])
      expect(spentOf(after)).toBeLessThanOrEqual(ceiling)
      expect(await reservationOf(allowed.usageLogId)).toMatchObject({ reservedMicroUsd: ceiling, actualMicroUsd: charge })
      expect((await reservationOf(allowed.usageLogId))!).not.toHaveProperty("exceededMicroUsd")
    })

    it("a reservation carries the documented 1,024-token request overhead on top of the body's bytes (Copilot finding on PR #40)", async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      stubTransport()
      p1TestSeam.failCommit = true // keep the reservation as it was made
      const r = await callP1(req(firmId), at(T))
      const content = contentOf(Buffer.byteLength(BODY, "utf8")) // audit F16: the system message, the body and their per-message overheads
      expect(await reservationOf(r.usageLogId)).toMatchObject({ reservedInputTokens: content + 1024, reservedMicroUsd: costMicroUsd(OPUS, content + 1024, MAX_OUTPUT_TOKENS) })
    })

    it("a provider that bills template tokens beyond the overhead teaches the model's overhead: later reservations hold it and stay within the budget (Copilot finding on PR #40)", async () => {
      // The provider adds 2,000 template tokens to the request's content: 976 more than the 1,024 reserved.
      const content = contentOf(Buffer.byteLength(BODY, "utf8")) // audit F16: the system message, the body and their per-message overheads
      const charge = costMicroUsd(OPUS, content + 2_000, MAX_OUTPUT_TOKENS)!
      stubTransport({ text: "REPLY", inputTokens: content + 2_000, outputTokens: MAX_OUTPUT_TOKENS })
      const registered = spyRegisteredErrors()
      const first = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      const breach = await callP1(req(first), at(T))
      // The breach is recorded in full, raised, and the learned overhead is kept for the model.
      expect(await reservationOf(breach.usageLogId)).toMatchObject({ actualMicroUsd: charge, exceededMicroUsd: charge - WORST, exceededInputTokens: 2_000 - OVERHEAD })
      expect(registered.fieldsOf("p1.reservation_exceeded")).toHaveLength(1)
      expect((await db().collection("platform").doc("p1Overhead").get()).data()?.models).toMatchObject({ "anthropic_claude-opus-5_5": { inputTokens: 2_000, model: OPUS } })
      // Re-audit R3-D1: below the clamp the overhead is learned exactly, every raise is logged at ERROR, and it is no anomaly.
      expect(registered.fieldsOf("p1.overhead_learned")).toEqual([
        { usageLogId: breach.usageLogId, model: OPUS, inputTokens: 2_000, exceededInputTokens: 2_000 - OVERHEAD },
      ])
      expect(registered.fieldsOf("p1.overhead_anomaly")).toEqual([])
      expect((await byFirm("events", first)).filter((e) => e.data.name === "ai.usage.anomaly")).toEqual([])
      // A later call for the model reserves the learned overhead, so its charge fits: a budget of exactly that ceiling holds.
      const learnedCeiling = costMicroUsd(OPUS, content + 2_000, MAX_OUTPUT_TOKENS)!
      const later = await seedFirm({ monthlyBudgetMicroUsd: learnedCeiling })
      const ok = await callP1(req(later), at(T))
      expect(ok.outcome).toBe("ok")
      expect(await reservationOf(ok.usageLogId)).toMatchObject({ reservedInputTokens: content + 2_000, reservedMicroUsd: learnedCeiling, actualMicroUsd: charge })
      expect((await reservationOf(ok.usageLogId))!).not.toHaveProperty("exceededMicroUsd")
      const refused = await callP1(req(later), at(T))
      expect(refused.blockReason).toBe("budget_exhausted")
      const month = await monthOf(later)
      expect(spentOf(month) + reservedOf(month)).toBeLessThanOrEqual(learnedCeiling)
      registered.restore()
    })

    // Re-audit R3-D1: what one breach may teach every firm is clamped to LEARNED_OVERHEAD_MAX_FACTOR (4) times the cost
    // table's overhead for the model, 4 x 1,024 = 4,096 tokens; a breach beyond that is an anomaly, recorded and raised.
    const CLAMP = 4 * OVERHEAD
    const learnedOf = async (): Promise<unknown> => (await db().collection("platform").doc("p1Overhead").get()).data()?.models?.["anthropic_claude-opus-5_5"]?.inputTokens

    it("a provider reporting 25,000,000 prompt tokens for a 28-byte body teaches at most the clamp: an uninvolved $50 firm is still admitted, and the anomaly is recorded (re-audit R3-D1)", async () => {
      const content = contentOf(Buffer.byteLength(BODY, "utf8")) // audit F16: the system message, the body and their per-message overheads
      const registered = spyRegisteredErrors()
      stubTransport({ text: "REPLY", inputTokens: 25_000_000, outputTokens: MAX_OUTPUT_TOKENS })
      const a = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      const breach = await callP1(req(a), at(T))
      // The charge is owed and recorded in full on the firm that incurred it, with its excess.
      const charge = costMicroUsd(OPUS, 25_000_000, MAX_OUTPUT_TOKENS)!
      expect([breach.outcome, breach.costMicroUsd, spentOf(await monthOf(a))]).toEqual(["ok", charge, charge])
      // Firm B, never involved, with a $50 budget: before the fix the learned 24,999,972 tokens put its worst case at
      // 100,081,920 micro-USD and refused it budget_exhausted, this month and the next.
      stubTransport()
      const b = await seedFirm({ monthlyBudgetMicroUsd: 50_000_000 })
      const admitted = await callP1(req(b), at(T))
      expect([admitted.outcome, admitted.blockReason]).toEqual(["ok", null])
      expect(await reservationOf(admitted.usageLogId)).toMatchObject({ reservedInputTokens: content + CLAMP, reservedMicroUsd: costMicroUsd(OPUS, content + CLAMP, MAX_OUTPUT_TOKENS) })
      const nextMonth = await callP1(req(b), at(Date.parse("2026-11-11T10:00:00.000Z")))
      expect([nextMonth.outcome, nextMonth.blockReason]).toEqual(["ok", null])
      // Learned only up to the clamp.
      expect(await learnedOf()).toBe(CLAMP)
      expect(await reservationOf(breach.usageLogId)).toMatchObject({ exceededMicroUsd: charge - WORST, exceededInputTokens: 25_000_000 - inputCeiling(BODY), usageAnomaly: true })
      // Recorded and raised: the exceeded event stays, the anomaly has its own event, and both are logged at ERROR.
      const events = await byFirm("events", a)
      expect(events.filter((e) => e.data.name === "ai.reservation.exceeded").map((e) => e.id)).toEqual([`${breach.usageLogId}_reservation_exceeded`])
      expect(events.filter((e) => e.data.name === "ai.usage.anomaly").map((e) => [e.id, e.data.payload])).toEqual([
        [
          `${breach.usageLogId}_usage_anomaly`,
          { monthKey: MONTH, model: OPUS, inputTokens: 25_000_000, bodyTokens: content, overheadTokens: 25_000_000 - content, learnedTokens: CLAMP, clampTokens: CLAMP },
        ],
      ])
      expect(registered.fieldsOf("p1.overhead_anomaly").map((f) => f.usageLogId)).toEqual([breach.usageLogId])
      expect(registered.fieldsOf("p1.overhead_learned").map((f) => f.inputTokens)).toEqual([CLAMP])
      registered.restore()
    })

    it("a provider reporting Number.MAX_SAFE_INTEGER prompt tokens cannot overflow the learned overhead: it stays at the clamp and a firm at the route's maximum budget is still admitted (re-audit R3-D1)", async () => {
      vi.spyOn(logger, "error").mockImplementation(() => undefined)
      stubTransport({ text: "REPLY", inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: MAX_OUTPUT_TOKENS })
      const a = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      const breach = await callP1(req(a), at(T))
      expect(breach.outcome).toBe("ok")
      // The route's largest budget is 1,000,000 USD: before the fix the learned overhead refused even that firm, and so every firm.
      stubTransport()
      const b = await seedFirm({ monthlyBudgetMicroUsd: 1_000_000_000_000 })
      const admitted = await callP1(req(b), at(T))
      expect([admitted.outcome, admitted.blockReason]).toEqual(["ok", null])
      const learned = await learnedOf()
      expect([learned, Number.isSafeInteger(learned)]).toEqual([CLAMP, true])
      expect(await reservationOf(breach.usageLogId)).toMatchObject({ usageAnomaly: true })
      expect((await byFirm("events", a)).filter((e) => e.data.name === "ai.usage.anomaly")).toHaveLength(1)
    })

    it("four concurrent breaches end at the largest overhead they show, and never above the clamp (re-audit R3-D1)", { timeout: 120_000 }, async () => {
      vi.spyOn(logger, "error").mockImplementation(() => undefined)
      const content = contentOf(Buffer.byteLength(BODY, "utf8")) // audit F16: the system message, the body and their per-message overheads
      // Each round holds its four calls at the transport until all four are in flight (or 15 s have passed, so a call
      // that is slow to dispatch never holds the others for good), then lets their commits race on the learned-overhead
      // doc. Each call bills the request's content plus the overhead given for it, and is retried like a client's when its
      // reservation runs out of time under load (callP1Retrying).
      const round = async (overheads: number[]): Promise<P1Result[]> => {
        const queue = [...overheads]
        const sent: Sent[] = []
        let release!: () => void
        const gate = new Promise<void>((resolve) => (release = resolve))
        const fallback = setTimeout(() => release(), 15_000)
        setP1TransportForTests({
          async send(r) {
            sent.push(recordSent(r))
            const overhead = queue.shift()!
            if (sent.length >= overheads.length) release()
            await gate
            return { text: "REPLY", inputTokens: content + overhead, outputTokens: MAX_OUTPUT_TOKENS }
          },
        })
        const firms = await Promise.all(overheads.map(() => seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })))
        const results = await Promise.all(firms.map((f) => callP1Retrying(req(f), at(T))))
        clearTimeout(fallback)
        expect([sent.length, ...results.map((r) => [r.outcome, r.accounting])]).toEqual([overheads.length, ...Array(overheads.length).fill(["ok", "settled"])])
        return results
      }
      // All below the clamp: the largest wins, whatever order the commits land in.
      await round([1_500, 3_900, 2_000, 3_000])
      expect(await learnedOf()).toBe(3_900)
      // One beyond the clamp: it teaches only the clamp, and no smaller raise lands after it.
      const second = await round([2_000, 9_000, 3_000, 4_000])
      expect(await learnedOf()).toBe(Math.min(9_000, CLAMP))
      const anomalies = (await Promise.all(second.map((r) => reservationOf(r.usageLogId)))).filter((r) => r?.usageAnomaly === true)
      expect(anomalies).toHaveLength(1)
    })

    it("a call whose pre-call work ran past its allowance is refused with a retryable error before anything is reserved or sent (re-audit R3-D2)", async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      const sent = stubTransport()
      // The deadline the handler gives: already passed on the clock it gives.
      const late = callP1(req(firmId), { now: () => T, preCallDeadline: { atMs: 1_000, clock: () => 1_001 } })
      await expect(late).rejects.toMatchObject({ code: "precall_deadline", retryable: true })
      expect(sent).toHaveLength(0)
      expect(await byFirm("ai_reservations", firmId)).toEqual([])
      expect(await byFirm("ai_usage_logs", firmId)).toEqual([])
      expect(reservedOf(await monthOf(firmId))).toBe(0)
      // Within the deadline the same call goes ahead.
      const inTime = await callP1(req(firmId), { now: () => T, preCallDeadline: { atMs: 1_000, clock: () => 1_000 } })
      expect([inTime.outcome, sent.length]).toEqual(["ok", 1])
    })

    it("an unknown model is refused before dispatch: model_unpriced, nothing sent, nothing reserved (Copilot finding on PR #40: fail closed)", async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      const sent = stubTransport()
      p1TestSeam.modelOverride = "x/unverified-model"
      const r = await callP1(req(firmId), at(T))
      expect([r.outcome, r.blockReason, sent.length]).toEqual(["blocked", "model_unpriced", 0])
      expect(await reservationOf(r.usageLogId)).toBeUndefined()
    })

    it("a billed failure keeps the provider's ids on its attempt (Codex P2 on PR #40)", async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      setP1TransportForTests({
        send: async () => {
          throw new P1TransportError("gateway_no_text", { billable: true, inputTokens: 7, outputTokens: 3, responseId: "gen-77AB", requestId: "req-77ab" })
        },
      })
      const r = await callP1(req(firmId), at(T))
      expect([r.outcome, r.costMicroUsd]).toEqual(["failed", costMicroUsd(OPUS, 7, 3)])
      expect((await reservationOf(r.usageLogId))?.providerAttempt).toMatchObject({ outcome: "returned", result: "failed", responseId: "gen-77AB", requestId: "req-77ab" })
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
      // The provider's response id and the Gateway's request id ride along (re-audit R1-D5).
      const sent = stubTransport({ ...DEFAULT_REPLY, responseId: "gen-01J9ZXK4", requestId: "req_7f3a-01" })
      p1TestSeam.failCommit = true
      const r = (await callP1(req(firmId), at(T))) as P1Result & { accounting?: string }

      // The result is available; its accounting is not complete (main: outcome ok and nothing else to tell them apart).
      expect(r).toMatchObject({ outcome: "ok", text: "REPLY", costMicroUsd: REPLY_COST })
      expect(r.accounting).toBe("pending")
      expect(await usageRowOf(r.usageLogId)).toBeUndefined()
      // The provider attempt is durable, names the provider's own ids for a later per-request reconciliation (O-57),
      // and still holds the worst case against the budget.
      const reservation = await reservationOf(r.usageLogId)
      expect(reservation?.providerAttempt).toMatchObject({ outcome: "returned", costMicroUsd: REPLY_COST, responseId: "gen-01J9ZXK4", requestId: "req_7f3a-01" })
      expect(reservation).toMatchObject({ firmId, state: "reserved", reservedMicroUsd: WORST, model: OPUS, classification: "internal", taskType: "committee" })
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
        inputTokens: inputCeiling(BODY),
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
      // The late answer does not rewrite the attempt of a reservation the reconciler already settled (re-audit INFO):
      // the record still says what the settlement was based on.
      expect((await reservationOf(r.usageLogId))!.providerAttempt.outcome).toBe("pending")
      expect(reconciled).toEqual({ settled: [r.usageLogId], released: [] })
      expect([r.outcome, r.accounting]).toEqual(["ok", "settled"])
      expect((await byFirm("ai_usage_logs", firmId)).map((u) => [u.id, u.data.outcome])).toEqual([[r.usageLogId, "reconciled"]])
      expect([spentOf(await monthOf(firmId)), reservedOf(await monthOf(firmId))]).toEqual([WORST, 0])
      expect(await reservationOf(r.usageLogId)).toMatchObject({ state: "settled", actualMicroUsd: WORST })
    })

    it("a lapsed attempt with no traceId is still reconciled, and its firm is unblocked", { timeout: 60_000 }, async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      stubTransport()
      const id = await seedLapsedAttempt(firmId, { traceId: undefined })
      expect((await callP1(req(firmId), at(afterLease()))).blockReason).toBe("accounting_indeterminate")
      expect(await reconcileFor(firmId, afterLease())).toEqual({ settled: [id], released: [] })
      expect(await usageRowOf(id)).toMatchObject({ outcome: "reconciled", costMicroUsd: WORST, trace: { id: null } })
      expect((await callP1(req(firmId), at(afterLease()))).outcome).toBe("ok")
    })

    it("a reservation whose leaseUntil is stored as a number is found by the reconciler and settled, and its firm is unblocked", { timeout: 60_000 }, async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      stubTransport()
      const id = await seedLapsedAttempt(firmId, { leaseUntil: T })
      expect((await callP1(req(firmId), at(afterLease()))).blockReason).toBe("accounting_indeterminate")
      expect(await reconcileFor(firmId, afterLease())).toEqual({ settled: [id], released: [] })
      expect((await callP1(req(firmId), at(afterLease()))).outcome).toBe("ok")
    })

    it("a hundred unreconcilable lapsed reservations of another firm, ahead of a good one, do not starve it: it is settled in the first run", { timeout: 120_000 }, async () => {
      const poisonFirm = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      const victim = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      stubTransport()
      p1TestSeam.failCommit = true
      const r = await callP1(req(victim), at(T))
      p1TestSeam.failCommit = false
      // Unreconcilable: no traceId and no readable hold. Their leases lapsed before the victim's, so a reconciler that
      // reads oldest first meets all hundred first.
      const poison = await Promise.all(
        Array.from({ length: 100 }, (_, i) => seedLapsedAttempt(poisonFirm, { traceId: undefined, reservedMicroUsd: "unknown", leaseUntil: Timestamp.fromMillis(T - 1_000 - i) }))
      )
      try {
        expect(await reconcileFor(victim, afterLease())).toEqual({ settled: [r.usageLogId], released: [] })
        expect((await callP1(req(victim), at(afterLease()))).outcome).toBe("ok")
      } finally {
        const batch = db().batch()
        for (const id of poison) batch.delete(db().collection("ai_reservations").doc(id))
        await batch.commit()
      }
    })

    it("a reservation the reconciler cannot settle is quarantined after three failed runs: reconcile_failed, logged, its hold kept and its firm still blocked", { timeout: 60_000 }, async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      stubTransport()
      await monthRef(firmId, MONTH).set({ firmId, monthKey: MONTH, reservedMicroUsd: WORST })
      // No readable hold: the reconciler cannot know what to take off the month's reservedMicroUsd, so it must not guess.
      const id = await seedLapsedAttempt(firmId, { reservedMicroUsd: "unknown" })
      const registered = spyRegisteredErrors()
      for (let run = 1; run <= 3; run++) {
        expect(await reconcileFor(firmId, afterLease() + run * 60_000)).toEqual({ settled: [], released: [] })
      }
      expect(await reservationOf(id)).toMatchObject({ state: "reconcile_failed", reconcileFailures: 3 })
      expect(registered.fieldsOf("p1.reconcile_quarantined").map((f) => f.usageLogId)).toEqual([id])
      registered.restore()
      // Fail closed: the hold stays on the books and the firm stays blocked until an operator settles it (README runbook).
      expect(reservedOf(await monthOf(firmId))).toBe(WORST)
      expect((await callP1(req(firmId), at(afterLease() + 300_000))).blockReason).toBe("accounting_indeterminate")
      // A quarantined reservation is no longer retried.
      await reconcileFor(firmId, afterLease() + 360_000)
      expect(await reservationOf(id)).toMatchObject({ state: "reconcile_failed", reconcileFailures: 3 })
    })

    it("a valid record whose reconciliation fails only on contention for its month total is never quarantined: it stays reserved, uncounted, and is settled once the contention ends", { timeout: 240_000 }, async () => {
      // Re-audit R2-D1 (N2): another transaction holds the firm's month total through each of three runs, so each run's
      // settlement aborts (gRPC ABORTED). Before the fix each abort counted, and the third quarantined a valid record.
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      stubTransport()
      const id = await seedLapsedAttempt(firmId)
      const registered = spyRegisteredErrors()
      for (let run = 1; run <= 3; run++) {
        const hold = db()
          .runTransaction(async (tx) => {
            await tx.get(monthRef(firmId, MONTH))
            await new Promise((resolve) => setTimeout(resolve, 25_000))
          })
          .catch(() => undefined)
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(await reconcileFor(firmId, afterLease() + run * 60_000)).toEqual({ settled: [], released: [] })
        const held = (await reservationOf(id))!
        expect([run, held.state, held.reconcileFailures]).toEqual([run, "reserved", undefined])
        await hold
      }
      const mine = (event: string) => registered.fieldsOf(event).filter((f) => f.usageLogId === id)
      expect(mine("p1.reconcile_quarantined")).toEqual([])
      // Each failure was logged by its code as transient, and not counted.
      expect(mine("p1.reconcile_failed").map((l) => [l.code, l.transient])).toEqual(Array(3).fill(["grpc_10", true]))
      registered.restore()
      // Contention over: the next run settles it, and the firm is no longer blocked.
      expect(await reconcileFor(firmId, afterLease() + 240_000)).toEqual({ settled: [id], released: [] })
      expect((await callP1(req(firmId), at(afterLease() + 300_000))).outcome).toBe("ok")
    })

    it("five hundred live reservations sorting ahead of a lapsed attempt do not starve it: it is settled in the first run", { timeout: 120_000 }, async () => {
      // Re-audit R2-D2 (N5): live records (lease in the future) of another firm whose ids sort first. Before the fix the
      // run's 500-record scan by document id ended inside them and never reached the lapsed attempt.
      const busy = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      const victim = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      stubTransport()
      const prefix = `aaaa-${busy}`
      const live = Array.from({ length: 500 }, (_, i) => `${prefix}-${String(i).padStart(4, "0")}`)
      for (let i = 0; i < live.length; i += 250) {
        const batch = db().batch()
        for (const id of live.slice(i, i + 250)) {
          batch.set(db().collection("ai_reservations").doc(id), {
            firmId: busy,
            state: "reserved",
            reservedMicroUsd: WORST,
            monthKey: MONTH,
            traceId: id,
            usageLogId: id,
            leaseUntil: Timestamp.fromMillis(afterLease() + 10 * 60_000),
          })
        }
        await batch.commit()
      }
      try {
        const vid = await seedLapsedAttempt(victim, {}, `zzzz-${victim}`)
        expect(await reconcileFor(victim, afterLease())).toEqual({ settled: [vid], released: [] })
        expect((await callP1(req(victim), at(afterLease() + 60_000))).outcome).toBe("ok")
        // The live records were neither touched nor counted.
        expect((await db().collection("ai_reservations").doc(live[0]!).get()).data()).not.toHaveProperty("reconcileFailures")
      } finally {
        for (let i = 0; i < live.length; i += 250) {
          const batch = db().batch()
          for (const id of live.slice(i, i + 250)) batch.delete(db().collection("ai_reservations").doc(id))
          await batch.commit()
        }
      }
    })

    it("a lapsed attempt whose leaseUntil is missing altogether is found by the rotating sweep and settled, and its firm is unblocked", { timeout: 120_000 }, async () => {
      const firmId = await seedFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      stubTransport()
      const id = await seedLapsedAttempt(firmId, { leaseUntil: undefined })
      expect((await callP1(req(firmId), at(afterLease()))).blockReason).toBe("accounting_indeterminate")
      // The sweep reads a bounded slice of open records per run and moves on: it reaches every record within a cycle.
      let settled = false
      for (let run = 0; run < 40 && !settled; run++) settled = (await reconcileFor(firmId, afterLease() + run * 60_000)).settled.includes(id)
      expect(settled).toBe(true)
      expect((await callP1(req(firmId), at(afterLease() + 3_000_000))).outcome).toBe("ok")
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

    it("a request whose pre-call work ran past the 8 s allowance is refused 503 precall_deadline before anything is reserved or sent, and a same-key retry runs (re-audit R3-D2)", async () => {
      const f = await newFirm({ monthlyBudgetMicroUsd: BIG_BUDGET })
      const brain = viaApi<Out>("committeeBrain", { now: () => T })
      const sent = stubTransport()
      // The pre-call clock reads 8,001 ms past the request's start: its reads were slow.
      p1OpsTestSeam.preCallClock = () => Date.now() + 8_001
      const key = randomUUID()
      const ask = () => brain({ token: f.members[0]!.token, data: { firmId: f.firmId, matterId: f.matterId, body: BODY }, headers: { "idempotency-key": key } } as never)
      const err = await ask().then(
        () => null,
        (e: unknown) => e
      )
      expect(err).toBeInstanceOf(ApiError)
      expect([(err as ApiError).status, (err as ApiError).code]).toEqual([503, "precall_deadline"])
      // No paid work started: nothing sent, nothing reserved, no usage row, no output row.
      expect(sent).toHaveLength(0)
      expect(await byFirm("ai_reservations", f.firmId)).toEqual([])
      expect(await byFirm("ai_usage_logs", f.firmId)).toEqual([])
      expect(await byFirm("committee_outputs", f.firmId)).toEqual([])
      // Retryable: the Idempotency-Key was released, so the same request runs once the reads are quick again.
      delete p1OpsTestSeam.preCallClock
      const retried = await ask()
      expect([retried.blocked, retried.text, retried.accounting, sent.length]).toEqual([false, "REPLY", "settled", 1])
    })

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
      const usage = viaApi<{ calls: Record<string, number> }>("getAiUsage", { now: () => clock })
      const ask = (headers?: Record<string, string>) =>
        brain({ token: f.members[0]!.token, data: { firmId: f.firmId, matterId: f.matterId, body: BODY }, ...(headers ? { headers } : {}) } as never)
      const sent = stubTransport()
      p1TestSeam.failCommit = true
      const key = randomUUID()
      const first = await ask({ "idempotency-key": key })
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
      // Codex P2 on PR #40: the stored output and the stored answer are refreshed, so a reader and a same-key replay
      // see the books completed; the month's counts include the reconciled call.
      expect((await db().collection("committee_outputs").doc(row!.id).get()).data()).toMatchObject({ accounting: "settled" })
      const replay = (await ask({ "idempotency-key": key })) as Out & { reused?: boolean }
      expect([replay.reused, replay.outputId, replay.accounting]).toEqual([true, first.outputId, "settled"])
      expect((await usage({ token: f.members[0]!.token, data: { firmId: f.firmId, month: MONTH } } as never)).calls).toEqual({ ok: 0, failed: 0, blocked: 1, reconciled: 1 })
      const resumed = await ask()
      expect([resumed.blocked, resumed.text, resumed.accounting]).toEqual([false, "REPLY", "settled"])
      expect(sent).toHaveLength(2)
      expect(spentOf(await monthOf(f.firmId))).toBe(2 * REPLY_COST)
    })
  })
})
