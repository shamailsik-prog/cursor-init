import { randomUUID } from "node:crypto"
import { FieldValue, Timestamp, type DocumentData } from "firebase-admin/firestore"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { adminDb } from "../src/admin"
import { AuthorityUnavailableError, InMemoryAuthorityStore, setAuthorityStoreForTests, type AuthorityStore } from "../src/d4/authority"
import { firmConfigRef, platformConfigRef } from "../src/p1/config"
import { p1TestSeam } from "../src/p1/gateway"
import { setOpikFetchForTests } from "../src/p1/opik"
import { p1OpsTestSeam } from "../src/p1/ops"
import { setP1TransportForTests } from "../src/p1/transport"
import { apiErrorOf, viaApi } from "./api"
import { EMULATORS, mintIdToken, uniq } from "./emu"

/**
 * Audit finding F17 (HIGH, 2026-10-13): "LLM outputs lack grounding and semantic evaluation evidence". End to end through
 * the real HTTP router (`viaApi`: the `committeeBrain` route in ROUTES, the ID token, the session binding, the rate limit
 * and the Idempotency-Key) over the Auth and Firestore emulators; the provider is faked at the transport boundary only
 * (`setP1TransportForTests`), and the corpus is the F05 store the route reads (`setAuthorityStoreForTests`, or none).
 *
 * On main b48f79d a fluent answer citing a fabricated authority is stored and returned as a plain success: no
 * grounding, no advisory flag, no reported model. Spec: docs/superpowers/specs/2026-10-17-f17-grounded-committee-output-design.md,
 * ruling 7. This file imports nothing that is new in F17, so it loads on main and its assertions are what fail there.
 * Every name is invented; every citation is synthetic (2099).
 */

const T = Date.parse("2026-10-11T10:00:00.000Z")
const BIG = 1_000_000_000
const OPUS = "anthropic/claude-opus-5.5"

type Citation = { ref: string; kind: string; source: string; status: string; judgmentId: string | null }
type Grounding = { status: string; rules: string; policy: unknown; claims: { total: number; supported: number }; citations: Citation[]; omitted: number }
type Out = {
  outputId: string
  blocked: boolean
  reason?: string
  text?: string
  classification: string
  grounding?: Grounding
  advisory?: boolean
  model?: string
  modelReported?: string | null
  modelMatch?: boolean
  reused?: boolean
}
type Member = { uid: string; token: string }
type Firm = { firmId: string; matterId: string; P: Member }

const db = () => adminDb()
const createdFirms: string[] = []

function spread() {
  let ms = T
  return { now: () => (ms += 61_000) }
}
const brain = viaApi<Out>("committeeBrain", spread())

/** A stub Gateway answering `text`, reporting `model` when given; it records every call. */
function capture(text: string, model?: unknown): unknown[] {
  const sent: unknown[] = []
  setP1TransportForTests({
    async send(r) {
      sent.push(JSON.parse(JSON.stringify(r)))
      return { text, inputTokens: 1000, outputTokens: 500, ...(model === undefined ? {} : { model }) } as never
    },
  })
  return sent
}

async function newFirm(parties: string[] = []): Promise<Firm> {
  const firmId = uniq("firm")
  createdFirms.push(firmId)
  await db().collection("firms").doc(firmId).set({ name: "F", plan: "internal" })
  await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: BIG })
  const matterId = uniq("matter")
  await db().collection("matters").doc(matterId).set({ firmId, classification: "internal", title: "Bail application", stage: "pre_filing", status: "open", createdAt: Timestamp.now() })
  for (const name of parties) await db().collection("matter_parties").doc().set({ firmId, matterId, role: "client", classification: "internal", matterStatus: "live", name })
  const P = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
  await db().collection("matter_members").doc(`${matterId}_${P.uid}`).set({ firmId, matterId, userId: P.uid, classification: "internal" })
  return { firmId, matterId, P }
}

const BODY = "Can the accused be granted bail where the case calls for further inquiry?"
const ask = (f: Firm, key?: string) =>
  brain({ token: f.P.token, data: { firmId: f.firmId, matterId: f.matterId, body: BODY }, ...(key === undefined ? {} : { headers: { "idempotency-key": key } }) } as never)
const outputOf = async (outputId: string): Promise<DocumentData> => (await db().collection("committee_outputs").doc(outputId).get()).data()!
const usageOf = async (id: string): Promise<DocumentData> => (await db().collection("ai_usage_logs").doc(id).get()).data()!

/** A contract-shaped answer whose one claim cites `citation`. */
const answerCiting = (citation: string, statement = "The Supreme Court held that bail follows where the case calls for further inquiry.") =>
  JSON.stringify({
    sections: [
      {
        heading: "Bail on further inquiry",
        text: "Where the prosecution case calls for further inquiry, the court leans towards bail.",
        claims: [{ statement, authorities: [{ kind: "judgment", citation, pinpoint: "para 9" }] }],
      },
    ],
    caveats: ["The facts of the matter may distinguish the authority."],
  })

/** The seeded corpus (P4-13: the year 2099, no real judgment): one good law, one overruled by a larger bench. */
function corpus(): InMemoryAuthorityStore {
  const s = new InMemoryAuthorityStore()
  s.addJudgment("j-good", "PLD 2099 SC 101", "division")
  s.addJudgment("j-old", "2099 SCMR 202", "division")
  s.addJudgment("j-larger", "PLD 2099 SC 303", "larger")
  s.addTreatment("j-larger", "j-old", "overruled", "larger")
  return s
}

describe.skipIf(!EMULATORS)("audit F17: grounded committee output through committeeBrain (e2e)", () => {
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
    setP1TransportForTests(null)
    setOpikFetchForTests(null)
    setProviderConfigForTests(null)
    setAuthorityStoreForTests(null)
    delete (p1OpsTestSeam as Record<string, unknown>).groundingBudgetMs
    await platformConfigRef().delete()
  })

  afterAll(async () => {
    await Promise.all(createdFirms.map((id) => db().collection("firms").doc(id).delete()))
  })

  it("(a) a fluent answer citing a fabricated authority is stored and returned ungrounded and advisory; the call itself is still a recorded success", async () => {
    const f = await newFirm()
    const fabricated = answerCiting("PLD 2099 SC 7777")
    const sent = capture(fabricated, OPUS)
    const key = randomUUID()
    const r = await ask(f, key)

    // The provider call succeeded and was charged: that is recorded, apart from whether the content can be trusted.
    expect(r.blocked).toBe(false)
    expect(r.text).toBe(fabricated)
    expect(sent).toHaveLength(1)
    const row = await outputOf(r.outputId)
    const usage = await usageOf(row.usageLogId as string)
    expect([usage.outcome, usage.costMicroUsd > 0]).toEqual(["ok", true])

    // Main: no grounding, no advisory flag.
    expect(r.grounding?.status, "grounding status").toBe("ungrounded")
    expect(r.advisory, "advisory").toBe(true)
    expect(r.grounding?.claims).toEqual({ total: 1, supported: 0 })
    expect(r.grounding?.citations).toEqual([{ ref: "PLD 2099 SC 7777", kind: "judgment", source: "claim", status: "UNVERIFIED", judgmentId: null }])
    expect(r.grounding?.policy).toEqual(row.outbound.system)
    expect(row.grounding).toEqual(r.grounding)
    expect(row.advisory).toBe(true)
    expect(row.text).toBe(fabricated)

    // A same-key replay returns the stored answer, grounding included, with no second call.
    expect(await ask(f, key)).toEqual({ ...r, reused: true })
    expect(sent).toHaveLength(1)
  })

  it("(b) an unstructured answer is stored and returned `unstructured`, advisory, its text masked as before", async () => {
    const f = await newFirm(["Tariq Zarvani"])
    capture("Tariq Zarvani should apply for bail at once; the Supreme Court said so in PLD 2099 SC 7777.")
    const r = await ask(f)

    expect(r.blocked).toBe(false)
    expect(r.text).toBe("[PARTY] should apply for bail at once; the Supreme Court said so in PLD 2099 SC 7777.")
    expect(r.grounding?.status, "grounding status").toBe("unstructured")
    expect(r.advisory).toBe(true)
    expect(r.grounding?.citations).toEqual([{ ref: "PLD 2099 SC 7777", kind: "judgment", source: "text", status: "UNVERIFIED", judgmentId: null }])
    const row = await outputOf(r.outputId)
    expect(row.grounding).toEqual(r.grounding)
    expect(JSON.stringify([row, r])).not.toMatch(/Tariq|Zarvani/)
  })

  describe("(c) against a seeded corpus (the F05 store the route reads)", () => {
    it("a claim citing a present, not overruled judgment is grounded and not advisory", async () => {
      setAuthorityStoreForTests(corpus())
      const f = await newFirm()
      capture(answerCiting("PLD 2099 SC 101"))
      const r = await ask(f)
      expect(r.grounding?.status, "grounding status").toBe("grounded")
      expect(r.advisory).toBe(false)
      expect(r.grounding?.claims).toEqual({ total: 1, supported: 1 })
      expect(r.grounding?.citations).toEqual([{ ref: "PLD 2099 SC 101", kind: "judgment", source: "claim", status: "VERIFIED", judgmentId: "j-good" }])
      expect((await outputOf(r.outputId)).advisory).toBe(false)
    })

    // Review round (Codex P1 on PR #63): the Codex example, a present judgment's citation declared as a statute.
    it("a claim whose only authority is a judgment's citation declared `statute` is not grounded, and advisory", async () => {
      setAuthorityStoreForTests(corpus())
      const f = await newFirm()
      const text = JSON.stringify({
        sections: [{ heading: "Bail", text: "", claims: [{ statement: "Bail follows on further inquiry.", authorities: [{ kind: "statute", citation: "PLD 2099 SC 101" }] }] }],
        caveats: [],
      })
      capture(text)
      const r = await ask(f)
      expect(r.blocked).toBe(false)
      expect(r.grounding?.status, "grounding status").toBe("ungrounded")
      expect(r.advisory).toBe(true)
      expect(r.grounding?.claims).toEqual({ total: 1, supported: 0 })
      expect(r.grounding?.citations).toEqual([{ ref: "PLD 2099 SC 101", kind: "statute", source: "claim", status: "UNVERIFIED", judgmentId: null, kindMismatch: true }])
      const row = await outputOf(r.outputId)
      expect([row.grounding.status, row.advisory]).toEqual(["ungrounded", true])
    })

    it("a claim citing a judgment overruled by a larger bench is not grounded", async () => {
      setAuthorityStoreForTests(corpus())
      const f = await newFirm()
      capture(answerCiting("2099 SCMR 202"))
      const r = await ask(f)
      expect(r.grounding?.status, "grounding status").toBe("ungrounded")
      expect(r.advisory).toBe(true)
      expect(r.grounding?.citations).toEqual([{ ref: "2099 SCMR 202", kind: "judgment", source: "claim", status: "OVERRULED", judgmentId: "j-old" }])
    })

    it.each([
      ["cannot answer (F05 unavailable)", () => Promise.reject(new AuthorityUnavailableError("unreachable"))],
      ["fails with a bug-class error", () => Promise.reject(new Error("corpus driver bug"))],
      ["hangs past the grounding budget", () => new Promise<never>(() => undefined)],
    ])("a store that %s never loses the answer: published, unverifiable, advisory", async (_label, lookup) => {
      const broken: AuthorityStore = { findJudgment: lookup, listTreatments: lookup, getSectionAsAt: lookup }
      setAuthorityStoreForTests(broken)
      ;(p1OpsTestSeam as Record<string, unknown>).groundingBudgetMs = 200
      const f = await newFirm()
      const text = answerCiting("PLD 2099 SC 101")
      capture(text)
      const r = await ask(f)
      expect(r.blocked).toBe(false)
      expect(r.text).toBe(text)
      expect(r.grounding?.status, "grounding status").toBe("unverifiable")
      expect(r.advisory).toBe(true)
      expect((await outputOf(r.outputId)).text).toBe(text)
    })
  })

  describe("(d) the F09 resume path", () => {
    afterEach(() => {
      delete (p1TestSeam as Record<string, unknown>).crashAt
    })

    /** A call that crashes once its receipt is recorded; `edit` then changes the receipt; the same key resumes. */
    async function resumeAfter(text: string, edit: Record<string, unknown> | null): Promise<{ f: Firm; sent: unknown[]; resumed: Promise<Out> }> {
      const f = await newFirm()
      const sent = capture(text, OPUS)
      const at = T + createdFirms.length * 3_600_000
      const fixed = viaApi<Out>("committeeBrain", { now: () => at })
      const key = randomUUID()
      const call = () => fixed({ token: f.P.token, data: { firmId: f.firmId, matterId: f.matterId, body: BODY }, headers: { "idempotency-key": key } } as never)
      ;(p1TestSeam as Record<string, unknown>).crashAt = "recorded"
      expect((await apiErrorOf(call())).status).toBe(500)
      delete (p1TestSeam as Record<string, unknown>).crashAt
      const marker = db().collection("idempotency_effects").doc(`${f.firmId}_${key}`)
      if (edit !== null) await marker.update(edit)
      return { f, sent, resumed: call() }
    }

    it("the resumed answer is graded from the receipt's text, with no second provider call", async () => {
      const { sent, resumed } = await resumeAfter(answerCiting("PLD 2099 SC 7777"), null)
      const out = await resumed
      expect(sent).toHaveLength(1)
      expect(out.grounding?.status, "grounding status").toBe("ungrounded")
      expect(out.advisory).toBe(true)
      expect([out.model, out.modelReported, out.modelMatch]).toEqual([OPUS, OPUS, true])
      const row = await outputOf(out.outputId)
      expect(row.grounding).toEqual(out.grounding)
      expect(row.modelReported).toBe(OPUS)
    })

    it("a receipt recorded before F17 (no reported model) still resumes: graded from its text (prose: unstructured), advisory", async () => {
      const { sent, resumed } = await resumeAfter("Draft the reply to the notice within the period.", { "result.modelReported": FieldValue.delete() })
      const out = await resumed
      expect(out.blocked).toBe(false)
      expect(sent).toHaveLength(1)
      expect(out.grounding?.status, "grounding status").toBe("unstructured")
      expect(out.advisory).toBe(true)
      expect([out.modelReported, out.modelMatch]).toEqual([null, false])
    })

    it("a receipt recorded before F17 whose text is the contract with no citation resumes not_assessed", async () => {
      const plain = JSON.stringify({ sections: [{ heading: "Reply", text: "Draft the reply within the period.", claims: [] }], caveats: [] })
      const { resumed } = await resumeAfter(plain, { "result.modelReported": FieldValue.delete() })
      const out = await resumed
      expect(out.grounding?.status, "grounding status").toBe("not_assessed")
      expect(out.advisory).toBe(true)
    })

    it.each([
      ["a grounding claim (receipts never carry one)", { "result.grounding": { status: "grounded", citations: [] } }],
      ["a reported model that is not a model id", { "result.modelReported": "the best model there is" }],
      ["a reported model that is not a string", { "result.modelReported": 42 }],
    ])("a receipt with %s is not published: 409 idempotency_effect_committed, no second call", async (_label, edit) => {
      const { f, sent, resumed } = await resumeAfter(answerCiting("PLD 2099 SC 7777"), edit)
      const err = await apiErrorOf(resumed)
      expect([err.status, err.code]).toEqual([409, "idempotency_effect_committed"])
      expect(sent).toHaveLength(1)
      expect((await db().collection("committee_outputs").where("firmId", "==", f.firmId).get()).size).toBe(0)
    })
  })

  describe("(e) model identity is recorded, never assumed", () => {
    it.each([
      ["the configured id", OPUS, OPUS, true],
      ["the id without its provider prefix", "claude-opus-5.5", "claude-opus-5.5", true],
      ["another model", "vendor/other-model-1", "vendor/other-model-1", false],
      ["nothing", undefined, null, false],
      ["something that is not a model id", "<b>model</b>", null, false],
    ])("the provider reports %s", async (_label, reported, modelReported, modelMatch) => {
      const f = await newFirm()
      capture(answerCiting("PLD 2099 SC 7777"), reported)
      const r = await ask(f)
      expect(r.blocked).toBe(false)
      expect({ model: r.model, modelReported: r.modelReported, modelMatch: r.modelMatch }).toEqual({ model: OPUS, modelReported, modelMatch })
      const row = await outputOf(r.outputId)
      expect({ model: row.model, modelReported: row.modelReported, modelMatch: row.modelMatch }).toEqual({ model: OPUS, modelReported, modelMatch })
    })
  })
})
