import { createHash } from "node:crypto"
import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { SYSTEM_POLICIES, SYSTEM_POLICY_VERSION } from "@/platform/p1/systemPolicy"
import { adminDb } from "../src/admin"
import { InMemoryAuthorityStore, setAuthorityStoreForTests } from "../src/d4/authority"
import { firmConfigRef, platformConfigRef, reservationRef } from "../src/p1/config"
import * as gateway from "../src/p1/gateway"
import { callP1, p1TestSeam, type P1Request } from "../src/p1/gateway"
import { setOpikFetchForTests } from "../src/p1/opik"
import { reconcileReservations } from "../src/p1/reconciler"
import { setP1TransportForTests } from "../src/p1/transport"
import { viaApi } from "./api"
import { EMULATORS, mintIdToken, uniq } from "./emu"

/**
 * Audit finding F34 (HIGH, 2026-10-13): "AI and workflow traces cannot establish decision reproducibility". End to end
 * over the Auth and Firestore emulators: `committeeBrain` through the real HTTP router (`viaApi`), `callP1` for the
 * reconciler paths, the provider faked at the transport boundary only, the corpus the F05 store the route reads, and
 * Opik faked at its fetch. Spec: docs/superpowers/specs/2026-10-24-f34-decision-trace-reproducibility-design.md.
 *
 * On main f39d007 no durable record names the prompt template, the prompt hash, the model revision, the retrieval
 * anchors or the phase timings; a failed export is a log line only; and confidential and privileged text reaches the
 * trace payload. This file imports nothing new in F34 statically (the reconstruction query and the export reconciler are
 * imported where they are used), so it loads on main and its assertions are what fail there. Every name, citation and
 * marker is invented.
 */

const T = Date.parse("2026-10-11T10:00:00.000Z")
const BIG = 1_000_000_000
const OPUS = "anthropic/claude-opus-5.5"
const HEX64 = /^[0-9a-f]{64}$/
/**
 * Planted markers: not PII, so the mask leaves them, which is the point (masking is not redaction of substance). Plain
 * lower-case words, so neither the residual detector nor the grounding's prose reader takes them for an identifier or a
 * case number.
 */
const PLANTED_BODY = "zanzibar quokka privileged strategy"
const PLANTED_ANSWER = "marigold sentinel planted answer"

const db = () => adminDb()
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
const afterLease = () => T + (gateway as unknown as { RESERVATION_LEASE_MS: number }).RESERVATION_LEASE_MS + 1_000

type Msg = { role: string; content: string }
type Out = { outputId: string; blocked: boolean; reason?: string; text?: string; traceId: string; classification: string }
type Member = { uid: string; token: string }
type Firm = { firmId: string; matterId: string; P: Member }

function spread() {
  let ms = T
  return { now: () => (ms += 61_000) }
}
const brain = viaApi<Out>("committeeBrain", spread())

/** The prompt hash the spec defines (R3): SHA-256 of the canonical JSON of the masked messages as sent, `[[role, content], ...]`. */
const promptHashOf = (messages: Msg[]) => sha256(JSON.stringify(messages.map((m) => [m.role, m.content])))

/** A stub Gateway with an id, answering `text` with a reported model and a response id; it records every request. */
function gatewayStub(text: string): Msg[][] {
  const sent: Msg[][] = []
  setP1TransportForTests({
    id: "f34-fake-gateway",
    async send(r: { messages: Msg[] }) {
      sent.push(JSON.parse(JSON.stringify(r.messages)) as Msg[])
      return { text, inputTokens: 1000, outputTokens: 500, model: "claude-opus-5.5", responseId: "resp-f34-1" }
    },
  } as never)
  return sent
}

/** Enables Opik (self-hosted, confirmed) with a fake fetch; `status` may change between posts. */
function fakeOpik(status: { code: number } = { code: 204 }): { bodies: string[] } {
  vi.stubEnv("OPIK_BASE_URL", "http://opik.test.internal")
  vi.stubEnv("OPIK_SELF_HOSTED_CONFIRMED", "true")
  const bodies: string[] = []
  setOpikFetchForTests((async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body))
    return new Response(null, { status: status.code })
  }) as typeof fetch)
  return { bodies }
}

const createdFirms: string[] = []

async function newFirm(classification = "internal", parties: string[] = []): Promise<Firm> {
  const firmId = uniq("firm")
  createdFirms.push(firmId)
  await db().collection("firms").doc(firmId).set({ name: "F", plan: "internal" })
  await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: BIG })
  const matterId = uniq("matter")
  await db().collection("matters").doc(matterId).set({ firmId, classification, title: "Bail application", stage: "pre_filing", status: "open", createdAt: Timestamp.now() })
  for (const name of parties) await db().collection("matter_parties").doc().set({ firmId, matterId, role: "client", classification, matterStatus: "live", name })
  const P = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
  await db().collection("matter_members").doc(`${matterId}_${P.uid}`).set({ firmId, matterId, userId: P.uid, classification })
  return { firmId, matterId, P }
}

const ask = (f: Firm, body: string) => brain({ token: f.P.token, data: { firmId: f.firmId, matterId: f.matterId, body } } as never)
const outputOf = async (outputId: string): Promise<DocumentData> => (await db().collection("committee_outputs").doc(outputId).get()).data()!
const decisionOf = async (usageLogId: string): Promise<DocumentData | undefined> => (await db().collection("p1_decisions").doc(usageLogId).get()).data()

const answerCiting = (citation: string) =>
  JSON.stringify({
    sections: [
      {
        heading: "Bail on further inquiry",
        text: `Where the prosecution case calls for further inquiry, the court leans towards bail. ${PLANTED_ANSWER}`,
        claims: [{ statement: "The Supreme Court held that bail follows where the case calls for further inquiry.", authorities: [{ kind: "judgment", citation, pinpoint: "para 9" }] }],
      },
    ],
    caveats: ["The facts of the matter may distinguish the authority."],
  })

function corpus(): InMemoryAuthorityStore {
  const s = new InMemoryAuthorityStore()
  s.addJudgment("j-good", "PLD 2099 SC 101", "division")
  return s
}

const BODY = "Can the accused be granted bail where the case calls for further inquiry?"

/** The reconstruction query (spec R13), imported where it is used so this file loads on main. */
async function reconstruct(key: { traceId?: string; usageLogId?: string }): Promise<Record<string, unknown> | null> {
  const mod = (await import("../src/p1/decisionRecord").catch(() => null)) as {
    reconstructP1Decision?: (db: unknown, key: { traceId?: string; usageLogId?: string }) => Promise<Record<string, unknown> | null>
  } | null
  expect(mod?.reconstructP1Decision, "the reconstruction query exists (spec R13)").toBeTypeOf("function")
  return mod!.reconstructP1Decision!(db(), key)
}

/** The operator CLI (spec R13), imported where it is used. */
async function decisionCli(): Promise<{
  runDecisionCli: (deps: { argv: readonly string[]; out: (line: string) => void; db: () => unknown }) => Promise<number>
}> {
  const mod = (await import("../src/cli/p1Decision").catch(() => null)) as Awaited<ReturnType<typeof decisionCli>> | null
  expect(mod?.runDecisionCli, "the operator CLI exists (spec R13)").toBeTypeOf("function")
  return mod!
}

/** The export reconciler (spec R11), imported where it is used. */
async function exportReconciler(): Promise<{
  reconcileTraceExports: (opts: { now: () => number }) => Promise<{ exported: string[]; rescheduled: string[]; abandoned: string[]; skipped: string[] }>
  traceExportTestSeam: { afterClaim?: (usageLogId: string) => Promise<void> }
}> {
  const mod = (await import("../src/p1/traceExport").catch(() => null)) as Awaited<ReturnType<typeof exportReconciler>> | null
  expect(mod?.reconcileTraceExports, "the export reconciler exists (spec R11)").toBeTypeOf("function")
  return mod!
}

const req = (firmId: string, extra: Partial<P1Request> = {}): P1Request => ({
  firmId,
  actorId: "uid-1",
  matterId: "matter-1",
  jobId: null,
  taskType: "committee",
  classification: "internal",
  body: "Draft a reply to the notice.",
  purpose: "committee-brain",
  ...extra,
})

async function seedFirm(): Promise<string> {
  const firmId = uniq("firm")
  createdFirms.push(firmId)
  await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: BIG })
  return firmId
}

describe.skipIf(!EMULATORS)("audit F34: a durable, redacted decision record for every P1 attempt (e2e)", () => {
  beforeEach(() => {
    vi.stubEnv("OPIK_BASE_URL", undefined)
    vi.stubEnv("OPIK_SELF_HOSTED_CONFIRMED", undefined)
    vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
    vi.stubEnv("SIKANDER_CORPUS_READER_URL", undefined)
    setProviderConfigForTests(null)
    setAuthorityStoreForTests(null)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    for (const k of Object.keys(p1TestSeam)) delete (p1TestSeam as Record<string, unknown>)[k]
    setP1TransportForTests(null)
    setOpikFetchForTests(null)
    setAuthorityStoreForTests(null)
    setProviderConfigForTests(null)
    await platformConfigRef().delete()
  })

  afterAll(async () => {
    for (const firmId of createdFirms) {
      for (const c of ["p1_decisions", "ai_usage_logs", "ai_reservations", "committee_outputs", "events", "audit_log", "ai_usage_months"]) {
        const snap = await db().collection(c).where("firmId", "==", firmId).get()
        await Promise.all(snap.docs.map((d) => d.ref.delete()))
      }
      await firmConfigRef(firmId).delete()
    }
  })

  it("a committee answer leaves a decision record that names the template, the prompt hash, the model revision, the anchors, the verdicts, the phases, the cost and the export", async () => {
    const f = await newFirm()
    setAuthorityStoreForTests(corpus())
    const opik = fakeOpik()
    const sent = gatewayStub(answerCiting("PLD 2099 SC 101"))
    const out = await ask(f, BODY)
    expect(out.blocked).toBe(false)
    expect(sent).toHaveLength(1)

    const row = await outputOf(out.outputId)
    const usageLogId = row.usageLogId as string
    const d = await decisionOf(usageLogId)
    expect(d, "a decision record exists for the attempt (spec R1)").toBeDefined()
    expect(d).toMatchObject({ recordVersion: "f34.2", traceId: out.traceId, usageLogId, firmId: f.firmId, matterId: f.matterId, taskType: "committee", classification: "internal", outcome: "ok", blockReason: null })

    // R3: the registered template, its pinned hash, and the hash of exactly what the provider received.
    expect(d!.prompt).toMatchObject({
      templateId: "committee-brain",
      templateVersion: SYSTEM_POLICY_VERSION,
      templateSha256: sha256(SYSTEM_POLICIES["committee-brain"].text),
      hash: promptHashOf(sent[0]!),
      hashAlgorithm: "sha256/p1-messages-v1",
      messageCount: 2,
    })
    // R4: the configured model, the revision the provider reported, the transport and the gateway version.
    expect(d!.model).toMatchObject({ configured: OPUS, reported: "claude-opus-5.5", revisionStatus: "reported", provider: "ai-gateway", transport: "f34-fake-gateway", responseId: "resp-f34-1" })
    expect(d!.model.gatewayVersion).toMatch(/^f34\./)
    // R5: no retrieved context went into the prompt; the judgment that graded the answer is anchored with a facts hash.
    expect(d!.retrieval.context).toEqual({ state: "none", anchors: [] })
    expect(d!.retrieval.verification.anchors).toEqual([{ sourceId: "judgment:j-good", ref: "PLD 2099 SC 101", status: "VERIFIED", factsSha256: expect.stringMatching(HEX64) }])
    expect(d!.retrieval.verification).toMatchObject({ groundingStatus: "grounded", groundingRules: expect.any(String) })
    // R6: the policy verdicts, as fixed tokens.
    expect(d!.decisions).toMatchObject({
      killSwitch: { platform: "clear", firm: "clear" },
      systemVerified: true,
      route: { classification: "internal", rank: 1, provider: "ai-gateway", allowed: true, minimisationRequired: false },
      budget: { firstLook: "fits", reservation: "reserved" },
      credentials: "present",
      attemptRecord: "recorded",
    })
    expect(d!.decisions.budget.worstCaseMicroUsd).toBeGreaterThan(0)
    // R7: every phase the call reached, timed.
    for (const phase of ["firstReadsMs", "maskMs", "reserveMs", "attemptRecordMs", "transportMs", "attemptOutcomeMs", "traceMs"]) {
      expect(d!.phases[phase], phase).toBeGreaterThanOrEqual(0)
    }
    expect(d!.phases.settleStartedAtMs).toBeGreaterThan(0)
    expect(d!.settledAt).toBeInstanceOf(Timestamp)
    // R8: the cost, linked to the usage and spend records.
    const usage = (await db().collection("ai_usage_logs").doc(usageLogId).get()).data()!
    expect(d!.cost).toMatchObject({ inputTokens: 1000, outputTokens: 500, tokensEstimated: false, costMicroUsd: usage.costMicroUsd, monthKey: usage.monthKey })
    expect(d!.cost.spendRecord).toBe(`ai_usage_months/${f.firmId}_${usage.monthKey}`)
    // R9 and R11: no approval path; the export landed.
    expect(d!.approval).toEqual({ state: "no_approval_path", ref: null })
    expect(d!.output).toMatchObject({ outputId: out.outputId, advisory: false, groundingStatus: "grounded" })
    expect(d!.export).toMatchObject({ state: "exported", attempts: 1 })
    expect(opik.bodies).toHaveLength(1)

    // Redacted: the record holds no prompt or answer text.
    const stored = JSON.stringify(d)
    for (const text of [BODY, PLANTED_ANSWER, SYSTEM_POLICIES["committee-brain"].text.slice(0, 40)]) expect(stored).not.toContain(text)

    // R13: the reconstruction joins the durable records from the trace id alone, and checks them.
    const r = await reconstruct({ traceId: out.traceId })
    expect(r).not.toBeNull()
    expect(r!.checks).toEqual({
      decisionPresent: true,
      usageJoined: true,
      reservationJoined: true,
      outputJoined: true,
      templatePinned: true,
      promptHashMatchesOutput: true,
      exportState: "exported",
    })
    expect(r!.key).toEqual({ usageLogId, traceId: out.traceId })
    expect((r!.output as Record<string, unknown>).outputId).toBe(out.outputId)
    expect(r!.events).toEqual(["ai.call.completed"])
    expect(JSON.stringify(r)).not.toContain(PLANTED_ANSWER)
    expect(JSON.stringify(r)).not.toContain(BODY)
    expect(await reconstruct({ usageLogId })).toEqual(r)

    // The operator CLI prints the same join as JSON, Timestamps as ISO strings.
    const { runDecisionCli } = await decisionCli()
    const lines: string[] = []
    expect(await runDecisionCli({ argv: ["--trace", out.traceId], out: (l) => lines.push(l), db })).toBe(0)
    const printed = JSON.parse(lines.join("\n")) as { checks: unknown; decision: { settledAt: unknown } }
    expect(printed.checks).toEqual(r!.checks)
    expect(printed.decision.settledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("the operator CLI refuses a malformed request and reports an unknown attempt as not found", async () => {
    const { runDecisionCli } = await decisionCli()
    const lines: string[] = []
    expect(await runDecisionCli({ argv: [], out: (l) => lines.push(l), db })).toBe(64)
    expect(await runDecisionCli({ argv: ["--trace"], out: (l) => lines.push(l), db })).toBe(64)
    expect(await runDecisionCli({ argv: ["--other", "x"], out: (l) => lines.push(l), db })).toBe(64)
    expect(await runDecisionCli({ argv: ["--usage", "no-such-usage-row"], out: (l) => lines.push(l), db })).toBe(2)
    expect(await runDecisionCli({ argv: ["--trace", "01a12a67-0000-7000-8000-000000000000"], out: (l) => lines.push(l), db })).toBe(2)
    expect(await runDecisionCli({ argv: ["--usage", "../escape"], out: (l) => lines.push(l), db })).toBe(2)
  })

  it("the facts hash of an anchor changes when the corpus changes what the verdict read", async () => {
    const f = await newFirm()
    const store = corpus()
    setAuthorityStoreForTests(store)
    gatewayStub(answerCiting("PLD 2099 SC 101"))
    const first = await ask(f, BODY)
    store.addJudgment("j-later", "PLD 2099 SC 909", "single")
    store.addTreatment("j-later", "j-good", "followed", "single")
    const second = await ask(f, BODY)
    const anchorOf = async (out: Out) => (await decisionOf((await outputOf(out.outputId)).usageLogId))!.retrieval.verification.anchors[0]
    const [a, b] = [await anchorOf(first), await anchorOf(second)]
    expect(a.sourceId).toBe(b.sourceId)
    expect(a.factsSha256).not.toBe(b.factsSha256)
  })

  it("a blocked call is recorded with the verdict that refused it and no dispatch phases", async () => {
    const f = await newFirm()
    await firmConfigRef(f.firmId).set({ killSwitch: { disableAll: true, disabledModels: [], reason: "stop", setBy: "uid-x", setAt: Timestamp.fromMillis(T) } }, { merge: true })
    const sent = gatewayStub("UNUSED")
    const out = await ask(f, BODY)
    expect([out.blocked, out.reason, sent.length]).toEqual([true, "kill_switch_firm", 0])
    const usageLogId = (await outputOf(out.outputId)).usageLogId as string
    const d = await decisionOf(usageLogId)
    expect(d).toMatchObject({ outcome: "blocked", blockReason: "kill_switch_firm", prompt: { templateId: "committee-brain", templateVersion: SYSTEM_POLICY_VERSION } })
    expect(d!.decisions).toMatchObject({ killSwitch: { platform: "clear", firm: "blocks" }, systemVerified: null, budget: { firstLook: "not_reached", reservation: "not_attempted" }, credentials: "not_checked", attemptRecord: "not_attempted" })
    expect(d!.phases).toMatchObject({ reserveMs: null, attemptRecordMs: null, transportMs: null, attemptOutcomeMs: null })
    expect(d!.model).toMatchObject({ reported: null, revisionStatus: "unreported" })
    expect(d!.export).toMatchObject({ state: "disabled", attempts: 0 })
    const r = await reconstruct({ usageLogId })
    expect(r!.checks).toMatchObject({ decisionPresent: true, usageJoined: true, reservationJoined: false, outputJoined: true, templatePinned: true, exportState: "disabled" })
  })

  it.each([
    ["confidential", 2],
    ["privileged", 3],
  ])("a %s call (rank %i) exports ids and metrics only: the planted text never reaches the trace", async (classification) => {
    setProviderConfigForTests({ "ai-gateway": { dpaExecuted: true, inRegion: true } })
    const f = await newFirm(classification)
    setAuthorityStoreForTests(corpus())
    const opik = fakeOpik()
    gatewayStub(answerCiting("PLD 2099 SC 101"))
    const out = await ask(f, `${BODY} ${PLANTED_BODY}`)
    expect([out.blocked, out.classification]).toEqual([false, classification])
    expect(opik.bodies).toHaveLength(1)
    const payload = opik.bodies[0]!
    expect(payload).not.toContain(PLANTED_BODY)
    expect(payload).not.toContain(PLANTED_ANSWER)
    expect(payload).not.toContain("further inquiry")
    const trace = (JSON.parse(payload) as { traces: Record<string, unknown>[] }).traces[0]!
    expect("input" in trace).toBe(false)
    expect("output" in trace).toBe(false)
    expect(trace.metadata).toMatchObject({ classification, promptTemplateId: "committee-brain", promptTemplateVersion: SYSTEM_POLICY_VERSION })
    // Re-audit R1-001 (spec ruling R15): the prompt hash is a dictionary oracle on a short body, so it never leaves at
    // ranks 2 to 4 (functions/test/f34-fu-r1.e2e.emu.test.ts runs the attack).
    expect(trace.metadata).not.toHaveProperty("promptHash")
  })

  it("an internal call still carries its masked text, and the metadata names the template and the prompt hash", async () => {
    const f = await newFirm("internal", ["Tariq Zarvani"])
    const opik = fakeOpik()
    gatewayStub("Tariq Zarvani may apply.")
    await ask(f, `Tariq Zarvani asks about bail. ${PLANTED_BODY}`)
    const trace = (JSON.parse(opik.bodies[0]!) as { traces: Record<string, unknown>[] }).traces[0]!
    expect(trace.input).toMatchObject({ prompt: `[PARTY] asks about bail. ${PLANTED_BODY}` })
    expect(trace.output).toEqual({ text: "[PARTY] may apply." })
    expect(opik.bodies[0]).not.toContain("Tariq")
    expect(trace.metadata).toMatchObject({ promptHash: expect.stringMatching(HEX64), promptTemplateId: "committee-brain" })
  })

  it("a failed export is durable: pending, retried by the fenced reconciler, then exported without text", async () => {
    const firmId = await seedFirm()
    const status = { code: 500 }
    const opik = fakeOpik(status)
    gatewayStub("ANSWER WITH INTERNAL TEXT")
    const warn = vi.spyOn(logger, "warn")
    const r = await callP1(req(firmId), { now: () => T })
    expect(r.outcome).toBe("ok")
    expect(warn).toHaveBeenCalledWith("p1.trace_export_failed", { firmId, usageLogId: r.usageLogId, traceId: r.traceId })
    const d = await decisionOf(r.usageLogId)
    expect(d?.export, "an export failure leaves durable state (spec R11)").toMatchObject({ state: "pending", attempts: 1, lastCode: "export_failed" })
    expect(d!.export.nextAttemptAt).toBeInstanceOf(Timestamp)

    const { reconcileTraceExports, traceExportTestSeam } = await exportReconciler()
    // Not due yet: nothing is tried.
    expect((await reconcileTraceExports({ now: () => T + 60_000 })).exported).not.toContain(r.usageLogId)
    expect(opik.bodies).toHaveLength(1)

    // Leased: a second run while the first holds the record does not touch it. Fenced: a run that lost its lease to
    // another run between the claim and the result writes nothing.
    status.code = 204
    const seen: { concurrent?: Awaited<ReturnType<typeof reconcileTraceExports>> } = {}
    traceExportTestSeam.afterClaim = async (usageLogId) => {
      if (usageLogId !== r.usageLogId || seen.concurrent !== undefined) return
      seen.concurrent = await reconcileTraceExports({ now: () => T + 6 * 60_000 })
      await db().collection("p1_decisions").doc(usageLogId).update({ "export.leaseToken": "another-run" })
    }
    const fenced = await reconcileTraceExports({ now: () => T + 6 * 60_000 })
    expect(seen.concurrent?.skipped).toContain(r.usageLogId)
    expect(seen.concurrent?.exported).not.toContain(r.usageLogId)
    expect(fenced.exported).not.toContain(r.usageLogId)
    expect((await decisionOf(r.usageLogId))!.export).toMatchObject({ state: "pending", attempts: 1, leaseToken: "another-run" })
    delete traceExportTestSeam.afterClaim

    // Once the lease lapses, the retry posts a metadata-only trace with the same id and records the export.
    const done = await reconcileTraceExports({ now: () => T + 8 * 60_000 })
    expect(done.exported).toContain(r.usageLogId)
    const retried = opik.bodies.map((b) => (JSON.parse(b) as { traces: Record<string, unknown>[] }).traces[0]!).filter((t) => t.id === r.traceId)
    const last = retried[retried.length - 1]!
    expect("input" in last).toBe(false)
    expect("output" in last).toBe(false)
    expect(JSON.stringify(last)).not.toContain("ANSWER WITH INTERNAL TEXT")
    expect((await decisionOf(r.usageLogId))!.export).toMatchObject({ state: "exported", attempts: 2 })
    expect((await decisionOf(r.usageLogId))!.export.leaseToken).toBeUndefined()
  })

  it("an export that keeps failing ends in a recorded failed state with an ERROR line, never silently", async () => {
    const firmId = await seedFirm()
    fakeOpik({ code: 503 })
    gatewayStub("ANSWER")
    const r = await callP1(req(firmId), { now: () => T })
    const { reconcileTraceExports } = await exportReconciler()
    const error = vi.spyOn(logger, "error")
    let now = T
    for (let i = 0; i < 6; i++) {
      now += 3 * 60 * 60_000
      await reconcileTraceExports({ now: () => now })
    }
    const e = (await decisionOf(r.usageLogId))!.export
    expect(e).toMatchObject({ state: "failed", attempts: 5, lastCode: "export_failed" })
    expect(e.abandonedAt).toBeInstanceOf(Timestamp)
    // Other suites' pending records may be due in the shared emulator too: only this record's line is asserted.
    const abandoned = error.mock.calls.filter((c) => c[0] === "p1.trace_export_abandoned" && (c[1] as { usageLogId?: string }).usageLogId === r.usageLogId)
    expect(abandoned).toEqual([["p1.trace_export_abandoned", { firmId, usageLogId: r.usageLogId, traceId: r.traceId, attempts: 5, code: "export_failed" }]])
    expect((await reconstruct({ usageLogId: r.usageLogId }))!.checks).toMatchObject({ exportState: "failed" })
  })

  it("a call whose commit failed gets its decision record from the lease reconciler", async () => {
    const firmId = await seedFirm()
    const sent = gatewayStub("ANSWER")
    p1TestSeam.failCommit = true
    const r = await callP1(req(firmId), { now: () => T })
    p1TestSeam.failCommit = false
    expect([r.outcome, r.accounting]).toEqual(["ok", "pending"])
    expect(await decisionOf(r.usageLogId)).toBeUndefined()
    expect((await reservationRef(r.usageLogId).get()).get("decisionSeed.prompt.hash"), "the reservation carries the seed (spec R2)").toBe(promptHashOf(sent[0]!))
    expect((await reconcileReservations({ now: () => afterLease() })).settled).toContain(r.usageLogId)
    const d = await decisionOf(r.usageLogId)
    expect(d).toMatchObject({
      traceId: r.traceId,
      outcome: "reconciled",
      settledBy: "reconciler",
      prompt: { templateId: "committee-brain", templateVersion: SYSTEM_POLICY_VERSION, hash: promptHashOf(sent[0]!) },
      model: { configured: OPUS, reported: "claude-opus-5.5", revisionStatus: "reported", transport: "f34-fake-gateway" },
      cost: { inputTokens: 1000, outputTokens: 500 },
      export: { state: "disabled" },
    })
    expect(d!.phases.transportMs).toBeGreaterThanOrEqual(0)
    const rec = await reconstruct({ traceId: r.traceId })
    expect(rec!.checks).toMatchObject({ decisionPresent: true, usageJoined: true, reservationJoined: true, templatePinned: true })
  })
})
