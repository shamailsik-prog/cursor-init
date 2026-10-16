import { randomUUID } from "node:crypto"
import { FieldValue, Timestamp, type DocumentData } from "firebase-admin/firestore"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { adminDb } from "../src/admin"
import { firmConfigRef, platformConfigRef } from "../src/p1/config"
import { p1TestSeam } from "../src/p1/gateway"
import { setOpikFetchForTests } from "../src/p1/opik"
import { setP1TransportForTests } from "../src/p1/transport"
import { apiErrorOf, viaApi } from "./api"
import { EMULATORS, mintIdToken, uniq } from "./emu"

/**
 * Audit finding F15 (HIGH, 2026-10-13): "The PII mask is not a comprehensive confidentiality boundary". End to end
 * through the real HTTP router (`viaApi`: the `committeeBrain` route in ROUTES, the ID token, the session binding, the
 * rate limit and the Idempotency-Key) over the Auth and Firestore emulators; the provider is faked at the transport
 * boundary only (`setP1TransportForTests`), which records exactly what would leave the firm.
 *
 * The audit's failure scenario: a synthetic full-width CNIC and an Urdu-digit phone number passed the mask with zero
 * redactions, and `assertMinimised` re-ran the same detector, so it could not catch what the mask missed. Spec:
 * docs/superpowers/specs/2026-10-16-f15-pii-mask-normalisation-design.md.
 *
 * On main 0844ed8, (a) to (d), (e)'s first and malformed-receipt rows, and the round-2 attack rows (f) fail. The rest
 * are guards that pass on main too and must keep passing: (d') another firm's client record, (e)'s pre-F15 receipt,
 * the round-2 false-positive rows (g) and the timing row (h).
 *
 * Every name is invented; every number is synthetic.
 */

const T = Date.parse("2026-10-11T10:00:00.000Z")
const BIG = 1_000_000_000

type Member = { uid: string; token: string }
type Out = { outputId: string; blocked: boolean; reason?: string; text?: string; classification: string }
type Sent = { model: string; body: string; maxTokens: number }
type Firm = { firmId: string; matterId: string; P: Member }

const db = () => adminDb()
const createdFirms: string[] = []

/** A clock that moves a minute per request, so the per-user rate limit never trips. */
function spread() {
  let ms = T
  return { now: () => (ms += 61_000) }
}
const brain = viaApi<Out>("committeeBrain", spread())

function capture(text = "REPLY"): Sent[] {
  const sent: Sent[] = []
  setP1TransportForTests({
    async send(r) {
      sent.push({ ...r })
      return { text, inputTokens: 1000, outputTokens: 500 }
    },
  })
  return sent
}

type FirmOpts = {
  classification?: string
  parties?: Array<Record<string, unknown>>
  /** The matter's client record (`clients/{id}`), and the firm it belongs to (default: the matter's firm). */
  client?: { firmId?: string; data: Record<string, unknown> }
}

async function newFirm(o: FirmOpts = {}): Promise<Firm> {
  const firmId = uniq("firm")
  createdFirms.push(firmId)
  await db().collection("firms").doc(firmId).set({ name: "F", plan: "internal" })
  await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: BIG })
  const classification = o.classification ?? "internal"
  let clientId: string | undefined
  if (o.client) {
    clientId = uniq("client")
    await db().collection("clients").doc(clientId).set({ firmId: o.client.firmId ?? firmId, classification, type: "individual", ...o.client.data })
  }
  const matterId = uniq("matter")
  await db()
    .collection("matters")
    .doc(matterId)
    .set({ firmId, classification, title: "Recovery suit", stage: "pre_filing", status: "open", ...(clientId ? { clientId } : {}), createdAt: Timestamp.now() })
  for (const party of o.parties ?? []) {
    await db().collection("matter_parties").doc().set({ firmId, matterId, role: "opposing", classification, matterStatus: "live", ...party })
  }
  const P = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
  await db().collection("matter_members").doc(`${matterId}_${P.uid}`).set({ firmId, matterId, userId: P.uid, classification: "internal" })
  return { firmId, matterId, P }
}

const ask = (f: Firm, body: string) => brain({ token: f.P.token, data: { firmId: f.firmId, matterId: f.matterId, body } } as never)
const outputOf = async (outputId: string): Promise<DocumentData> => (await db().collection("committee_outputs").doc(outputId).get()).data()!
const usageOf = async (firmId: string): Promise<DocumentData[]> =>
  (await db().collection("ai_usage_logs").where("firmId", "==", firmId).get()).docs.map((d) => d.data())

/** Any decimal digit, in any script. */
const ANY_DIGIT = /\p{Nd}/u
const NO_RESIDUAL = { id_digits: 0, labelled_identifier: 0, address: 0, kinship_name: 0 }

describe.skipIf(!EMULATORS)("audit F15: the outbound mask and the minimisation check through committeeBrain (e2e)", () => {
  beforeEach(() => {
    vi.stubEnv("OPIK_BASE_URL", undefined)
    vi.stubEnv("OPIK_SELF_HOSTED_CONFIRMED", undefined)
    vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
    setProviderConfigForTests(null)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    setP1TransportForTests(null)
    setOpikFetchForTests(null)
    setProviderConfigForTests(null)
    await platformConfigRef().delete()
  })

  afterAll(async () => {
    await Promise.all(createdFirms.map((id) => db().collection("firms").doc(id).delete()))
  })

  it("(a) the audit's counterexample: a full-width CNIC, an Urdu-digit mobile and a CNIC split by zero-width spaces never reach the provider, and the output row records the counts", async () => {
    const f = await newFirm()
    const sent = capture()
    const body = "Client CNIC ３５２０２\uFF0D１２３４５６７\uFF0D１, mobile ۰۳۰۰-۱۲۳۴۵۶۷, old CNIC 35202\u200B1234567\u200B1 on file. Draft the bail grounds."
    const r = await ask(f, body)

    expect(r.blocked).toBe(false)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.body).toBe("Client CNIC [CNIC], mobile [PHONE], old CNIC [CNIC] on file. Draft the bail grounds.")
    // Nothing of the identifiers leaves: no digit of any script, no invisible character.
    expect(ANY_DIGIT.test(sent[0]!.body)).toBe(false)
    expect(sent[0]!.body).not.toContain("\u200B")

    const row = await outputOf(r.outputId)
    expect(row.outbound.body).toBe(sent[0]!.body)
    expect(row.outbound.metadata.redactionCounts).toEqual({ cnic: 2, phone: 1, party: 0, email: 0, iban: 0, ntn: 0, passport: 0 })
    expect(row.outbound.metadata.residualCounts).toEqual(NO_RESIDUAL)
    expect(JSON.stringify(row)).not.toMatch(/３５２０２|۰۳۰۰|35202/)
    const usage = await usageOf(f.firmId)
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ outcome: "ok", blockReason: null })
  })

  it("(b) a matter_parties name written with other case, spacing and Arabic letter variants is masked", async () => {
    const f = await newFirm({ parties: [{ name: "Tariq Zarvani", names: ["tariq zarvani"] }, { name: "طارق زروانی" }] })
    const sent = capture()
    // Upper case with two spaces; a no-break space; the Urdu spelling with Arabic yeh (U+064A) and a fatha.
    const r = await ask(f, "TARIQ  ZARVANI met tariq\u00A0zarvani; طَارق زرواني signed the reply.")

    expect(r.blocked).toBe(false)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.body).toBe("[PARTY] met [PARTY]; [PARTY] signed the reply.")
    const row = await outputOf(r.outputId)
    expect(row.outbound.metadata.redactionCounts).toMatchObject({ party: 3 })
  })

  it("(c) a privileged matter whose body carries an address or a parentage clause is blocked not_minimised, and the provider is never called", async () => {
    const f = await newFirm({ classification: "privileged" })
    // L18 §4.6 rank 3: an executed DPA lets privileged content out, under the minimisation obligation.
    setProviderConfigForTests({ "ai-gateway": { dpaExecuted: true, inRegion: true } })
    const sent = capture()

    const cases: Array<[string, Record<string, number>]> = [
      ["Draft bail grounds for the accused r/o House 12, Street 5, Lahore.", { address: 3 }],
      ["Draft bail grounds for the accused s/o Kamran.", { kinship_name: 1 }],
      ["ملزم ولد کامران ساکن لاہور کی ضمانت کی درخواست تیار کریں۔", { kinship_name: 1, address: 1 }],
    ]
    for (const [body, residual] of cases) {
      const r = await ask(f, body)
      expect({ blocked: r.blocked, reason: r.reason, classification: r.classification }, body).toEqual({
        blocked: true,
        reason: "not_minimised",
        classification: "privileged",
      })
      const row = await outputOf(r.outputId)
      expect(row.outbound.metadata.residualCounts, body).toEqual({ ...NO_RESIDUAL, ...residual })
    }
    expect(sent).toHaveLength(0)
    const usage = await usageOf(f.firmId)
    expect(usage.map((u) => [u.outcome, u.blockReason])).toEqual(cases.map(() => ["blocked", "not_minimised"]))

    // The control: the same privileged matter with a minimised body is allowed out.
    const ok = await ask(f, "Draft bail grounds for the accused; the son of the deceased is the complainant.")
    expect(ok.blocked).toBe(false)
    expect(sent).toHaveLength(1)
  })

  it("(d) the matter's client record names are masked though no matter_parties row or request names them", async () => {
    const f = await newFirm({
      client: { data: { canonicalName: "Qalvo Traders", companyName: "Qalvo Traders (Private) Limited", concernedPersonName: "Omer Daryani" } },
    })
    const sent = capture()
    const r = await ask(f, "QALVO TRADERS (PRIVATE) LIMITED, through omer daryani, asks whether Qalvo Traders may appeal.")

    expect(r.blocked).toBe(false)
    expect(sent[0]!.body).toBe("[PARTY], through [PARTY], asks whether [PARTY] may appeal.")
  })

  it("(d') another firm's client record is read by id and discarded, never used", async () => {
    const f = await newFirm({ client: { firmId: uniq("other-firm"), data: { canonicalName: "Nura Kalbani" } } })
    const sent = capture()
    await ask(f, "Nura Kalbani asks about the appeal.")
    expect(sent[0]!.body).toBe("Nura Kalbani asks about the appeal.")
  })

  // Audit F09's resume path publishes the output row from the attempt receipt on the operation's marker. A receipt
  // carries the residual counts with the redaction counts; one recorded before F15 has none and must still resume.
  describe("(e) the attempt receipt carries the residual counts (F09 resume)", () => {
    afterEach(() => {
      delete (p1TestSeam as Record<string, unknown>).crashAt
    })

    /** A call that crashes once its receipt is recorded; `edit` then changes the receipt; the same key resumes. */
    async function resumeAfter(edit: Record<string, unknown> | null): Promise<{ f: Firm; sent: Sent[]; resumed: Promise<Out> }> {
      const f = await newFirm()
      const sent = capture()
      const at = T + createdFirms.length * 3_600_000
      const fixed = viaApi<Out>("committeeBrain", { now: () => at })
      const key = randomUUID()
      const call = () => fixed({ token: f.P.token, data: { firmId: f.firmId, matterId: f.matterId, body: "Tariq s/o Kamran asks." }, headers: { "idempotency-key": key } } as never)
      ;(p1TestSeam as Record<string, unknown>).crashAt = "recorded"
      expect((await apiErrorOf(call())).status).toBe(500)
      delete (p1TestSeam as Record<string, unknown>).crashAt
      const marker = db().collection("idempotency_effects").doc(`${f.firmId}_${key}`)
      if (edit !== null) await marker.update(edit)
      return { f, sent, resumed: call() }
    }

    it("a receipt with residual counts publishes them on the output row", async () => {
      const { sent, resumed } = await resumeAfter(null)
      const out = await resumed
      expect(sent).toHaveLength(1)
      const row = await outputOf(out.outputId)
      expect(row.outbound.metadata.residualCounts).toEqual({ ...NO_RESIDUAL, kinship_name: 1 })
    })

    it("a receipt recorded before F15 (no residual counts) still resumes, and its row has none", async () => {
      const { sent, resumed } = await resumeAfter({ "result.outbound.residualCounts": FieldValue.delete() })
      const out = await resumed
      expect(sent).toHaveLength(1)
      const row = await outputOf(out.outputId)
      expect(row.outbound.metadata.redactionCounts).toMatchObject({ party: 0 })
      expect(row.outbound.metadata).not.toHaveProperty("residualCounts")
    })

    // Codex P2 on #61: an object-shaped but malformed value fails closed too, not only a non-object.
    it.each([
      ["a string", "none"],
      ["a non-count value", { ...NO_RESIDUAL, address: "none" }],
      ["a negative count", { ...NO_RESIDUAL, address: -1 }],
      ["a fractional count", { ...NO_RESIDUAL, kinship_name: 0.5 }],
      ["a missing kind", { id_digits: 0, labelled_identifier: 0, address: 0 }],
      ["an unknown kind", { ...NO_RESIDUAL, nickname: 0 }],
    ])("a receipt whose residual counts are malformed (%s) is not published: 409 idempotency_effect_committed, no second call", async (_label, malformed) => {
      const { f, sent, resumed } = await resumeAfter({ "result.outbound.residualCounts": malformed })
      const err = await apiErrorOf(resumed)
      expect([err.status, err.code]).toEqual([409, "idempotency_effect_committed"])
      expect(sent).toHaveLength(1)
      expect((await db().collection("committee_outputs").where("firmId", "==", f.firmId).get()).size).toBe(0)
    })
  })

  // Re-audit round 1 (FAIL 6/10): the re-auditor's attack inputs through the privileged route (spec rulings R2-1 to R2-4).
  describe("(f) round 2: identifiers the re-auditor sent to the provider at rank 3 are masked, or the call is blocked", () => {
    const CNIC = "3520212345671"
    const PHONE = "03001234567"
    const sep = (digits: string, s: string) => [...digits].join(s)

    it.each([
      ["a CNIC with U+034F between every digit", `Client CNIC ${sep(CNIC, "\u034F")}. Draft the bail grounds.`, "Client CNIC [CNIC]. Draft the bail grounds."],
      ["a mobile with VS16 between every digit", `Client mobile ${sep(PHONE, "\uFE0F")}. Draft the bail grounds.`, "Client mobile [PHONE]. Draft the bail grounds."],
      ["a mobile with a spaced dash", "Client can be reached at 0300 - 1234567. Draft the bail grounds.", "Client can be reached at [PHONE]. Draft the bail grounds."],
      ["a landline with a bracketed area code", "Client office (042) 35761234. Draft the bail grounds.", "Client office [PHONE]. Draft the bail grounds."],
      ["NTN No.", "Client NTN No. 1234567-8. Draft the reply.", "Client [NTN]. Draft the reply."],
    ])("%s: the provider receives no digit of it", async (_label, body, expected) => {
      const f = await newFirm({ classification: "privileged" })
      setProviderConfigForTests({ "ai-gateway": { dpaExecuted: true, inRegion: true } })
      const sent = capture()
      const r = await ask(f, body)
      expect(r.blocked).toBe(false)
      expect(sent).toHaveLength(1)
      expect(sent[0]!.body).toBe(expected)
      expect(ANY_DIGIT.test(sent[0]!.body)).toBe(false)
    })

    it("a parentage clause after a party role and a name is blocked not_minimised, and the provider is never called", async () => {
      const f = await newFirm({ classification: "privileged" })
      setProviderConfigForTests({ "ai-gateway": { dpaExecuted: true, inRegion: true } })
      const sent = capture()
      const r = await ask(f, "The son of the deceased Kamran was examined. Draft the cross.")
      expect([r.blocked, r.reason]).toEqual([true, "not_minimised"])
      expect(sent).toHaveLength(0)
      const row = await outputOf(r.outputId)
      expect(row.outbound.metadata.residualCounts).toEqual({ ...NO_RESIDUAL, kinship_name: 1 })
    })
  })

  describe("(g) round 2: clean privileged prose the re-auditor saw blocked is allowed out", () => {
    it.each([
      ["an Urdu sentence with a kinship word before a postposition", "اس کی زوجہ نے عدالت میں بیان دیا۔ جواب تیار کریں۔"],
      ["son of Respondent No. 2", "The petitioner is the son of Respondent No. 2. Draft the grounds."],
      ["residents of a territory", "Are residents of Islamabad Capital Territory governed by the ICT Rent Restriction Ordinance?"],
    ])("%s", async (_label, body) => {
      const f = await newFirm({ classification: "privileged" })
      setProviderConfigForTests({ "ai-gateway": { dpaExecuted: true, inRegion: true } })
      const sent = capture()
      const r = await ask(f, body)
      expect(r.blocked).toBe(false)
      expect(sent).toHaveLength(1)
      expect(sent[0]!.body).toBe(body)
    })
  })

  it("(h) round 2: a 100,000-character body that was quadratic (house + spaces) is answered well inside the pre-call allowance", async () => {
    const f = await newFirm()
    const sent = capture()
    const started = Date.now()
    const r = await ask(f, `house${" ".repeat(99_990)}x`)
    // Before the fix this request spent 12.5 s in the residual check and answered 503 precall_deadline.
    expect(r.blocked).toBe(false)
    expect(sent).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(8_000)
  })
})
