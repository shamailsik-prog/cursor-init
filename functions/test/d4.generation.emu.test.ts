import { FieldPath, Timestamp, type DocumentData } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { afterEach, describe, expect, it, vi } from "vitest"
import { adminDb } from "../src/admin"
import { encodeCursor } from "../src/d1/pagination"
import { RESERVED_TOKEN } from "../src/d4/generations"
import { firmConfigRef } from "../src/p1/config"
import { setOpikFetchForTests } from "../src/p1/opik"
import { activeTransport, setP1TransportForTests } from "../src/p1/transport"
import * as auditModule from "../src/p5/audit"
import { apiErrorOf, viaApi } from "./api"
import { EMULATORS, mintIdToken, uniq } from "./emu"

/**
 * Phase 4b (spec P4B-1, P4B-8, P4B-13, P4B-14, P4B-16, P4B-18, P4B-21): draft generation through the HTTP router over
 * the Auth and Firestore emulators. This file holds the fixtures and the helpers that every Phase 4b emulator test
 * uses (Tasks 3 and 4 add their describe blocks below the entry-route one); each test makes its own firm, and every
 * stored value is read back with the Admin SDK, so a response alone never proves a write.
 *
 * The bindings that only a later task uses are exported, so the unused-binding lint rule holds until then.
 */

// ---------------------------------------------------------------------------
// Fixtures (P4B-21): citations use the year 2099, CNICs and phones are all nines, parties are fictitious.
// ---------------------------------------------------------------------------

export const TYPE = "constitutional_petition_199" // template_cp_199_v1; courts BHC, IHC, LHC, PHC, SHC
export const DEED = "sale_deed" // NON_FORUM; requiredFields include "exactLandDescription"
export const PERSON = "Ardeshir Testani"
export const INSTITUTION = "Federation of Testlandia through the Secretary, Ministry of Fixtures"
export const CNIC = "99999-9999999-9"
export const CNIC_PLAIN = "9999999999999"
export const PHONE = "0399-9999999"
export const OWN_CITATION = "PLD 2099 SC 101"
export const NEW_CITATION = "2099 SCMR 7"
export const LAND = "Plot 99-T, Block Z, Test Housing Scheme, measuring 999 square yards"
export const FACTS = `The petitioner ${PERSON} (CNIC ${CNIC}, mobile ${PHONE}) challenges the order of the ${INSTITUTION} dated 1 January 2099, relying on ${OWN_CITATION}.`

const TITLE = "Petition against the impugned order"
const MAX = "privileged-restricted"
const BIG_BUDGET = 1_000_000_000
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Firms and members
// ---------------------------------------------------------------------------

/** A signed-in member: the route helpers read the firm from it, so a call is `helper(member, data)`. */
export type Member = { uid: string; token: string; firmId: string }

export type Firm = {
  firmId: string
  matterId: string
  P: Member
  A: Member
  C: Member
  intern: Member
  accounts: Member
  client: Member
  /** An associate member cleared to `internal` only. */
  low: Member
  /** A partner of the firm who is not a member of the matter. */
  outsider: Member
}

const claims = (firmId: string, role: string, clearanceLevel = MAX) => ({ firmId, role, clearanceLevel })

async function addMember(firmId: string, matterId: string, uid: string): Promise<void> {
  await adminDb().collection("matter_members").doc(`${matterId}_${uid}`).set({ firmId, matterId, userId: uid, classification: "internal" })
}

async function seedMatter(firmId: string, classification: string, o: { courtId?: string; status?: string } = {}): Promise<string> {
  const matterId = uniq("matter")
  await adminDb()
    .collection("matters")
    .doc(matterId)
    .set({ firmId, classification, title: "Recovery suit", stage: "pre_filing", status: o.status ?? "open", courtId: o.courtId ?? "SHC", createdAt: Timestamp.now() })
  return matterId
}

/**
 * A firm with one matter (labelled `label`, in the Sindh High Court) and a member of each role, cleared to
 * `privileged-restricted`: P, A, C, intern, accounts and client; `low`, an associate member cleared to `internal`; and
 * `outsider`, a partner who is not a member. The firm's rate limits are high (one firm serves a whole test) and its
 * AI budget is large.
 */
export async function newFirm(label = "internal"): Promise<Firm> {
  const firmId = uniq("firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal", rateLimits: { general: 1000, p1: 1000 } })
  await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: BIG_BUDGET })
  const matterId = await seedMatter(firmId, label)
  const mint = async (role: string, clearance = MAX, member = true): Promise<Member> => {
    const m = await mintIdToken(claims(firmId, role, clearance))
    if (member) await addMember(firmId, matterId, m.uid)
    return { uid: m.uid, token: m.token, firmId }
  }
  const [P, A, C, intern, accounts, client, low, outsider] = [
    await mint("partner"),
    await mint("associate"),
    await mint("clerk"),
    await mint("intern"),
    await mint("accounts"),
    await mint("client"),
    await mint("associate", "internal"),
    await mint("partner", MAX, false),
  ]
  return { firmId, matterId, P, A, C, intern, accounts, client, low, outsider }
}

/** Another matter of the firm, with P, A, C and `low` as members. */
async function extraMatter(f: Firm, o: { classification?: string; courtId?: string; status?: string } = {}): Promise<string> {
  const matterId = await seedMatter(f.firmId, o.classification ?? "internal", o)
  for (const m of [f.P, f.A, f.C, f.low]) await addMember(f.firmId, matterId, m.uid)
  return matterId
}

// ---------------------------------------------------------------------------
// Routes: one helper per route, `(member, data, headers?)`, sending `{ firmId, ...data }` through the router
// ---------------------------------------------------------------------------

export type StartOut = { generationId: string; stage: string; classification: string; outlineVersion: number }
/** A brief as getGeneration returns it. */
export type GenerationJson = { generationId: string; [field: string]: unknown }
export type PageJson<T> = { items: T[]; nextCursor: string | null }

/** The route `name` as a function of one call, built on first use. */
function route<T>(name: string): (c: never) => Promise<T> {
  let api: ((c: never) => Promise<T>) | undefined
  return (c) => (api ??= viaApi<T>(name))(c)
}

const through =
  <T>(api: (c: never) => Promise<T>) =>
  (m: Member, data: Record<string, unknown> = {}, headers?: Record<string, string>): Promise<T> =>
    api({ token: m.token, data: { firmId: m.firmId, ...data }, headers } as never)

export const startApi = through(route<StartOut>("startDraft"))
export const getGenerationApi = through(route<GenerationJson>("getGeneration"))
export const listGenerationsApi = through(route<PageJson<GenerationJson>>("listGenerations"))

/** startDraft on the firm's matter with valid fields, `over` laid on top (an `undefined` removes a field), as `member`. */
export const start = (f: Firm, over: Record<string, unknown> = {}, member: Member = f.A): Promise<StartOut> =>
  startApi(member, { matterId: f.matterId, documentTypeId: TYPE, title: TITLE, facts: FACTS, ...over })

// ---------------------------------------------------------------------------
// The P1 transport, the outline and the logs
// ---------------------------------------------------------------------------

/** What the transport was sent, one entry per request. */
export type Sent = { model: string; body: string; maxTokens: number }
export type Answer = { text: string | ((body: string) => string); finishReason?: string | null; inputTokens?: number; outputTokens?: number }

/**
 * Installs a P1 transport that answers in order: `finishReason` "stop", 1000 input tokens and 500 output tokens unless
 * the answer says otherwise (14000 micro-USD at the Opus price), and `text` taken from the sent body when it is a
 * function. A request with no answer left is recorded and then fails. Returns the requests sent, in order.
 */
export function scripted(answers: readonly Answer[]): Sent[] {
  const sent: Sent[] = []
  let next = 0
  setP1TransportForTests({
    async send(req) {
      sent.push({ ...req })
      const answer = answers[next]
      next += 1
      if (answer === undefined) throw new Error("scripted transport: no answer left")
      return {
        text: typeof answer.text === "function" ? answer.text(req.body) : answer.text,
        inputTokens: answer.inputTokens ?? 1000,
        outputTokens: answer.outputTokens ?? 500,
        finishReason: answer.finishReason === undefined ? "stop" : answer.finishReason,
      }
    },
  })
  return sent
}

/** An outline answer: the bare JSON object the model is asked for (D11). */
export const outlineJson = (sections: Array<{ heading: string; purpose: string }>, missingFacts: Array<{ field: string; note: string }> = []): string =>
  JSON.stringify({ sections, missingFacts })

/** The tokens of one kind (`PARTY`, `CNIC`, `VERBATIM`, ...) in a sent body, in the order they appear. */
export const tokensIn = (body: string, kind: string): string[] => body.match(new RegExp(`⟦${kind}_[1-9]\\d*⟧`, "g")) ?? []

/** Every call made to any logger method, as JSON, for the "no raw text in a log line" checks. */
export function spyLogs(): { all: () => string; warn: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> } {
  const spies = (["debug", "info", "log", "warn", "error", "write"] as const).map((m) => [m, vi.spyOn(logger, m).mockImplementation(() => undefined)] as const)
  const by = Object.fromEntries(spies)
  return { all: () => JSON.stringify(spies.map(([m, s]) => [m, s.mock.calls])), warn: by.warn, error: by.error }
}

/** Enables Opik (self-hosted, confirmed) with a fake fetch that captures each posted body; `status` is its answer. */
export function fakeOpik(status = 204): { bodies: string[] } {
  // A plain-http base must be loopback, a private IPv4 literal, or end in .internal or .local (M4).
  vi.stubEnv("OPIK_BASE_URL", "http://opik.test.internal")
  vi.stubEnv("OPIK_SELF_HOSTED_CONFIRMED", "true")
  const bodies: string[] = []
  setOpikFetchForTests((async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body))
    return new Response(null, { status })
  }) as typeof fetch)
  return { bodies }
}

// ---------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------

/** Each row of the collection that belongs to the firm, as `{ id, ...data }`. */
export async function docsOf(collection: string, firmId: string): Promise<Array<DocumentData & { id: string }>> {
  return (await adminDb().collection(collection).where("firmId", "==", firmId).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
}

/** The `idempotency_keys` documents of the firm: their ids start with `${firmId}_`. */
export async function idempotencyRowsOf(firmId: string): Promise<Array<DocumentData & { id: string }>> {
  const snap = await adminDb()
    .collection("idempotency_keys")
    .where(FieldPath.documentId(), ">=", `${firmId}_`)
    .where(FieldPath.documentId(), "<", `${firmId}_\uf8ff`)
    .get()
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

const briefOf = async (generationId: string) => (await adminDb().collection("draft_generations").doc(generationId).get()).data()
const failure = async (p: Promise<unknown>): Promise<[number, string]> => {
  const e = await apiErrorOf(p)
  return [e.status, e.code]
}

// ---------------------------------------------------------------------------
// The helpers, checked once
// ---------------------------------------------------------------------------

describe("D4 generation: test helpers (P4B-21)", () => {
  afterEach(() => setP1TransportForTests(null))

  it("scripted answers in order with finishReason stop, 1000 and 500 by default and text from the body; tokensIn lists a kind in order; outlineJson is the bare object", async () => {
    const sent = scripted([{ text: "one" }, { text: (body) => `echo:${body}`, finishReason: "length", inputTokens: 7, outputTokens: 3 }, { text: "three", finishReason: null }])
    const transport = activeTransport()!
    expect(await transport.send({ model: "m", body: "b1", maxTokens: 4096 })).toEqual({ text: "one", inputTokens: 1000, outputTokens: 500, finishReason: "stop" })
    expect(await transport.send({ model: "m", body: "b2", maxTokens: 4096 })).toEqual({ text: "echo:b2", inputTokens: 7, outputTokens: 3, finishReason: "length" })
    expect(await transport.send({ model: "m", body: "b3", maxTokens: 4096 })).toMatchObject({ finishReason: null })
    await expect(transport.send({ model: "m", body: "b4", maxTokens: 4096 })).rejects.toThrow("no answer left")
    expect(sent.map((s) => s.body)).toEqual(["b1", "b2", "b3", "b4"])
    expect(sent[0]).toEqual({ model: "m", body: "b1", maxTokens: 4096 })

    expect(tokensIn("⟦PARTY_2⟧ and ⟦CNIC_1⟧, ⟦PARTY_1⟧ then ⟦PARTY_2⟧ and PARTY_3", "PARTY")).toEqual(["⟦PARTY_2⟧", "⟦PARTY_1⟧", "⟦PARTY_2⟧"])
    expect(tokensIn("no tokens", "PARTY")).toEqual([])
    expect(JSON.parse(outlineJson([{ heading: "Facts", purpose: "State the facts." }]))).toEqual({ sections: [{ heading: "Facts", purpose: "State the facts." }], missingFacts: [] })
    expect(JSON.parse(outlineJson([], [{ field: "asAtDate", note: "Not given." }])).missingFacts).toEqual([{ field: "asAtDate", note: "Not given." }])
  })
})

// ---------------------------------------------------------------------------
// The entry routes
// ---------------------------------------------------------------------------

describe.skipIf(!EMULATORS)("D4 generation: entry routes (P4B-1, P4B-8, P4B-13, P4B-14)", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    setP1TransportForTests(null)
    setOpikFetchForTests(null)
  })

  it("startDraft writes the brief at stage facts and its audit row in one transaction, and answers ids, stage, classification and outlineVersion only", async () => {
    const f = await newFirm()
    const out = await start(f, { partyNames: [PERSON] })
    expect(Object.keys(out).sort()).toEqual(["classification", "generationId", "outlineVersion", "stage"])
    expect(out).toMatchObject({ stage: "facts", classification: "internal", outlineVersion: 0 })
    expect(out.generationId).toMatch(/^[A-Za-z0-9]{20}$/)

    const brief = (await briefOf(out.generationId))!
    expect(brief).toMatchObject({
      firmId: f.firmId,
      matterId: f.matterId,
      documentTypeId: TYPE,
      title: TITLE,
      facts: FACTS,
      verbatim: [],
      partyNames: [PERSON],
      classification: "internal",
      stage: "facts",
      outlineVersion: 0,
      approvedOutline: null,
      sectionCount: null,
      sectionsStored: 0,
      templateId: "template_cp_199_v1",
      path: null,
      model: null,
      promptVersion: null,
      calls: 0,
      costMicroUsd: 0,
      lastAttempt: null,
      inFlight: null,
      draftId: null,
      createdBy: f.A.uid,
    })
    expect(Object.keys(brief).sort()).toEqual(
      [
        "approvedOutline", "calls", "classification", "costMicroUsd", "createdAt", "createdBy", "documentTypeId", "draftId", "facts", "firmId", "inFlight", "lastAttempt", "matterId",
        "model", "outlineVersion", "partyNames", "path", "promptVersion", "sectionCount", "sectionsStored", "stage", "templateId", "title", "updatedAt", "verbatim",
      ].sort()
    )
    expect(brief.createdAt).toBeInstanceOf(Timestamp)
    expect(brief.updatedAt).toEqual(brief.createdAt)

    const audits = await docsOf("audit_log", f.firmId)
    expect(audits.filter((a) => a.action === "draft.create" && a.target === `draft_generations/${out.generationId}` && a.decision === "allow")).toHaveLength(1)
    // Only the brief is stored: no outline, no section, no draft, no event.
    for (const c of ["draft_outlines", "draft_sections", "drafts", "draft_versions", "events"]) expect(await docsOf(c, f.firmId)).toHaveLength(0)
  })

  it("startDraft checks its fields in order before the permission: matter, type, title, facts, verbatim, party names, classification", async () => {
    const f = await newFirm()
    // As the intern: a 403 would show if the permission ran before a check. Every malformed field gives its 400.
    const bad: Record<string, unknown> = { matterId: undefined, documentTypeId: "", title: "", facts: "", verbatim: "x", partyNames: "x", classification: "secret" }
    const fixes: Array<[string, unknown]> = [
      ["matterId", f.matterId],
      ["documentTypeId", TYPE],
      ["title", TITLE],
      ["facts", FACTS],
      ["verbatim", [{ field: "petitioner", text: PERSON }]],
      ["partyNames", [PERSON]],
    ]
    const codes: string[] = []
    const statuses = new Set<number>()
    const step = async () => {
      const [status, code] = await failure(start(f, bad, f.intern))
      codes.push(code)
      statuses.add(status)
    }
    await step()
    for (const [field, fix] of fixes) {
      bad[field] = fix
      await step()
    }
    expect(codes).toEqual(["matter_required", "invalid_document_type", "invalid_title", "invalid_facts", "invalid_verbatim", "invalid_party_names", "invalid_classification"])
    expect([...statuses]).toEqual([400])
    // With every field valid, the permission is decided last.
    bad.classification = "internal"
    expect(await failure(start(f, bad, f.intern))).toEqual([403, "intern_channel_denied"])
    // A well-formed type that names none is 404, after the type check and before the title.
    expect(await failure(start(f, { documentTypeId: "no_such_type", title: "" }, f.intern))).toEqual([404, "document_type_not_found"])
    expect(await failure(start(f, { documentTypeId: "constructor" }, f.intern))).toEqual([404, "document_type_not_found"])

    // Each field's own limits, every one a 400 before the permission.
    const field = (f0: string, text: string) => ({ field: f0, text })
    const six = ["petitioner", "respondents", "courtId", "impugnedOrderOrAct", "fundamentalRightOrJurisdictionGround", "reliefSought"]
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["facts empty", { facts: "" }, "invalid_facts"],
      ["facts over 100,000 characters", { facts: "x".repeat(100_001) }, "invalid_facts"],
      ["facts not a string", { facts: 5 }, "invalid_facts"],
      ["facts null", { facts: null }, "invalid_facts"],
      ["facts missing", { facts: undefined }, "invalid_facts"],
      ["facts only blanks", { facts: " \n\t " }, "invalid_facts"],
      ["verbatim null", { verbatim: null }, "invalid_verbatim"],
      ["verbatim an object", { verbatim: { field: "petitioner", text: "x" } }, "invalid_verbatim"],
      ["verbatim field outside requiredFields", { verbatim: [field("notARequiredField", "x")] }, "invalid_verbatim"],
      ["verbatim field of another type", { verbatim: [field("exactLandDescription", LAND)] }, "invalid_verbatim"],
      ["verbatim field repeated", { verbatim: [field("petitioner", "a"), field("petitioner", "b")] }, "invalid_verbatim"],
      ["verbatim 21 entries", { verbatim: Array.from({ length: 21 }, (_, i) => field(six[i % 6]!, "x")) }, "invalid_verbatim"],
      ["verbatim text of 10,001 characters", { verbatim: [field("petitioner", "x".repeat(10_001))] }, "invalid_verbatim"],
      ["verbatim texts totalling 50,001 characters", { verbatim: [...six.slice(0, 5).map((n) => field(n, "x".repeat(10_000))), field(six[5]!, "x")] }, "invalid_verbatim"],
      ["verbatim text empty", { verbatim: [field("petitioner", "")] }, "invalid_verbatim"],
      ["verbatim text only blanks", { verbatim: [field("petitioner", "  \n ")] }, "invalid_verbatim"],
      ["verbatim text not a string", { verbatim: [{ field: "petitioner", text: 5 }] }, "invalid_verbatim"],
      ["verbatim field not a string", { verbatim: [{ field: 5, text: "x" }] }, "invalid_verbatim"],
      ["verbatim entry not an object", { verbatim: ["petitioner"] }, "invalid_verbatim"],
      ["verbatim entry null", { verbatim: [null] }, "invalid_verbatim"],
      ["verbatim entry without text", { verbatim: [{ field: "petitioner" }] }, "invalid_verbatim"],
      ["verbatim entry with another key", { verbatim: [{ field: "petitioner", text: "x", note: "y" }] }, "invalid_verbatim"],
      ["party names over 50", { partyNames: Array.from({ length: 51 }, (_, i) => `Party ${i}`) }, "invalid_party_names"],
      ["party name of 201 characters", { partyNames: ["x".repeat(201)] }, "invalid_party_names"],
      ["party name with a line break", { partyNames: ["Ali\nRaza"] }, "invalid_party_names"],
      ["party name with a tab", { partyNames: ["Ali\tRaza"] }, "invalid_party_names"],
      ["party name empty", { partyNames: [""] }, "invalid_party_names"],
      ["party name only blanks", { partyNames: ["   "] }, "invalid_party_names"],
      ["party name not a string", { partyNames: [5] }, "invalid_party_names"],
      ["party names null", { partyNames: null }, "invalid_party_names"],
      ["party names an object", { partyNames: { 0: "Ali" } }, "invalid_party_names"],
      ["classification null", { classification: null }, "invalid_classification"],
      ["classification an Object.prototype key", { classification: "constructor" }, "invalid_classification"],
    ]
    for (const [name, over, code] of cases) expect([name, ...(await failure(start(f, over, f.intern)))]).toEqual([name, 400, code])
    expect(await docsOf("draft_generations", f.firmId)).toHaveLength(0)
  })

  it("startDraft stores the largest request the limits allow, in the charset rule's normalised form, trimmed party names and verbatim in order", async () => {
    const f = await newFirm()
    const six = ["petitioner", "respondents", "courtId", "impugnedOrderOrAct", "fundamentalRightOrJurisdictionGround", "reliefSought"]
    const verbatim = six.slice(0, 5).map((field) => ({ field, text: "x".repeat(10_000) }))
    const partyNames = Array.from({ length: 50 }, (_, i) => `${String(i).padStart(2, "0")}${"p".repeat(198)}`)
    const facts = "f".repeat(100_000)
    const out = await start(f, { facts, verbatim, partyNames: partyNames.map((n) => `  ${n}  `) })
    const brief = (await briefOf(out.generationId))!
    expect(brief.facts).toBe(facts)
    expect(brief.verbatim).toEqual(verbatim)
    expect(brief.partyNames).toEqual(partyNames)

    // Normalised: CRLF to LF and NFC in the facts, a verbatim text and a party name; the title is trimmed.
    const o2 = await start(f, { title: "  Petition  ", facts: "Cafe\u0301 term.\r\nSecond line.", verbatim: [{ field: "petitioner", text: "Cafe\u0301\r\nlane" }], partyNames: ["Cafe\u0301 Ltd"] })
    expect(await briefOf(o2.generationId)).toMatchObject({ title: "Petition", facts: "Caf\u00e9 term.\nSecond line.", verbatim: [{ field: "petitioner", text: "Caf\u00e9\nlane" }], partyNames: ["Caf\u00e9 Ltd"] })

    // An empty list is the same as none.
    const o3 = await start(f, { verbatim: [], partyNames: [] })
    expect(await briefOf(o3.generationId)).toMatchObject({ verbatim: [], partyNames: [] })
  })

  it("startDraft classification: at least internal, never below the matter's, within the caller's clearance; a closed matter is 409 matter_closed and a type that does not admit the court 422 court_mismatch", async () => {
    const f = await newFirm()
    const pub = await extraMatter(f, { classification: "public" })
    const confidential = await extraMatter(f, { classification: "confidential" })
    const privileged = await extraMatter(f, { classification: "privileged" })
    const closed = await extraMatter(f, { status: "closed" })
    const odd = await extraMatter(f, { courtId: "NOT_A_COURT" })
    const unreadable = await extraMatter(f, { classification: "bogus" })
    let made = 0
    const stored = async (over: Record<string, unknown>, member = f.A) => {
      const out = await start(f, over, member)
      made += 1
      expect((await briefOf(out.generationId))?.classification).toBe(out.classification)
      return out.classification
    }

    // The label: at least internal, at least the matter's, and the caller's when it asks for more.
    expect(await stored({ matterId: pub })).toBe("internal")
    expect(await stored({})).toBe("internal")
    expect(await stored({ classification: "confidential" })).toBe("confidential")
    expect(await stored({ matterId: pub, classification: "privileged" })).toBe("privileged")
    expect(await stored({ matterId: confidential })).toBe("confidential")
    expect(await stored({ matterId: confidential, classification: "privileged" })).toBe("privileged")
    expect(await stored({ matterId: privileged })).toBe("privileged")
    expect(await stored({ matterId: privileged, classification: "privileged" })).toBe("privileged")
    // `low` is cleared to internal and may ask for it.
    expect(await stored({ classification: "internal" }, f.low)).toBe("internal")
    expect(made).toBe(9)

    // Refusals, each with nothing stored.
    expect(await failure(start(f, { matterId: confidential, classification: "internal" }))).toEqual([422, "classification_below_matter"])
    expect(await failure(start(f, { matterId: privileged, classification: "confidential" }))).toEqual([422, "classification_below_matter"])
    expect(await failure(start(f, { classification: "privileged" }, f.low))).toEqual([403, "clearance"])
    expect(await failure(start(f, { matterId: confidential }, f.low))).toEqual([403, "clearance"])
    expect(await failure(start(f, { matterId: unreadable }))).toEqual([403, "clearance"])
    expect(await failure(start(f, { matterId: closed }))).toEqual([409, "matter_closed"])
    expect(await failure(start(f, { matterId: odd }))).toEqual([422, "court_mismatch"])
    expect(await failure(start(f, { matterId: odd, documentTypeId: "constitutional_petition_184_3" }))).toEqual([422, "court_mismatch"])
    // A NON_FORUM type suits a matter in any court.
    expect(await stored({ matterId: odd, documentTypeId: DEED })).toBe("internal")
    expect(made).toBe(10)
    expect(await docsOf("draft_generations", f.firmId)).toHaveLength(made)
  })

  it("reserved tokens: a ⟦, a ⟧, a lossy mask token or a bare token in the title, facts, a verbatim text or a party name is 422 reserved_tokens, after the permission, with nothing stored", async () => {
    const f = await newFirm()
    for (const over of [
      { title: "Petition ⟦PARTY_1⟧" },
      { title: "Petition ⟧" },
      { facts: `${FACTS} [CNIC]` },
      { facts: `${FACTS} See PARTY_1.` },
      { facts: `${FACTS} ⟦` },
      { facts: `${FACTS} VERBATIM_12 and EMAIL_3` },
      { documentTypeId: DEED, verbatim: [{ field: "exactLandDescription", text: "Plot ⟧" }] },
      { documentTypeId: DEED, verbatim: [{ field: "exactLandDescription", text: "Plot [PASSPORT]" }] },
      { partyNames: ["[PARTY]"] },
      { partyNames: [PERSON, "Ali ⟦CNIC_1⟧"] },
    ]) {
      expect([JSON.stringify(over), ...(await failure(start(f, over)))]).toEqual([JSON.stringify(over), 422, "reserved_tokens"])
    }
    expect((await apiErrorOf(start(f, { facts: "⟦x⟧" }, f.intern))).code).toBe("intern_channel_denied")
    expect((await apiErrorOf(start(f, { facts: "⟦x⟧" }, f.outsider))).code).toBe("not_member")
    expect(await docsOf("draft_generations", f.firmId)).toHaveLength(0)

    // Text that only resembles a token is the advocate's own text: a lone word, a lowercase kind, a longer word.
    const ok = await start(f, { facts: `${FACTS} The party was served; party_1 is a label, MYPARTY_1 and PARTY1 are not tokens, [party] neither.` })
    expect(ok.stage).toBe("facts")
    expect(await docsOf("draft_generations", f.firmId)).toHaveLength(1)
  })

  it("the text rules come after the permission: a bidirectional or invisible character in any field is 422 unsupported_characters, with nothing stored", async () => {
    const f = await newFirm()
    const RLO = "\u202e"
    const hostile: Array<[string, Record<string, unknown>]> = [
      ["title", { title: `Petition${RLO}` }],
      ["facts", { facts: `${FACTS}${RLO}` }],
      ["verbatim text", { documentTypeId: DEED, verbatim: [{ field: "exactLandDescription", text: `${LAND}${RLO}` }] }],
      ["party name", { partyNames: [`${PERSON}${RLO}`] }],
      ["facts, a zero-width space inside a number", { facts: `${FACTS} 1\u200b0` }],
      ["party name, a tag character", { partyNames: ["Ali\u{e0041}"] }],
    ]
    for (const [name, over] of hostile) {
      expect([name, ...(await failure(start(f, over)))]).toEqual([name, 422, "unsupported_characters"])
      // As a non-member the same input is refused for the permission, not for its text.
      expect([name, ...(await failure(start(f, over, f.outsider)))]).toEqual([name, 403, "not_member"])
      expect([name, ...(await failure(start(f, over, f.intern)))]).toEqual([name, 403, "intern_channel_denied"])
    }
    expect(await docsOf("draft_generations", f.firmId)).toHaveLength(0)
  })

  it("text that is nothing once normalised is 422 unsupported_characters, after the permission, with nothing stored", async () => {
    const f = await newFirm()
    // A zero-width space on its own is dropped by the charset layer's paste clean-up, which leaves nothing to store.
    const ZWSP = "\u200b"
    const empty: Array<[string, Record<string, unknown>]> = [
      ["facts", { facts: ZWSP }],
      ["verbatim text", { documentTypeId: DEED, verbatim: [{ field: "exactLandDescription", text: ZWSP }] }],
      ["party name", { partyNames: [` ${ZWSP}`] }],
      ["party name beside a real one", { partyNames: [PERSON, ZWSP] }],
    ]
    for (const [name, over] of empty) {
      expect([name, ...(await failure(start(f, over)))]).toEqual([name, 422, "unsupported_characters"])
      expect([name, ...(await failure(start(f, over, f.outsider)))]).toEqual([name, 403, "not_member"])
    }
    expect(await docsOf("draft_generations", f.firmId)).toHaveLength(0)
  })

  it("a reserved token that exists only once the text is normalised is 422 reserved_tokens: a soft hyphen or a zero-width space inside a bare token", async () => {
    const f = await newFirm()
    // The charset layer drops both between two letters of one script, so the stored text holds `PARTY_1` though the text
    // as sent does not. (A digit written in another script is refused by the charset layer itself, never folded.)
    const SOFT_HYPHEN = "\u00ad"
    const ZWSP = "\u200b"
    for (const hidden of [SOFT_HYPHEN, ZWSP]) {
      const token = `PAR${hidden}TY_1`
      expect(RESERVED_TOKEN.test(token)).toBe(false)
      for (const over of [
        { title: `Petition ${token}` },
        { facts: `${FACTS} See ${token}.` },
        { facts: `${FACTS} See CN${hidden}IC_2.` },
        { documentTypeId: DEED, verbatim: [{ field: "exactLandDescription", text: `Plot ${token}` }] },
        { partyNames: [token] },
      ]) {
        expect([JSON.stringify(over), ...(await failure(start(f, over)))]).toEqual([JSON.stringify(over), 422, "reserved_tokens"])
      }
    }
    // After the permission, as the other text rules.
    expect(await failure(start(f, { facts: `${FACTS} PAR${SOFT_HYPHEN}TY_1` }, f.intern))).toEqual([403, "intern_channel_denied"])
    expect(await docsOf("draft_generations", f.firmId)).toHaveLength(0)
  })

  it("access: an intern, a client, accounts and a non-member are refused; another firm's brief and one above the caller's clearance are 404 not_found on getGeneration", async () => {
    const f = await newFirm()
    expect(await failure(start(f, {}, f.intern))).toEqual([403, "intern_channel_denied"])
    expect(await failure(start(f, {}, f.client))).toEqual([403, "client_denied"])
    expect(await failure(start(f, {}, f.accounts))).toEqual([403, "accounts_register_only"])
    expect(await failure(start(f, {}, f.outsider))).toEqual([403, "not_member"])
    // A missing matter and another firm's are both 404 not_found; a malformed matter id is refused, not queried.
    const other = await newFirm()
    expect(await failure(start(f, { matterId: "no-such-matter" }))).toEqual([404, "not_found"])
    expect(await failure(start(f, { matterId: other.matterId }))).toEqual([404, "not_found"])
    expect(await failure(start(f, { matterId: "a/b" }))).toEqual([403, "invalid_matter_id"])
    expect(await docsOf("draft_generations", f.firmId)).toHaveLength(0)
    // A refusal is audited as a deny under draft.create.
    const denies = (await docsOf("audit_log", f.firmId)).filter((a) => a.actorId === f.intern.uid && a.action === "draft.create")
    expect(denies.length).toBeGreaterThan(0)
    expect(denies.every((a) => a.decision === "deny")).toBe(true)

    // getGeneration.
    const mine = (await start(f)).generationId
    const theirs = (await start(other)).generationId
    const secret = (await start(f, { classification: "privileged" })).generationId
    expect(await failure(getGenerationApi(f.A, { generationId: theirs }))).toEqual([404, "not_found"])
    expect(await failure(getGenerationApi(f.low, { generationId: secret }))).toEqual([404, "not_found"])
    expect((await getGenerationApi(f.A, { generationId: secret })).generationId).toBe(secret)
    expect((await getGenerationApi(f.low, { generationId: mine })).generationId).toBe(mine)
    for (const id of ["a/b", "..", "__x__", "x".repeat(129), "no-such-generation"]) expect([id.slice(0, 12), ...(await failure(getGenerationApi(f.A, { generationId: id })))]).toEqual([id.slice(0, 12), 404, "not_found"])
    expect(await failure(getGenerationApi(f.A, {}))).toEqual([400, "invalid_generation_id"])
    expect(await failure(getGenerationApi(f.A, { generationId: "" }))).toEqual([400, "invalid_generation_id"])
    // The permission is decided on the brief's matter.
    expect(await failure(getGenerationApi(f.intern, { generationId: mine }))).toEqual([403, "intern_channel_denied"])
    expect(await failure(getGenerationApi(f.client, { generationId: mine }))).toEqual([403, "client_denied"])
    expect(await failure(getGenerationApi(f.accounts, { generationId: mine }))).toEqual([403, "accounts_register_only"])
    expect(await failure(getGenerationApi(f.outsider, { generationId: mine }))).toEqual([403, "not_member"])
    // A matter labelled above the caller's clearance after the brief was written refuses even a brief labelled internal.
    const raised = await newFirm()
    const inRaised = (await start(raised)).generationId
    await adminDb().collection("matters").doc(raised.matterId).update({ classification: "privileged" })
    expect(await failure(getGenerationApi(raised.low, { generationId: inRaised }))).toEqual([403, "clearance"])
    expect((await getGenerationApi(raised.A, { generationId: inRaised })).generationId).toBe(inRaised)
  })

  it("getGeneration returns the brief with inProgress and never inFlight; listGenerations returns cleared briefs newest first without facts, verbatim, partyNames or unsupportedRefs, and pages", async () => {
    const f = await newFirm()
    const g1 = (await start(f, { title: "First", partyNames: [PERSON], verbatim: [{ field: "petitioner", text: PERSON }] })).generationId
    await sleep(5)
    const secret = (await start(f, { title: "Secret", classification: "privileged" })).generationId
    await sleep(5)
    const g2 = (await start(f, { title: "Second" })).generationId
    await sleep(5)
    const g3 = (await start(f, { title: "Third" })).generationId
    const elsewhere = await extraMatter(f)
    const otherMatter = (await start(f, { matterId: elsewhere })).generationId

    const view = await getGenerationApi(f.A, { generationId: g1 })
    expect(view).toMatchObject({ generationId: g1, facts: FACTS, inProgress: false, title: "First", partyNames: [PERSON], verbatim: [{ field: "petitioner", text: PERSON }], stage: "facts", draftId: null })
    expect(view).not.toHaveProperty("inFlight")
    expect(Object.keys(view).sort()).toEqual(
      [
        "approvedOutline", "calls", "classification", "costMicroUsd", "createdAt", "createdBy", "documentTypeId", "draftId", "facts", "firmId", "generationId", "inProgress", "lastAttempt",
        "matterId", "model", "outlineVersion", "partyNames", "path", "promptVersion", "sectionCount", "sectionsStored", "stage", "templateId", "title", "updatedAt", "verbatim",
      ].sort()
    )
    const stored = (await briefOf(g1))!
    expect(view.createdAt).toBe((stored.createdAt as Timestamp).toDate().toISOString())
    expect(view.updatedAt).toBe((stored.updatedAt as Timestamp).toDate().toISOString())
    const reads = (await docsOf("audit_log", f.firmId)).filter((a) => a.action === "draft.read" && a.target === `draft_generations/${g1}` && a.decision === "allow")
    expect(reads).toHaveLength(1)

    // The lease shows as inProgress while it is live, and never as itself; an expired one is not in progress.
    const lease = (ms: number) => ({ claimId: "claim-secret-1", step: "outline", outlineVersion: 1, section: null, by: f.A.uid, leaseUntil: Timestamp.fromMillis(Date.now() + ms) })
    await adminDb().collection("draft_generations").doc(g1).update({ inFlight: lease(120_000) })
    const live = await getGenerationApi(f.A, { generationId: g1 })
    expect(live.inProgress).toBe(true)
    expect(live).not.toHaveProperty("inFlight")
    expect(JSON.stringify(live)).not.toContain("claim-secret-1")
    await adminDb().collection("draft_generations").doc(g1).update({ inFlight: lease(-1000) })
    expect((await getGenerationApi(f.A, { generationId: g1 })).inProgress).toBe(false)
    await adminDb().collection("draft_generations").doc(g1).update({ inFlight: null })

    // The last attempt and the approval are shown with ISO times; the refused references only on getGeneration (D2).
    const at = Timestamp.fromMillis(Date.parse("2026-10-13T10:00:00.000Z"))
    await adminDb()
      .collection("draft_generations")
      .doc(g1)
      .update({
        stage: "approved",
        approvedOutline: { version: 1, sha256: "a".repeat(64), by: f.A.uid, at, acknowledgedMissingFacts: [0, 1] },
        lastAttempt: { step: "section", outlineVersion: 1, section: 2, outcome: "refused", reason: "unsupported_authority", unsupportedRefs: [NEW_CITATION], usageLogId: "u1", traceId: "t1", costMicroUsd: 14000, at, by: f.A.uid },
      })
    const shown = await getGenerationApi(f.A, { generationId: g1 })
    expect(shown.approvedOutline).toEqual({ version: 1, sha256: "a".repeat(64), by: f.A.uid, at: "2026-10-13T10:00:00.000Z", acknowledgedMissingFacts: [0, 1] })
    expect(shown.lastAttempt).toEqual({ step: "section", outlineVersion: 1, section: 2, outcome: "refused", reason: "unsupported_authority", unsupportedRefs: [NEW_CITATION], usageLogId: "u1", traceId: "t1", costMicroUsd: 14000, at: "2026-10-13T10:00:00.000Z", by: f.A.uid })
    await adminDb().collection("draft_generations").doc(g1).update({ stage: "facts", approvedOutline: null })

    // listGenerations: the matter's briefs the caller is cleared for, newest first, as summaries.
    const page1 = await listGenerationsApi(f.low, { matterId: f.matterId, limit: "2" })
    expect(page1.items.map((b) => b.generationId)).toEqual([g3, g2])
    expect(page1.nextCursor).not.toBeNull()
    for (const row of page1.items) for (const k of ["facts", "verbatim", "partyNames", "inFlight"]) expect(row).not.toHaveProperty(k)
    const page2 = await listGenerationsApi(f.low, { matterId: f.matterId, limit: "2", cursor: page1.nextCursor! })
    expect(page2.items.map((b) => b.generationId)).toEqual([g1]) // the privileged brief between them is not listed to `low`
    expect(page2.nextCursor).toBeNull()
    const row = page2.items[0]!
    expect(row).toMatchObject({ generationId: g1, title: "First", stage: "facts", inProgress: false, matterId: f.matterId })
    expect(row.lastAttempt).toEqual({ step: "section", outlineVersion: 1, section: 2, outcome: "refused", reason: "unsupported_authority", usageLogId: "u1", traceId: "t1", costMicroUsd: 14000, at: "2026-10-13T10:00:00.000Z", by: f.A.uid })
    expect(JSON.stringify(page2)).not.toContain(NEW_CITATION)
    expect(JSON.stringify(page2)).not.toContain(PERSON)
    expect(JSON.stringify(page2)).not.toContain("claim-secret")

    // A caller cleared for it sees every brief of the matter, and none of another matter's.
    const all = await listGenerationsApi(f.A, { matterId: f.matterId })
    expect(all.items.map((b) => b.generationId)).toEqual([g3, g2, secret, g1])
    expect(all.nextCursor).toBeNull()
    expect((await listGenerationsApi(f.A, { matterId: elsewhere })).items.map((b) => b.generationId)).toEqual([otherMatter])
    expect((await listGenerationsApi(f.A, { matterId: f.matterId, limit: "100" })).items).toHaveLength(4)
    const empty = await listGenerationsApi(f.A, { matterId: await extraMatter(f) })
    expect(empty).toEqual({ items: [], nextCursor: null })

    // Bad queries are 400 before the permission; a matter that is another firm's is 404; the roles are refused as for startDraft.
    expect(await failure(listGenerationsApi(f.A, {}))).toEqual([400, "matter_required"])
    expect(await failure(listGenerationsApi(f.intern, { matterId: "" }))).toEqual([400, "matter_required"])
    expect(await failure(listGenerationsApi(f.intern, { matterId: f.matterId, cursor: "!!not-a-cursor!!" }))).toEqual([400, "invalid_cursor"])
    expect(await failure(listGenerationsApi(f.A, { matterId: f.matterId, cursor: encodeCursor("not-a-time", g1) }))).toEqual([400, "invalid_cursor"])
    expect(await failure(listGenerationsApi(f.A, { matterId: f.matterId, cursor: encodeCursor("1.2.3", g1) }))).toEqual([400, "invalid_cursor"])
    expect(await failure(listGenerationsApi(f.A, { matterId: f.matterId, cursor: encodeCursor("1.2", "a/b") }))).toEqual([400, "invalid_cursor"])
    for (const limit of ["0", "101", "x", "-1", "1.5"]) expect([limit, ...(await failure(listGenerationsApi(f.A, { matterId: f.matterId, limit })))]).toEqual([limit, 400, "invalid_limit"])
    expect(await failure(listGenerationsApi(f.A, { matterId: (await newFirm()).matterId }))).toEqual([404, "not_found"])
    expect(await failure(listGenerationsApi(f.intern, { matterId: f.matterId }))).toEqual([403, "intern_channel_denied"])
    expect(await failure(listGenerationsApi(f.client, { matterId: f.matterId }))).toEqual([403, "client_denied"])
    expect(await failure(listGenerationsApi(f.accounts, { matterId: f.matterId }))).toEqual([403, "accounts_register_only"])
    expect(await failure(listGenerationsApi(f.outsider, { matterId: f.matterId }))).toEqual([403, "not_member"])
  })

  it("startDraft replays under the same Idempotency-Key and stores one brief; a new key stores another", async () => {
    const f = await newFirm()
    const data = { matterId: f.matterId, documentTypeId: TYPE, title: TITLE, facts: FACTS }
    const a = await startApi(f.A, data, { "idempotency-key": "11111111-2222-4333-8444-555555555555" })
    const b = await startApi(f.A, data, { "idempotency-key": "11111111-2222-4333-8444-555555555555" })
    expect(b).toEqual({ ...a, reused: true })
    expect(await docsOf("draft_generations", f.firmId)).toHaveLength(1)
    const rows = await idempotencyRowsOf(f.firmId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ firmId: f.firmId, uid: f.A.uid, route: "POST /api/d4/drafting/startDraft" })
    expect(rows[0]!.id.startsWith(`${f.firmId}_`)).toBe(true)
    // The stored answer holds ids and labels only, never the facts.
    expect(JSON.stringify(rows)).not.toContain(PERSON)
    const c = await startApi(f.A, data, { "idempotency-key": "22222222-2222-4333-8444-555555555555" })
    expect(c.generationId).not.toBe(a.generationId)
    expect(await docsOf("draft_generations", f.firmId)).toHaveLength(2)
    expect(await idempotencyRowsOf(f.firmId)).toHaveLength(2)
  })

  it("startDraft stores no brief when its audit row cannot be staged: 503 audit_unavailable", async () => {
    const f = await newFirm()
    const real = auditModule.appendAudit
    // The permission check's own row is written outside a transaction; only the row staged with the brief fails.
    vi.spyOn(auditModule, "appendAudit").mockImplementation(async (row, tx) => {
      if (tx) throw new Error("audit write refused")
      return real(row)
    })
    expect(await failure(start(f))).toEqual([503, "audit_unavailable"])
    vi.restoreAllMocks()
    expect(await docsOf("draft_generations", f.firmId)).toHaveLength(0)
    expect((await start(f)).stage).toBe("facts")
  })
})
