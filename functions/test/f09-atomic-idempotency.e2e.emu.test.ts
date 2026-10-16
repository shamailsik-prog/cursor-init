import { randomUUID } from "node:crypto"
import { FieldValue, Timestamp, Transaction, type DocumentData, type DocumentReference } from "firebase-admin/firestore"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { adminDb } from "../src/admin"
import { HttpError } from "../src/http/errors"
import * as idempotency from "../src/http/idempotency"
import { IDEMPOTENCY_LEASE_MS, IDEMPOTENCY_TTL_MS, requestHash, withIdempotency } from "../src/http/idempotency"
import { createRouter, type Route } from "../src/http/router"
import { firmConfigRef, platformConfigRef } from "../src/p1/config"
import { p1TestSeam } from "../src/p1/gateway"
import { setOpikFetchForTests } from "../src/p1/opik"
import { p1OpsTestSeam } from "../src/p1/ops"
import { setP1TransportForTests } from "../src/p1/transport"
import type { Operation } from "../src/p5/common"
import { apiErrorOf, viaApi } from "./api"
import { EMULATORS, mintIdToken, mockRes, uniq } from "./emu"

/**
 * Audit finding F09 (HIGH, 2026-10-13): "Functions idempotency does not atomically cover committed effects". End to end
 * through the real HTTP router (`createRouter`, `ROUTES`) over the Auth and Firestore emulators; the provider is faked at
 * the transport boundary only (`setP1TransportForTests`).
 *
 * The audit's failure scenario: a probe using the real wrapper and a committed synthetic Firestore effect, followed by a
 * 500, executed that effect twice for the same key; in committeeBrain, provider spend precedes output persistence, so a
 * failed output write permitted another paid call (O-58). The correction (spec
 * docs/superpowers/specs/2026-10-16-f09-atomic-idempotency-design.md): the operation's "effect committed" state commits
 * with the effect (the marker `idempotency_effects/{id}`, a `tx.create` fence), committeeBrain records its dispatch with
 * the provider-attempt record and its receipt when the provider answers, and a same-key retry resumes publication
 * without a second provider call. The first describe block is RED on main; the rest is the fault matrix at every
 * effect/settlement boundary.
 */

const T = Date.parse("2026-10-11T10:00:00.000Z") // PKT month 2026-10
const BODY = "Draft a reply to the notice."
const BIG = 1_000_000_000
/** One millisecond past an idempotency lease that started at `at`. */
const pastLease = (at: number) => at + IDEMPOTENCY_LEASE_MS + 1
/** One second past the P1 reservation lease of a call made at T (180 s: the function timeout plus 60 s). */
const AFTER_RESERVATION_LEASE = T + 180_000 + 1_000

type Member = { uid: string; token: string }
type Out = {
  outputId: string
  blocked: boolean
  reason?: string
  text?: string
  classification: string
  usage: { inputTokens: number; outputTokens: number; costMicroUsd: number }
  traceId: string
  accounting: string
  reused?: boolean
}

const db = () => adminDb()
const errorOf = (out: { body: unknown }) => (out.body as { error?: { code?: string } }).error?.code
const keyDoc = (firmId: string, key: string) => db().collection("idempotency_keys").doc(`${firmId || "_nofirm"}_${key.toLowerCase()}`)
const markerDoc = (firmId: string, key: string) => db().collection("idempotency_effects").doc(`${firmId || "_nofirm"}_${key.toLowerCase()}`)
const byFirm = async (collection: string, firmId: string): Promise<Array<{ id: string; data: DocumentData }>> =>
  (await db().collection(collection).where("firmId", "==", firmId).get()).docs.map((d) => ({ id: d.id, data: d.data() }))
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * The 409 idempotency_effect_committed body (re-audit LOW-1): it names the operation whose effect committed, so a client
 * can correlate it; `reused: true` on a replay.
 */
const committedBody = (operationId: string, reused = true) => ({
  error: { code: "idempotency_effect_committed", operationId },
  ...(reused ? { reused: true } : {}),
})
/** The operation id the key's record names. */
const operationIdOf = async (firmId: string, key: string): Promise<string> => (await keyDoc(firmId, key).get()).get("operationId") as string

/** A promise the test opens when it chooses, and one that resolves when the held code has reached the gate. */
function gate(): { open: () => void; wait: Promise<void>; reached: () => void; arrived: Promise<void> } {
  let open!: () => void
  let reached!: () => void
  const wait = new Promise<void>((r) => (open = r))
  const arrived = new Promise<void>((r) => (reached = r))
  return { open, wait, reached, arrived }
}

// ---------------------------------------------------------------------------
// The synthetic effect route: one Firestore transaction that stages the route's allow row and increments a counter,
// exactly as every effectful POST handler stages its allow row with its effect (P5 one-audit-row-per-call).
// ---------------------------------------------------------------------------

const effectCount = async (id: string): Promise<number> => ((await db().collection("f09_effects").doc(id).get()).data()?.n as number | undefined) ?? 0

type EffectOpts = {
  /** Runs before the effect transaction, with the run number (1 for the first run). */
  before?: (run: number) => Promise<void> | void
  /** Runs after the effect transaction committed; its return value (or throw) is the handler's answer. */
  after?: (run: number) => Promise<unknown> | unknown
}

function effectOp(o: EffectOpts = {}): { op: Operation; runs: { n: number } } {
  const runs = { n: 0 }
  const op: Operation = {
    auth: "firm",
    kind: "general",
    action: uniq("test.f09"),
    target: "t",
    run: async (_session, data, audit) => {
      runs.n += 1
      const run = runs.n
      await o.before?.(run)
      const ref = db().collection("f09_effects").doc(String(data.effectId))
      await db().runTransaction(async (tx) => {
        await audit.stage(tx, "allow", "ok")
        tx.set(ref, { n: FieldValue.increment(1) }, { merge: true })
      })
      audit.committed()
      return o.after ? o.after(run) : { effectId: data.effectId, run }
    },
  }
  return { op, runs }
}

const route = (path: string, handler: Operation, extra: Record<string, unknown> = {}): Route =>
  ({ method: "POST", path, handler, kind: handler.kind, ...extra }) as Route

type ReqInit = { path: string; token: string; firmId: string; key: string; body?: Record<string, unknown> }

async function send(router: ReturnType<typeof createRouter>, r: ReqInit) {
  const body = r.body ?? {}
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${r.token}`,
    "x-firm-id": r.firmId,
    "idempotency-key": r.key,
  }
  const { res, out } = mockRes()
  await router({ method: "POST", path: r.path, headers, body, rawBody: Buffer.from(JSON.stringify(body)), ip: "127.0.0.1" } as never, res as never)
  return out
}

/** A fixed instant inside its own minute, ten minutes after the last one, so rate-limit windows never collide. */
let minute = Date.UTC(2033, 0, 1, 0, 0, 0)
const freshMinute = () => {
  minute += 10 * 60_000
  return minute + 5_000
}
/** One fixed clock for every request of a test: requests of one test must agree on the time (a lease is measured on it). */
const fixedClock = () => {
  const at = freshMinute()
  return () => at
}

/**
 * One firm and partner for every synthetic-route test. Each test has its own keys, effect ids and clock minutes, so
 * they stay independent; sharing the firm keeps this file's footprint on the shared emulator small (suites such as
 * p2.jobs-scheduled scan every firm the earlier files left behind).
 */
let sharedPartner: Promise<{ firmId: string } & Member> | undefined
/** The `firms/{id}` docs this file created; deleted after it, so suites that scan every firm see what main leaves. */
const createdFirms: string[] = []
function firmPartner(): Promise<{ firmId: string } & Member> {
  sharedPartner ??= (async () => {
    const firmId = uniq("firm")
    createdFirms.push(firmId)
    await db().collection("firms").doc(firmId).set({ name: "T" })
    return { firmId, ...(await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })) }
  })()
  return sharedPartner
}

// ---------------------------------------------------------------------------
// committeeBrain fixtures (the real route through ROUTES, a stub Gateway at the transport boundary)
// ---------------------------------------------------------------------------

type Sent = { model: string; body: string; maxTokens: number }

function stubTransport(hold?: Promise<void>): Sent[] {
  const sent: Sent[] = []
  setP1TransportForTests({
    async send(r) {
      sent.push({ ...r })
      if (hold) await hold
      return { text: "REPLY", inputTokens: 1000, outputTokens: 500 }
    },
  })
  return sent
}

type Firm = { firmId: string; matterId: string; P: Member; A: Member }

async function brainFirm(): Promise<Firm> {
  const firmId = uniq("firm")
  createdFirms.push(firmId)
  await db().collection("firms").doc(firmId).set({ name: "F", plan: "internal" })
  await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: BIG })
  const matterId = uniq("matter")
  await db().collection("matters").doc(matterId).set({ firmId, classification: "internal", title: "Recovery suit", stage: "pre_filing", status: "open", createdAt: Timestamp.now() })
  const member = async (role: string): Promise<Member> => {
    const m = await mintIdToken({ firmId, role, clearanceLevel: "privileged-restricted" })
    await db().collection("matter_members").doc(`${matterId}_${m.uid}`).set({ firmId, matterId, userId: m.uid, classification: "internal" })
    return m
  }
  return { firmId, matterId, P: await member("partner"), A: await member("associate") }
}

const brainAt = (now: () => number) => viaApi<Out>("committeeBrain", { now })
const ask = (brain: ReturnType<typeof brainAt>, f: Firm, key: string, m: Member = f.P) =>
  brain({ token: m.token, data: { firmId: f.firmId, matterId: f.matterId, body: BODY }, headers: { "idempotency-key": key } } as never)

function resetSeams() {
  for (const k of Object.keys(p1TestSeam)) delete (p1TestSeam as Record<string, unknown>)[k]
  for (const k of Object.keys(p1OpsTestSeam)) delete (p1OpsTestSeam as Record<string, unknown>)[k]
  const idem = (idempotency as unknown as { idempotencyTestSeam?: Record<string, unknown> }).idempotencyTestSeam
  if (idem) for (const k of Object.keys(idem)) delete idem[k]
}

/** The new seams by name, read loosely so this file also runs against the code before the fix (where they do not exist). */
const idemSeam = () => ((idempotency as unknown as { idempotencyTestSeam?: Record<string, unknown> }).idempotencyTestSeam ?? {}) as {
  settleFailures?: Error[]
  beforeSettle?: () => Promise<void>
}
const opsSeam = () => p1OpsTestSeam as typeof p1OpsTestSeam & { beforePublish?: () => Promise<void> }
const gatewaySeam = () => p1TestSeam as unknown as Record<string, unknown>

async function reconcileAt(nowMs: number): Promise<void> {
  const { reconcileReservations } = await import("../src/p1/reconciler")
  await reconcileReservations({ now: () => nowMs })
}

describe.skipIf(!EMULATORS)("audit F09: a committed effect is never repeated for one Idempotency-Key (e2e)", () => {
  beforeEach(() => {
    vi.stubEnv("OPIK_BASE_URL", undefined)
    vi.stubEnv("OPIK_SELF_HOSTED_CONFIRMED", undefined)
    vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
    setProviderConfigForTests(null)
    resetSeams()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    setP1TransportForTests(null)
    setOpikFetchForTests(null)
    setProviderConfigForTests(null)
    resetSeams()
    await platformConfigRef().delete()
    await db().collection("platform").doc("p1Overhead").delete()
    await db().collection("platform").doc("p1ReconcileCursor").delete()
  })

  afterAll(async () => {
    await Promise.all(createdFirms.map((id) => db().collection("firms").doc(id).delete()))
  })

  // -------------------------------------------------------------------------
  // The audit's failure scenarios: each one fails on main (the effect or the paid call runs twice).
  // -------------------------------------------------------------------------
  describe("the audit's failure scenarios (RED on main)", () => {
    it.each([
      ["a thrown Error", () => Promise.reject(new Error("after the effect"))],
      ["a 503 HttpError", () => Promise.reject(new HttpError(503, "audit_unavailable"))],
      ["a lost commit answer (DEADLINE_EXCEEDED)", () => Promise.reject(Object.assign(new Error("deadline exceeded"), { code: 4 }))],
    ])("the audit probe: a committed Firestore effect followed by %s runs once per key, and the key answers 409 idempotency_effect_committed", async (_label, after) => {
      const { op, runs } = effectOp({ after })
      const router = createRouter([route("/api/t/f09/probe", op)], { now: fixedClock() })
      const { firmId, token } = await firmPartner()
      const key = randomUUID()
      const effectId = uniq("e")
      const first = await send(router, { path: "/api/t/f09/probe", token, firmId, key, body: { effectId } })
      const second = await send(router, { path: "/api/t/f09/probe", token, firmId, key, body: { effectId } })
      // Main: the 500 released the key, the retry ran the handler again and the effect committed twice.
      expect(await effectCount(effectId)).toBe(1)
      expect(runs.n).toBe(1)
      const operationId = await operationIdOf(firmId, key)
      expect([first.status, first.body]).toEqual([409, committedBody(operationId, false)])
      expect(second.status).toBe(409)
      expect(second.body).toEqual(committedBody(operationId))
      expect((await keyDoc(firmId, key).get()).data()).toMatchObject({ status: "done", response: { status: 409, body: committedBody(operationId, false) } })
    })

    it("the user flow: committeeBrain's output write fails for good after the provider call; the same-key retry publishes that call's answer, with no second provider call", async () => {
      const f = await brainFirm()
      const sent = stubTransport()
      const brain = brainAt(() => T)
      const key = randomUUID()
      p1OpsTestSeam.sleep = async () => undefined
      p1OpsTestSeam.outputWriteFailures = [new Error("down"), new Error("down"), new Error("down")]
      const err = await apiErrorOf(ask(brain, f, key))
      expect([err.status, err.code]).toEqual([500, "internal"])
      expect(sent).toHaveLength(1)
      expect(await byFirm("committee_outputs", f.firmId)).toHaveLength(0)

      const retried = await ask(brain, f, key)
      // Main: the retry called the provider again (a second paid call, O-58).
      expect(sent).toHaveLength(1)
      const usage = await byFirm("ai_usage_logs", f.firmId)
      expect(usage).toHaveLength(1)
      expect(retried).toMatchObject({ blocked: false, text: "REPLY", accounting: "settled", usage: { inputTokens: 1000, outputTokens: 500, costMicroUsd: 14000 } })
      expect(retried.traceId).toBe(usage[0]!.data.trace.id)
      const outputs = await byFirm("committee_outputs", f.firmId)
      expect(outputs.map((o) => o.id)).toEqual([retried.outputId])
      expect(outputs[0]!.data).toMatchObject({ usageLogId: usage[0]!.id, traceId: retried.traceId, text: "REPLY", blocked: false, outbound: { body: BODY } })
      // The answer committed with the output row; a replay returns it.
      const replay = await ask(brain, f, key)
      expect(replay).toEqual({ ...retried, reused: true })
      expect(sent).toHaveLength(1)
    })

    it("committeeBrain crashes after the provider answered and before its receipt was recorded: the same-key retry makes no second call and answers 409 idempotency_effect_committed", async () => {
      const f = await brainFirm()
      const sent = stubTransport()
      const brain = brainAt(() => T)
      const key = randomUUID()
      gatewaySeam().crashAt = "dispatched"
      const err = await apiErrorOf(ask(brain, f, key))
      expect([err.status, err.code]).toEqual([500, "internal"])
      delete gatewaySeam().crashAt
      expect(sent).toHaveLength(1)

      const retried = await ask(brain, f, key).then(
        (out) => ({ status: 200, code: null as string | null, out }),
        (e: { status: number; code: string }) => ({ status: e.status, code: e.code as string | null, out: null })
      )
      // Main: the retry ran committeeBrain again and the provider was called a second time.
      expect(sent).toHaveLength(1)
      expect([retried.status, retried.code]).toEqual([409, "idempotency_effect_committed"])
      // Re-audit LOW-1: the stored answer names the operation, for a 409 the handler raised too.
      expect((await keyDoc(f.firmId, key).get()).data()?.response).toEqual({ status: 409, body: committedBody(await operationIdOf(f.firmId, key), false) })
      expect(await byFirm("committee_outputs", f.firmId)).toHaveLength(0)
      // The spend is not lost: the reservation keeps its provider attempt, and the reconciler charges it (F08).
      const [reservation] = await byFirm("ai_reservations", f.firmId)
      expect(reservation!.data).toMatchObject({ state: "reserved", providerAttempt: { outcome: "pending" } })
      const again = await apiErrorOf(ask(brain, f, key))
      expect([again.status, again.code]).toEqual([409, "idempotency_effect_committed"])
      expect(sent).toHaveLength(1)
    })

    it("claim takeover after expiry: a stale holder that commits after the takeover is fenced; the effect commits once", async () => {
      const held = gate()
      const { op } = effectOp({
        before: async (run) => {
          if (run !== 1) return
          held.reached()
          await held.wait
        },
      })
      const t0 = freshMinute()
      const path = "/api/t/f09/takeover"
      const routerA = createRouter([route(path, op)], { now: () => t0 })
      const routerB = createRouter([route(path, op)], { now: () => pastLease(t0) })
      const { firmId, token } = await firmPartner()
      const key = randomUUID()
      const effectId = uniq("e")
      const a = send(routerA, { path, token, firmId, key, body: { effectId } })
      await held.arrived
      const b = await send(routerB, { path, token, firmId, key, body: { effectId } })
      expect([b.status, b.body]).toEqual([200, { effectId, run: 2 }])
      held.open()
      const outA = await a
      // Main: the stale holder committed its effect too.
      expect(await effectCount(effectId)).toBe(1)
      expect(outA.status).not.toBe(200)
      expect((await keyDoc(firmId, key).get()).data()).toMatchObject({ status: "done", response: { status: 200, body: { effectId, run: 2 } } })
    })

    it("committeeBrain claim takeover after expiry: a stale holder that reaches dispatch after the takeover is fenced; one provider call", async () => {
      const f = await brainFirm()
      const sent = stubTransport()
      const held = gate()
      let first = true
      gatewaySeam().beforeReserve = async () => {
        if (!first) return
        first = false
        held.reached()
        await held.wait
      }
      const key = randomUUID()
      const a = ask(brainAt(() => T), f, key).then(
        (out) => ({ ok: true as const, out }),
        (err: unknown) => ({ ok: false as const, err })
      )
      await held.arrived
      const b = await ask(brainAt(() => pastLease(T)), f, key)
      expect([b.blocked, b.text, sent.length]).toEqual([false, "REPLY", 1])
      held.open()
      const outA = await a
      // Main: the stale holder reserved and dispatched a second paid call.
      expect(sent).toHaveLength(1)
      expect(outA.ok).toBe(false)
      expect(await byFirm("committee_outputs", f.firmId)).toHaveLength(1)
      const replay = await ask(brainAt(() => pastLease(T)), f, key)
      expect(replay).toEqual({ ...b, reused: true })
    })
  })

  // -------------------------------------------------------------------------
  // Codex P1 on PR #58: a stale holder that commits after a takeover ended without an effect. Holder A stalls, its
  // lease lapses, B takes the claim over and answers non-storably before any effect, then A commits. At aacaae5 B's
  // release deleted the operation record, A's marker landed on no record, and the next same-key request deleted that
  // marker as "left from an expired operation" and committed the effect a second time.
  // -------------------------------------------------------------------------
  describe("a stale holder after a takeover that ended without an effect (Codex P1 on PR #58)", () => {
    /** Run 1 (A) waits at `a`; run 2 (B) waits at `b` when given, then answers 503 before any effect; later runs commit. */
    function staleHolderOp(a: ReturnType<typeof gate>, b?: ReturnType<typeof gate>) {
      return effectOp({
        before: async (run) => {
          if (run === 1) {
            a.reached()
            await a.wait
          }
          if (run === 2) {
            if (b) {
              b.reached()
              await b.wait
            }
            throw new HttpError(503, "audit_unavailable")
          }
        },
      })
    }

    it("A commits after B released: a third same-key request does not commit a second effect", async () => {
      const a = gate()
      const { op, runs } = staleHolderOp(a)
      const t0 = freshMinute()
      const path = "/api/t/f09/stale-after-release"
      const routerA = createRouter([route(path, op)], { now: () => t0 })
      const later = createRouter([route(path, op)], { now: () => pastLease(t0) })
      const { firmId, token } = await firmPartner()
      const key = randomUUID()
      const effectId = uniq("e")
      const outA = send(routerA, { path, token, firmId, key, body: { effectId } })
      await a.arrived
      const outB = await send(later, { path, token, firmId, key, body: { effectId } })
      expect([outB.status, errorOf(outB)]).toEqual([503, "audit_unavailable"])
      a.open()
      await outA
      expect(await effectCount(effectId)).toBe(1) // A's effect
      const outC = await send(later, { path, token, firmId, key, body: { effectId } })
      // aacaae5: B's release deleted the record, so C deleted A's marker as stale and committed the effect again.
      expect(await effectCount(effectId)).toBe(1)
      expect(runs.n).toBe(2)
      expect(outC.status).toBe(409)
      expect(outC.body).toEqual(committedBody(await operationIdOf(firmId, key)))
    })

    it("A commits before B releases: B's release finds A's marker and answers 409 idempotency_effect_committed; the effect commits once", async () => {
      const a = gate()
      const b = gate()
      const { op } = staleHolderOp(a, b)
      const t0 = freshMinute()
      const path = "/api/t/f09/stale-before-release"
      const routerA = createRouter([route(path, op)], { now: () => t0 })
      const later = createRouter([route(path, op)], { now: () => pastLease(t0) })
      const { firmId, token } = await firmPartner()
      const key = randomUUID()
      const effectId = uniq("e")
      const outA = send(routerA, { path, token, firmId, key, body: { effectId } })
      await a.arrived
      const outB = send(later, { path, token, firmId, key, body: { effectId } })
      await b.arrived
      a.open()
      await outA
      b.open()
      const answeredB = await outB
      const operationId = await operationIdOf(firmId, key)
      expect([answeredB.status, answeredB.body]).toEqual([409, committedBody(operationId, false)])
      const outC = await send(later, { path, token, firmId, key, body: { effectId } })
      expect(outC.body).toEqual(committedBody(operationId))
      expect(await effectCount(effectId)).toBe(1)
    })

    it("committeeBrain (re-audit ATK-2): A held before reserving; B takes over and fails before reserving; A dispatches, records its receipt and is fenced at publication; C resumes from A's receipt: one provider call, one usage row", async () => {
      vi.spyOn((await import("firebase-functions")).logger, "error").mockImplementation(() => undefined)
      const f = await brainFirm()
      const sent = stubTransport()
      const a = gate()
      let reserves = 0
      gatewaySeam().beforeReserve = async () => {
        reserves += 1
        if (reserves === 1) {
          a.reached()
          await a.wait
        } else if (reserves === 2) {
          throw new Error("B fails before reserving")
        }
      }
      const key = randomUUID()
      const outA = ask(brainAt(() => T), f, key).then(
        (out) => ({ ok: true as const, out }),
        (err: { status: number; code: string }) => ({ ok: false as const, err })
      )
      await a.arrived
      const errB = await apiErrorOf(ask(brainAt(() => pastLease(T)), f, key))
      expect([errB.status, errB.code]).toEqual([500, "internal"])
      a.open()
      const resA = await outA
      expect(resA.ok ? null : [resA.err.status, resA.err.code]).toEqual([409, "idempotency_claim_lost"])
      expect(sent).toHaveLength(1)
      const marker = (await markerDoc(f.firmId, key).get()).data()!
      expect(marker).toMatchObject({ kind: "p1_dispatch", result: { outcome: "ok", text: "REPLY" } })

      const c = await ask(brainAt(() => pastLease(T)), f, key)
      // aacaae5: B's release deleted the record, C deleted A's marker as stale and dispatched a second paid call.
      expect(sent).toHaveLength(1)
      expect(await byFirm("ai_usage_logs", f.firmId)).toHaveLength(1)
      expect(c).toMatchObject({ blocked: false, text: "REPLY", traceId: marker.traceId, accounting: "settled" })
      expect((await byFirm("committee_outputs", f.firmId)).map((o) => o.id)).toEqual([c.outputId])
    })

    it("a takeover that ends without an effect keeps the record (released): the same request runs again at once, another body is 422, and the stale holder is still fenced", async () => {
      const a = gate()
      const { op, runs } = staleHolderOp(a)
      const t0 = freshMinute()
      const path = "/api/t/f09/stale-tombstone"
      const routerA = createRouter([route(path, op)], { now: () => t0 })
      const later = createRouter([route(path, op)], { now: () => pastLease(t0) })
      const { firmId, token } = await firmPartner()
      const key = randomUUID()
      const effectId = uniq("e")
      const outA = send(routerA, { path, token, firmId, key, body: { effectId } })
      await a.arrived
      expect((await send(later, { path, token, firmId, key, body: { effectId } })).status).toBe(503)
      expect((await keyDoc(firmId, key).get()).data()).toMatchObject({ status: "in_progress", released: true, claims: 2 })
      const other = await send(later, { path, token, firmId, key, body: { effectId: uniq("other") } })
      expect([other.status, errorOf(other)]).toEqual([422, "idempotency_key_reused"])
      const outC = await send(later, { path, token, firmId, key, body: { effectId } })
      expect([outC.status, outC.body]).toEqual([200, { effectId, run: 3 }])
      a.open()
      expect((await outA).status).not.toBe(200)
      expect([runs.n, await effectCount(effectId)]).toEqual([3, 1])
    })
  })

  // -------------------------------------------------------------------------
  // The fault matrix: every effect/settlement boundary.
  // -------------------------------------------------------------------------
  describe("generic routes: every effect/settlement boundary", () => {
    it("the settle write fails for good after a 2xx: the key holds 409 in_progress during the lease, then answers 409 idempotency_effect_committed; the effect ran once", async () => {
      vi.spyOn((await import("firebase-functions")).logger, "error").mockImplementation(() => undefined)
      const { op, runs } = effectOp()
      const t0 = freshMinute()
      const path = "/api/t/f09/settle"
      const router = createRouter([route(path, op)], { now: () => t0 })
      const later = createRouter([route(path, op)], { now: () => pastLease(t0) })
      const { firmId, token } = await firmPartner()
      const key = randomUUID()
      const effectId = uniq("e")
      idemSeam().settleFailures = Array.from({ length: 4 }, () => new Error("injected settle failure"))
      const first = await send(router, { path, token, firmId, key, body: { effectId } })
      expect([first.status, first.body]).toEqual([200, { effectId, run: 1 }])
      expect(idemSeam().settleFailures).toEqual([])
      expect((await keyDoc(firmId, key).get()).data()).toMatchObject({ status: "in_progress" })
      const during = await send(router, { path, token, firmId, key, body: { effectId } })
      expect([during.status, errorOf(during)]).toEqual([409, "idempotency_in_progress"])
      const after = await send(later, { path, token, firmId, key, body: { effectId } })
      expect(after.status).toBe(409)
      expect(after.body).toEqual(committedBody(await operationIdOf(firmId, key)))
      expect(runs.n).toBe(1)
      expect(await effectCount(effectId)).toBe(1)
    })

    it("a real crash between the effect and settlement (the holder never returns): after the lease the key answers 409 idempotency_effect_committed, not a re-run", async () => {
      const held = gate()
      idemSeam().beforeSettle = async () => {
        held.reached()
        await held.wait
      }
      const { op, runs } = effectOp()
      const t0 = freshMinute()
      const path = "/api/t/f09/crash"
      const router = createRouter([route(path, op)], { now: () => t0 })
      const later = createRouter([route(path, op)], { now: () => pastLease(t0) })
      const { firmId, token } = await firmPartner()
      const key = randomUUID()
      const effectId = uniq("e")
      const crashed = send(router, { path, token, firmId, key, body: { effectId } })
      await held.arrived
      delete idemSeam().beforeSettle
      const after = await send(later, { path, token, firmId, key, body: { effectId } })
      expect(after.body).toEqual(committedBody(await operationIdOf(firmId, key)))
      expect(runs.n).toBe(1)
      expect(await effectCount(effectId)).toBe(1)
      // The holder wakes after the takeover: its settle no longer holds the claim and changes nothing.
      held.open()
      await crashed
      expect((await keyDoc(firmId, key).get()).data()).toMatchObject({ status: "done", response: { status: 409 } })
    })

    it("a refusal before any effect still releases the key: a same-key retry runs (a refreshed token, a later retry)", async () => {
      const { op, runs } = effectOp({
        before: (run) => {
          if (run === 1) throw new HttpError(503, "audit_unavailable")
        },
      })
      const router = createRouter([route("/api/t/f09/refusal", op)], { now: fixedClock() })
      const { firmId, token } = await firmPartner()
      const key = randomUUID()
      const effectId = uniq("e")
      const first = await send(router, { path: "/api/t/f09/refusal", token, firmId, key, body: { effectId } })
      expect([first.status, errorOf(first)]).toEqual([503, "audit_unavailable"])
      expect((await keyDoc(firmId, key).get()).exists).toBe(false)
      expect((await markerDoc(firmId, key).get()).exists).toBe(false)
      const second = await send(router, { path: "/api/t/f09/refusal", token, firmId, key, body: { effectId } })
      expect([second.status, second.body]).toEqual([200, { effectId, run: 2 }])
      expect([runs.n, await effectCount(effectId)]).toEqual([2, 1])
    })

    it("concurrent duplicate requests: one runs, the others get 409 in_progress or the replay; the effect commits once", async () => {
      const { op, runs } = effectOp({ before: () => sleep(50) })
      const router = createRouter([route("/api/t/f09/race", op)], { now: fixedClock() })
      const { firmId, token } = await firmPartner()
      const key = randomUUID()
      const effectId = uniq("e")
      const outs = await Promise.all([1, 2, 3].map(() => send(router, { path: "/api/t/f09/race", token, firmId, key, body: { effectId } })))
      expect(runs.n).toBe(1)
      expect(await effectCount(effectId)).toBe(1)
      expect(outs.filter((o) => o.status === 200 && !(o.body as { reused?: boolean }).reused)).toHaveLength(1)
      for (const o of outs.filter((x) => x.status !== 200)) expect(errorOf(o)).toBe("idempotency_in_progress")
    })

    it("the marker commits with the effect and names the operation; the stored answer keeps the operation id", async () => {
      const { op } = effectOp()
      const router = createRouter([route("/api/t/f09/marker", op)], { now: fixedClock() })
      const { firmId, token } = await firmPartner()
      const key = randomUUID()
      const out = await send(router, { path: "/api/t/f09/marker", token, firmId, key, body: { effectId: uniq("e") } })
      expect(out.status).toBe(200)
      const record = (await keyDoc(firmId, key).get()).data()!
      const marker = (await markerDoc(firmId, key).get()).data()!
      expect(record).toMatchObject({ status: "done", claims: 1 })
      expect(record.operationId).toMatch(/^[0-9a-f-]{36}$/)
      expect(marker).toMatchObject({ kind: "transaction", operationId: record.operationId, claimId: record.claimId, firmId, route: "POST /api/t/f09/marker" })
      expect((marker.expiresAt as Timestamp).toMillis()).toBe((record.expiresAt as Timestamp).toMillis())
    })

    it("a deny row staged without an effect creates no marker (a refusal stays re-runnable); one staged with { effect: true } does, and its stored 409 replays", async () => {
      const { firmId, token } = await firmPartner()
      const mk = (effect: boolean, code: string): Operation => ({
        auth: "firm",
        kind: "general",
        action: uniq("test.f09deny"),
        target: "t",
        run: async (_s, data, audit) => {
          await db().runTransaction(async (tx) => {
            await audit.stage(tx, "deny", code, effect ? { effect: true } : undefined)
            tx.set(db().collection("f09_effects").doc(String(data.effectId)), { n: FieldValue.increment(1) }, { merge: true })
          })
          audit.committed()
          throw new HttpError(409, code)
        },
      })
      const router = createRouter([route("/api/t/f09/deny-plain", mk(false, "check_stale")), route("/api/t/f09/deny-effect", mk(true, "gate_blocked"))], { now: fixedClock() })
      const plainKey = randomUUID()
      const plain = await send(router, { path: "/api/t/f09/deny-plain", token, firmId, key: plainKey, body: { effectId: uniq("e") } })
      expect([plain.status, errorOf(plain)]).toEqual([409, "check_stale"])
      expect((await keyDoc(firmId, plainKey).get()).exists).toBe(false)
      expect((await markerDoc(firmId, plainKey).get()).exists).toBe(false)
      const effectKey = randomUUID()
      const effectId = uniq("e")
      const blocked = await send(router, { path: "/api/t/f09/deny-effect", token, firmId, key: effectKey, body: { effectId } })
      expect([blocked.status, errorOf(blocked)]).toEqual([409, "gate_blocked"])
      expect((await markerDoc(firmId, effectKey).get()).exists).toBe(true)
      const replay = await send(router, { path: "/api/t/f09/deny-effect", token, firmId, key: effectKey, body: { effectId } })
      expect(replay.body).toEqual({ error: { code: "gate_blocked" }, reused: true })
      expect(await effectCount(effectId)).toBe(1)
    })

    it("a rerun route keeps the released-claim semantics: no marker, and a same-key retry runs again (its own idempotency is its guard, spec §4)", async () => {
      const { op, runs } = effectOp({ after: (run) => (run === 1 ? Promise.reject(new Error("post-commit step failed")) : { ok: true }) })
      const router = createRouter([route("/api/t/f09/rerun", op, { idempotency: "rerun" })], { now: fixedClock() })
      const { firmId, token } = await firmPartner()
      const key = randomUUID()
      const effectId = uniq("e")
      const first = await send(router, { path: "/api/t/f09/rerun", token, firmId, key, body: { effectId } })
      expect(first.status).toBe(500)
      expect((await markerDoc(firmId, key).get()).exists).toBe(false)
      const second = await send(router, { path: "/api/t/f09/rerun", token, firmId, key, body: { effectId } })
      expect([second.status, second.body]).toEqual([200, { ok: true }])
      expect([runs.n, await effectCount(effectId)]).toEqual([2, 2])
    })
  })

  describe("committeeBrain: every effect/settlement boundary", () => {
    /**
     * The receipt write (step 9b) fails `times` times at the store: every `update` of a marker with its `result` throws
     * inside the transaction, which aborts it (re-audit LOW-2). Returns how many failures are left to inject.
     */
    function failReceiptWrites(times: number): { left: () => number } {
      let left = times
      const realUpdate = Transaction.prototype.update
      vi.spyOn(Transaction.prototype, "update").mockImplementation(function (this: Transaction, ...args: unknown[]) {
        const [ref, data] = args as [DocumentReference, unknown]
        if (left > 0 && ref.path.startsWith("idempotency_effects/") && data !== null && typeof data === "object" && "result" in data) {
          left -= 1
          throw new Error("injected receipt write failure")
        }
        return (realUpdate as (...a: unknown[]) => Transaction).apply(this, args)
      })
      return { left: () => left }
    }

    it("re-audit LOW-2: the receipt write fails twice, then lands; the publication fails for good; the same-key retry resumes from the receipt with no second call", async () => {
      vi.spyOn((await import("firebase-functions")).logger, "error").mockImplementation(() => undefined)
      const f = await brainFirm()
      const sent = stubTransport()
      const brain = brainAt(() => T)
      const key = randomUUID()
      const receipt = failReceiptWrites(2)
      p1OpsTestSeam.sleep = async () => undefined
      p1OpsTestSeam.outputWriteFailures = [new Error("down"), new Error("down"), new Error("down")]
      const err = await apiErrorOf(ask(brain, f, key))
      expect([err.status, err.code]).toEqual([500, "internal"])
      // aacaae5 and 8b7f7ba: the first failure ended the fail-open write, so no receipt was recorded.
      expect(receipt.left()).toBe(0)
      expect((await markerDoc(f.firmId, key).get()).data()).toMatchObject({ result: { outcome: "ok", text: "REPLY" } })
      const resumed = await ask(brain, f, key)
      expect([resumed.blocked, resumed.text, sent.length]).toEqual([false, "REPLY", 1])
    })

    it("re-audit LOW-2: a receipt write that fails for good logs p1.receipt_record_failed naming the operation and the trace; the retry answers 409 with that operation id and no second call", async () => {
      const { logger } = await import("firebase-functions")
      const errors = vi.spyOn(logger, "error").mockImplementation(() => undefined)
      const f = await brainFirm()
      const sent = stubTransport()
      const brain = brainAt(() => T)
      const key = randomUUID()
      failReceiptWrites(1_000)
      p1OpsTestSeam.sleep = async () => undefined
      p1OpsTestSeam.outputWriteFailures = [new Error("down"), new Error("down"), new Error("down")]
      expect((await apiErrorOf(ask(brain, f, key))).status).toBe(500)
      const operationId = await operationIdOf(f.firmId, key)
      const marker = (await markerDoc(f.firmId, key).get()).data()!
      expect(marker.result).toBeUndefined()
      expect(errors).toHaveBeenCalledWith("p1.receipt_record_failed", expect.objectContaining({ firmId: f.firmId, operationId, traceId: marker.traceId, usageLogId: marker.usageLogId }))
      const retried = await apiErrorOf(ask(brain, f, key))
      expect([retried.status, retried.code, sent.length]).toEqual([409, "idempotency_effect_committed", 1])
      expect((await keyDoc(f.firmId, key).get()).data()?.response).toEqual({ status: 409, body: committedBody(operationId, false) })
    })

    it("a crash after the provider answered and its receipt was recorded: the same-key retry resumes from the receipt (one call), answers accounting pending, and the reconciler settles the stored answer", async () => {
      const f = await brainFirm()
      const sent = stubTransport()
      const brain = brainAt(() => T)
      const key = randomUUID()
      gatewaySeam().crashAt = "recorded"
      const err = await apiErrorOf(ask(brain, f, key))
      expect([err.status, err.code]).toEqual([500, "internal"])
      delete gatewaySeam().crashAt
      const marker = (await markerDoc(f.firmId, key).get()).data()!
      expect(marker).toMatchObject({ kind: "p1_dispatch", result: { outcome: "ok", text: "REPLY", inputTokens: 1000, outputTokens: 500, costMicroUsd: 14000 } })
      expect((await keyDoc(f.firmId, key).get()).data()).toMatchObject({ status: "in_progress", resumable: true })

      const resumed = await ask(brain, f, key)
      expect(sent).toHaveLength(1)
      // The call's commit never ran: its reservation still holds the spend, so the books are pending (F08).
      expect(resumed).toMatchObject({ blocked: false, text: "REPLY", accounting: "pending", traceId: marker.traceId, usage: { costMicroUsd: 14000 } })
      const [output] = await byFirm("committee_outputs", f.firmId)
      expect(output!.data).toMatchObject({ usageLogId: marker.usageLogId, accounting: "pending" })

      await reconcileAt(AFTER_RESERVATION_LEASE)
      expect((await db().collection("committee_outputs").doc(output!.id).get()).data()).toMatchObject({ accounting: "settled" })
      const replay = await ask(brain, f, key)
      expect([replay.reused, replay.outputId, replay.accounting, replay.text]).toEqual([true, resumed.outputId, "settled", "REPLY"])
      expect(sent).toHaveLength(1)
    })

    it("a real crash between the provider call and publication (the holder hangs): the takeover resumes from the receipt; the stale holder's later publication is fenced; one call, one output row", async () => {
      const f = await brainFirm()
      const sent = stubTransport()
      const held = gate()
      let first = true
      opsSeam().beforePublish = async () => {
        if (!first) return
        first = false
        held.reached()
        await held.wait
      }
      const key = randomUUID()
      const a = ask(brainAt(() => T), f, key).then(
        (out) => ({ ok: true as const, out }),
        (err: unknown) => ({ ok: false as const, err })
      )
      await held.arrived
      const b = await ask(brainAt(() => pastLease(T)), f, key)
      expect([b.blocked, b.text, b.accounting, sent.length]).toEqual([false, "REPLY", "settled", 1])
      held.open()
      const outA = await a
      expect(outA.ok).toBe(false)
      expect((outA as { err: { code?: string } }).err.code).toBe("idempotency_claim_lost")
      expect(sent).toHaveLength(1)
      expect((await byFirm("committee_outputs", f.firmId)).map((o) => o.id)).toEqual([b.outputId])
      expect(await byFirm("ai_usage_logs", f.firmId)).toHaveLength(1)
    })

    it("concurrent same-key requests: one provider call; the duplicate answers 409 idempotency_in_progress", async () => {
      const f = await brainFirm()
      const hold = gate()
      const sent = stubTransport(hold.wait)
      const brain = brainAt(() => T)
      const key = randomUUID()
      const first = ask(brain, f, key)
      while (sent.length === 0) await sleep(10)
      const dup = await apiErrorOf(ask(brain, f, key))
      expect([dup.status, dup.code]).toEqual([409, "idempotency_in_progress"])
      hold.open()
      expect((await first).text).toBe("REPLY")
      expect(sent).toHaveLength(1)
    })

    it("the answer commits with the output row: with every settle attempt failing, the key still holds the answer", async () => {
      vi.spyOn((await import("firebase-functions")).logger, "error").mockImplementation(() => undefined)
      const f = await brainFirm()
      const sent = stubTransport()
      const brain = brainAt(() => T)
      const key = randomUUID()
      idemSeam().settleFailures = Array.from({ length: 4 }, () => new Error("injected settle failure"))
      const first = await ask(brain, f, key)
      expect(idemSeam().settleFailures).toEqual([])
      const record = (await keyDoc(f.firmId, key).get()).data()!
      expect(record).toMatchObject({ status: "done", response: { status: 200, body: { ...first } } })
      expect(await ask(brain, f, key)).toEqual({ ...first, reused: true })
      expect(sent).toHaveLength(1)
    })

    it("a blocked call (no dispatch) records its marker with the output row and the answer", async () => {
      const f = await brainFirm()
      await firmConfigRef(f.firmId).set({})
      const sent = stubTransport()
      const key = randomUUID()
      const out = await ask(brainAt(() => T), f, key)
      expect([out.blocked, out.reason, sent.length]).toEqual([true, "budget_not_set", 0])
      expect((await markerDoc(f.firmId, key).get()).data()).toMatchObject({ kind: "transaction" })
      expect((await keyDoc(f.firmId, key).get()).data()).toMatchObject({ status: "done", response: { status: 200 } })
    })
  })

  // -------------------------------------------------------------------------
  // The wrapper's state machine, through withIdempotency itself.
  // -------------------------------------------------------------------------
  describe("withIdempotency: the operation record and its marker", () => {
    const ROUTE = "POST /api/t/f09/state"
    const NOW = Date.UTC(2026, 9, 16, 12, 0, 0)
    type Mode = "once" | "rerun" | "resume"
    const scope = (over: Record<string, unknown> = {}) => ({ firmId: uniq("firm"), uid: uniq("u"), route: ROUTE, key: randomUUID(), body: { a: 1 }, now: NOW, ...over }) as Parameters<typeof withIdempotency>[0] & { key: string; mode?: Mode }
    const ok = async () => ({ status: 200, body: { ran: true } })

    async function seedRecord(s: ReturnType<typeof scope>, doc: Record<string, unknown>) {
      await keyDoc(s.firmId, s.key).set({ firmId: s.firmId, uid: s.uid, route: ROUTE, requestHash: requestHash(s.body), ...doc })
    }
    async function seedMarker(s: ReturnType<typeof scope>, doc: Record<string, unknown>) {
      await markerDoc(s.firmId, s.key).set({ firmId: s.firmId, route: ROUTE, ...doc })
    }
    const lapsed = (operationId: string, extra: Record<string, unknown> = {}) => ({
      status: "in_progress",
      operationId,
      claimId: "dead-claim",
      claims: 1,
      claimedAt: Timestamp.fromMillis(NOW - IDEMPOTENCY_LEASE_MS - 1),
      createdAt: Timestamp.fromMillis(NOW - IDEMPOTENCY_LEASE_MS - 1),
      expiresAt: Timestamp.fromMillis(NOW - IDEMPOTENCY_LEASE_MS - 1 + IDEMPOTENCY_TTL_MS),
      ...extra,
    })

    it("once: a lapsed claim whose operation committed an effect answers 409 idempotency_effect_committed and stores it; the handler never runs", async () => {
      const s = scope()
      await seedRecord(s, lapsed("op-1"))
      await seedMarker(s, { operationId: "op-1", claimId: "dead-claim", kind: "transaction" })
      let ran = false
      const out = await withIdempotency(s, async () => {
        ran = true
        return { status: 200, body: {} }
      })
      expect(ran).toBe(false)
      expect(out).toEqual({ status: 409, body: committedBody("op-1") })
      expect((await keyDoc(s.firmId, s.key).get()).data()).toMatchObject({ status: "done", response: { status: 409, body: committedBody("op-1", false) } })
      await expect(withIdempotency(s, ok)).resolves.toEqual(out)
    })

    it("resume: the takeover runs the handler with the marker as `prior`, keeping the operation id and its window", async () => {
      const s = scope({ mode: "resume" })
      const rec = lapsed("op-2")
      await seedRecord(s, rec)
      await seedMarker(s, { operationId: "op-2", claimId: "dead-claim", kind: "p1_dispatch", usageLogId: "u-1", traceId: "t-1" })
      let prior: unknown
      await withIdempotency(s, async (op) => {
        prior = (op as unknown as { prior: unknown }).prior
        return { status: 200, body: { resumed: true } }
      })
      expect(prior).toMatchObject({ kind: "p1_dispatch", usageLogId: "u-1", traceId: "t-1" })
      const after = (await keyDoc(s.firmId, s.key).get()).data()!
      expect(after).toMatchObject({ status: "done", operationId: "op-2", claims: 2 })
      expect((after.expiresAt as Timestamp).toMillis()).toBe(rec.expiresAt.toMillis())
    })

    it("resumable: a holder that ended after its effect lets the next same-key request take over at once, within the lease", async () => {
      const s = scope({ mode: "resume" })
      await seedRecord(s, { ...lapsed("op-3"), claimedAt: Timestamp.fromMillis(NOW), resumable: true })
      await seedMarker(s, { operationId: "op-3", claimId: "dead-claim", kind: "p1_dispatch", usageLogId: "u", traceId: "t" })
      await expect(withIdempotency(s, ok)).resolves.toEqual({ status: 200, body: { ran: true } })
      const live = scope({ mode: "resume" })
      await seedRecord(live, { ...lapsed("op-4"), claimedAt: Timestamp.fromMillis(NOW) })
      await expect(withIdempotency(live, ok)).rejects.toMatchObject({ status: 409, code: "idempotency_in_progress" })
    })

    it("an expired marker of another operation does not count: the lapsed claim is taken over and runs", async () => {
      const s = scope()
      await seedRecord(s, lapsed("op-5"))
      await seedMarker(s, { operationId: "op-other", kind: "transaction", expiresAt: Timestamp.fromMillis(NOW - 1) })
      await expect(withIdempotency(s, ok)).resolves.toEqual({ status: 200, body: { ran: true } })
      expect((await markerDoc(s.firmId, s.key).get()).exists).toBe(false)
    })

    it("an unexpired marker is the key's committed effect whatever operation id it names (fail closed): a lapsed claim answers 409, the handler never runs", async () => {
      const s = scope()
      await seedRecord(s, lapsed("op-6"))
      await seedMarker(s, { operationId: "op-other", kind: "transaction", expiresAt: Timestamp.fromMillis(NOW + IDEMPOTENCY_TTL_MS) })
      let ran = false
      const out = await withIdempotency(s, async () => {
        ran = true
        return { status: 200, body: {} }
      })
      expect(ran).toBe(false)
      // The marker names the operation that committed: the answer and the record take its id.
      expect(out).toEqual({ status: 409, body: committedBody("op-other") })
    })

    it("an unexpired marker with no record (the record was lost) is adopted: once answers 409 without running, resume runs with it as `prior`", async () => {
      const once = scope()
      await seedMarker(once, { operationId: "op-lost", kind: "transaction", expiresAt: Timestamp.fromMillis(NOW + 60_000) })
      let ran = false
      const out = await withIdempotency(once, async () => {
        ran = true
        return { status: 200, body: {} }
      })
      expect([ran, out]).toEqual([false, { status: 409, body: committedBody("op-lost") }])
      expect((await keyDoc(once.firmId, once.key).get()).data()).toMatchObject({ status: "done", operationId: "op-lost", response: { status: 409 } })
      expect((await markerDoc(once.firmId, once.key).get()).exists).toBe(true)

      const resume = scope({ mode: "resume" })
      await seedMarker(resume, { operationId: "op-lost-2", kind: "p1_dispatch", usageLogId: "u", traceId: "t", expiresAt: Timestamp.fromMillis(NOW + 60_000) })
      let prior: unknown
      await withIdempotency(resume, async (op) => {
        prior = (op as unknown as { prior: unknown }).prior
        return { status: 200, body: { resumed: true } }
      })
      expect(prior).toMatchObject({ operationId: "op-lost-2", kind: "p1_dispatch" })
      expect((await keyDoc(resume.firmId, resume.key).get()).data()).toMatchObject({ status: "done", operationId: "op-lost-2" })
    })

    it("an expired operation's marker is deleted by the next fresh claim, so it never fences the new operation", async () => {
      const s = scope()
      await seedRecord(s, { ...lapsed("op-old"), status: "done", response: { status: 200, body: {} }, expiresAt: Timestamp.fromMillis(NOW - 1) })
      await seedMarker(s, { operationId: "op-old", kind: "transaction", expiresAt: Timestamp.fromMillis(NOW - 1) })
      const out = await withIdempotency(s, async (op) => {
        await db().runTransaction(async (tx) => {
          ;(op as unknown as { stageEffect: (tx: unknown) => void }).stageEffect(tx)
        })
        return { status: 200, body: { fresh: true } }
      })
      expect(out).toEqual({ status: 200, body: { fresh: true } })
      const record = (await keyDoc(s.firmId, s.key).get()).data()!
      expect(record.operationId).not.toBe("op-old")
      expect((await markerDoc(s.firmId, s.key).get()).data()).toMatchObject({ operationId: record.operationId })
    })

    it("a binding whose claim was taken over fails its fence read with 409 idempotency_claim_lost", async () => {
      const s = scope()
      await expect(
        withIdempotency(s, async (op) => {
          // Another attempt takes the claim over under this one.
          await keyDoc(s.firmId, s.key).update({ claimId: "someone-else" })
          await db().runTransaction(async (tx) => {
            await (op as unknown as { read: (tx: unknown) => Promise<unknown> }).read(tx)
          })
          return { status: 200, body: {} }
        })
      ).rejects.toMatchObject({ status: 409, code: "idempotency_claim_lost" })
    })

    it("with NODE_ENV production idempotencyTestSeam is inert: no injected settle failure, no settle hold", async () => {
      vi.stubEnv("NODE_ENV", "production")
      const s = scope()
      idemSeam().settleFailures = [new Error("injected")]
      let held = 0
      idemSeam().beforeSettle = async () => void (held += 1)
      await expect(withIdempotency(s, ok)).resolves.toEqual({ status: 200, body: { ran: true } })
      expect(idemSeam().settleFailures).toHaveLength(1)
      expect(held).toBe(0)
      expect((await keyDoc(s.firmId, s.key).get()).data()).toMatchObject({ status: "done" })
    })

    it("with NODE_ENV production p1OpsTestSeam.beforePublish and p1TestSeam.crashAt 'recorded' are inert", async () => {
      const f = await brainFirm()
      const sent = stubTransport()
      let held = 0
      opsSeam().beforePublish = async () => void (held += 1)
      gatewaySeam().crashAt = "recorded"
      vi.stubEnv("NODE_ENV", "production")
      const out = await ask(brainAt(() => T), f, randomUUID())
      expect([out.blocked, out.text, held, sent.length]).toEqual([false, "REPLY", 0, 1])
    })
  })
})
