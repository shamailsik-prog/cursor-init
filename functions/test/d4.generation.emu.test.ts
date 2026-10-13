import { DocumentReference, FieldPath, Timestamp, Transaction, type DocumentData } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { afterEach, describe, expect, it, vi } from "vitest"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { adminDb } from "../src/admin"
import { encodeCursor } from "../src/d1/pagination"
import { setAuthorityStoreForTests } from "../src/d4/authority"
import { d4GenerationTestSeam } from "../src/d4/generationRun"
import { RESERVED_TOKEN, generations } from "../src/d4/generations"
import { outlineSha256 } from "../src/d4/guardrails"
import { InMemoryTemplateStore, setTemplateStoreForTests } from "../src/d4/templates"
import { firmConfigRef } from "../src/p1/config"
import { setOpikFetchForTests } from "../src/p1/opik"
import { P1TransportError, activeTransport, setP1TransportForTests } from "../src/p1/transport"
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

/** A P1 step's answer (OutlineStepResult; Task 4's SectionStepResult adds its fields). */
export type StepJson = {
  generationId: string
  stage: string
  step: string
  outlineVersion: number
  called: boolean
  outcome: string
  reason: string | null
  path: string | null
  model: string | null
  usage: { inputTokens: number; outputTokens: number; costMicroUsd: number }
  usageLogId: string | null
  traceId: string | null
  [field: string]: unknown
}
export type ApproveJson = { generationId: string; stage: string; outlineVersion: number; outlineSha256: string; sectionCount: number }
/** An outline as getOutline returns it. */
export type OutlineViewJson = { version: number; sha256: string; approved: boolean; [field: string]: unknown }

export const startApi = through(route<StartOut>("startDraft"))
export const getGenerationApi = through(route<GenerationJson>("getGeneration"))
export const listGenerationsApi = through(route<PageJson<GenerationJson>>("listGenerations"))
export const outlineApi = through(route<StepJson>("generateOutline"))
export const approveApi = through(route<ApproveJson>("approveOutline"))
export const getOutlineApi = through(route<OutlineViewJson>("getOutline"))

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

export const briefOf = async (generationId: string) => (await adminDb().collection("draft_generations").doc(generationId).get()).data()
/** The stored outline version `version` of a generation, as written (undefined when absent). */
export const outlineDocOf = async (generationId: string, version: number) => (await adminDb().collection("draft_outlines").doc(`${generationId}_${version}`).get()).data()
const failure = async (p: Promise<unknown>): Promise<[number, string]> => {
  const e = await apiErrorOf(p)
  return [e.status, e.code]
}

/** An outline as the model is asked to give it (D11), and as approveOutline takes an edit. */
export type OutlineContentJson = { sections: Array<{ heading: string; purpose: string }>; missingFacts: Array<{ field: string; note: string }> }
/** A one-section outline with no missing facts. */
export const ONE_SECTION: OutlineContentJson = { sections: [{ heading: "Facts", purpose: "State the facts." }], missingFacts: [] }

/**
 * `start`, then `generateOutline` from base 0 with one scripted answer (`content`, ONE_SECTION by default), as `member`
 * (the firm's associate by default). Fails unless the outline is stored. Returns the generation, the stored version and
 * its hash as stored.
 */
export async function outlined(
  f: Firm,
  opts: { content?: OutlineContentJson; start?: Record<string, unknown>; member?: Member } = {}
): Promise<{ generationId: string; outlineVersion: number; sha: string }> {
  const content = opts.content ?? ONE_SECTION
  const member = opts.member ?? f.A
  const generationId = (await start(f, opts.start ?? {}, member)).generationId
  scripted([{ text: outlineJson(content.sections, content.missingFacts) }])
  const r = await outlineApi(member, { generationId, baseOutlineVersion: 0 })
  if (r.outcome !== "stored") throw new Error(`outlined: ${r.outcome} ${String(r.reason)}`)
  const stored = await outlineDocOf(generationId, r.outlineVersion)
  return { generationId, outlineVersion: r.outlineVersion, sha: stored!.sha256 as string }
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

// ---------------------------------------------------------------------------
// The outline steps
// ---------------------------------------------------------------------------

const OPUS = "anthropic/claude-opus-5.5"
const NO_USAGE = { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 }
const DPA = { "ai-gateway": { dpaExecuted: true, inRegion: false } }
const DPA_IN_REGION = { "ai-gateway": { dpaExecuted: true, inRegion: true } }
/** The audit rows of the firm for `action` that name the brief `generationId` as their target. */
const briefAudits = async (f: Firm, action: string, generationId: string) =>
  (await docsOf("audit_log", f.firmId)).filter((a) => a.action === action && a.target === `draft_generations/${generationId}`)

/**
 * Spies on the SDK's transaction commits for one brief: a transaction that has read `draft_generations/{generationId}`
 * is marked, and when a marked transaction commits, `lose(n)` (n counts its marked commits from 1) decides what its
 * caller sees: null lets the commit through as it is; an error is thrown after the commit lands (a lost commit answer),
 * or in place of the commit with `commit: false` (a refused commit). The SDK retries a retryable error by running the
 * transaction's function again on the same transaction object. Returns the count of marked commits so far, so a test can
 * show that its spy fired.
 */
function briefCommits(generationId: string, lose: (n: number) => Error | null, opts: { commit?: boolean } = {}): () => number {
  const path = `draft_generations/${generationId}`
  const marked = new WeakSet<object>()
  const realGet = Transaction.prototype.get
  vi.spyOn(Transaction.prototype, "get").mockImplementation(function (this: Transaction, ref: unknown) {
    if (ref instanceof DocumentReference && ref.path === path) marked.add(this)
    return realGet.call(this, ref as never)
  } as never)
  // `commit` is the SDK's internal step of runTransaction; it is not in the typings.
  const proto = Transaction.prototype as unknown as { commit: () => Promise<void> }
  const realCommit = proto.commit
  let n = 0
  vi.spyOn(proto, "commit").mockImplementation(async function (this: Transaction) {
    if (!marked.has(this)) return realCommit.call(this)
    n += 1
    const err = lose(n)
    if (err === null || opts.commit !== false) await realCommit.call(this)
    if (err !== null) throw err
  } as never)
  return () => n
}

describe.skipIf(!EMULATORS)("D4 generation: outline steps (P4B-9, P4B-10, P4B-12, P4B-14, P4B-17, P4B-19, P4B-20)", () => {
  afterEach(() => {
    setProviderConfigForTests(null)
    setTemplateStoreForTests(null)
    setAuthorityStoreForTests(null)
    setP1TransportForTests(null)
    setOpikFetchForTests(null)
    for (const key of Object.keys(d4GenerationTestSeam) as Array<keyof typeof d4GenerationTestSeam>) delete d4GenerationTestSeam[key]
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("2. bad tokens: ⟦PARTY_9⟧, a bare PARTY_1 and [CNIC] in an answer are each refused rehydration_failed, with nothing stored", async () => {
    const f = await newFirm()
    const g = (await start(f)).generationId
    for (const bad of ["⟦PARTY_9⟧", "PARTY_1", "[CNIC]"]) {
      scripted([{ text: outlineJson([{ heading: "Facts", purpose: `The case of ${bad}.` }]) }])
      const r = await outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 })
      expect([bad, r.outcome, r.reason, r.called]).toEqual([bad, "refused", "rehydration_failed", true])
      // Billed: the usage is this request's, and the answer names no text.
      expect([bad, r.usage, r.outlineVersion, r.stage]).toEqual([bad, { inputTokens: 1000, outputTokens: 500, costMicroUsd: 14000 }, 0, "facts"])
      expect(JSON.stringify(r)).not.toContain("The case of")
    }
    expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(0)
    const brief = (await briefOf(g))!
    expect(brief).toMatchObject({ outlineVersion: 0, stage: "facts", calls: 3, costMicroUsd: 42000, inFlight: null, lastAttempt: { step: "outline", outcome: "refused", reason: "rehydration_failed" } })
    expect(brief.lastAttempt).toMatchObject({ outlineVersion: 1, section: null, unsupportedRefs: [], costMicroUsd: 14000, by: f.A.uid })
    // Each refused call has its deny row, with the outcome's reason (D5).
    expect((await briefAudits(f, "draft.generate", g)).map((a) => [a.decision, a.reason])).toEqual([
      ["deny", "rehydration_failed"],
      ["deny", "rehydration_failed"],
      ["deny", "rehydration_failed"],
    ])
  })

  it("4. privileged, no DPA: policy_denied, ai.call.blocked, recorded on the brief, and no outline stored", async () => {
    const f = await newFirm("privileged"); setProviderConfigForTests({}); const sent = scripted([])
    const g = (await start(f)).generationId
    const r = await outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 })
    expect([r.outcome, r.reason, r.called, r.usage.costMicroUsd]).toEqual(["blocked", "policy_denied", true, 0])
    expect(sent).toHaveLength(0)
    expect((await docsOf("events", f.firmId)).filter((e) => e.name === "ai.call.blocked" && e.id.startsWith(r.usageLogId!))).toHaveLength(1)
    expect(await briefOf(g)).toMatchObject({ classification: "privileged", calls: 1, costMicroUsd: 0, stage: "facts", lastAttempt: { outcome: "blocked", reason: "policy_denied", usageLogId: r.usageLogId } })
    expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(0)
    // P1 was asked at the brief's label, and the call's own row is a deny with P1's reason (D5).
    expect((await docsOf("ai_usage_logs", f.firmId)).map((u) => [u.classification, u.outcome, u.blockReason, u.taskType])).toEqual([["privileged", "blocked", "policy_denied", "drafting"]])
    expect((await briefAudits(f, "draft.generate", g)).map((a) => [a.decision, a.reason])).toEqual([["deny", "policy_denied"]])
  })

  it("6a. approval binding: a clerk is 403 role_not_permitted, a wrong hash or version is 409 outline_changed, unacknowledged missing facts are 422, and an edit is stored as n + 1 (kind edited) and approved", async () => {
    const f = await newFirm()
    // outline 1 has one missingFacts entry
    const withGap: OutlineContentJson = { sections: [{ heading: "Facts", purpose: "State the facts." }], missingFacts: [{ field: "asAtDate", note: "Not given." }] }
    const { generationId: g, sha } = await outlined(f, { content: withGap })
    expect((await apiErrorOf(approveApi(f.C, { generationId: g, outlineVersion: 1, outlineSha256: sha, acknowledgedMissingFacts: [0] }))).code).toBe("role_not_permitted")
    expect((await apiErrorOf(approveApi(f.A, { generationId: g, outlineVersion: 1, outlineSha256: "0".repeat(64), acknowledgedMissingFacts: [0] }))).code).toBe("outline_changed")
    expect((await apiErrorOf(approveApi(f.A, { generationId: g, outlineVersion: 2, outlineSha256: sha, acknowledgedMissingFacts: [0] }))).code).toBe("outline_changed")
    expect((await apiErrorOf(approveApi(f.A, { generationId: g, outlineVersion: 1, outlineSha256: sha, acknowledgedMissingFacts: [] }))).code).toBe("missing_facts_not_acknowledged")
    // D7: the acknowledgement is exactly every missing fact, no fewer and no more.
    for (const ack of [[1], [0, 1]]) {
      const e = await apiErrorOf(approveApi(f.A, { generationId: g, outlineVersion: 1, outlineSha256: sha, acknowledgedMissingFacts: ack }))
      expect([JSON.stringify(ack), e.status, e.code]).toEqual([JSON.stringify(ack), 422, "missing_facts_not_acknowledged"])
    }
    expect((await briefOf(g))!.approvedOutline).toBeNull()
    const edit = { sections: [{ heading: "Facts", purpose: "State the facts." }, { heading: "Prayer", purpose: "Pray for relief." }], missingFacts: [] }
    const ok = await approveApi(f.A, { generationId: g, outlineVersion: 1, outlineSha256: sha, outline: edit, acknowledgedMissingFacts: [] })
    expect(ok).toEqual({ generationId: g, stage: "approved", outlineVersion: 2, outlineSha256: outlineSha256(edit), sectionCount: 2 })
    const outline1 = (await outlineDocOf(g, 1))!
    const outline2 = (await outlineDocOf(g, 2))!
    expect(outline2).toMatchObject({ version: 2, kind: "edited", editedFrom: 1, sha256: outlineSha256(edit), path: null, costMicroUsd: 0, usageLogId: outline1.usageLogId })
    expect(outline2).toMatchObject({ firmId: f.firmId, matterId: f.matterId, generationId: g, sections: edit.sections, missingFacts: [], classification: "internal", model: null, promptVersion: null, traceId: null, inputTokens: 0, outputTokens: 0, createdBy: f.A.uid })
    expect(Object.keys(outline2).sort()).toEqual(Object.keys(outline1).sort())
    const brief = (await briefOf(g))!
    expect(brief.approvedOutline).toMatchObject({ version: 2, sha256: outlineSha256(edit), by: f.A.uid, acknowledgedMissingFacts: [] })
    expect(brief).toMatchObject({ stage: "approved", outlineVersion: 2, sectionCount: 2, sectionsStored: 0, calls: 1 })
    expect(brief.approvedOutline.at).toBeInstanceOf(Timestamp)
    // Approving the stored outline with its missing fact acknowledged binds that version and records the acknowledgement.
    const gap = await outlined(f, { content: withGap })
    expect(await approveApi(f.P, { generationId: gap.generationId, outlineVersion: 1, outlineSha256: gap.sha, acknowledgedMissingFacts: [0] })).toEqual({ generationId: gap.generationId, stage: "approved", outlineVersion: 1, outlineSha256: gap.sha, sectionCount: 1 })
    expect((await briefOf(gap.generationId))!.approvedOutline).toMatchObject({ version: 1, sha256: gap.sha, by: f.P.uid, acknowledgedMissingFacts: [0] })
    // D6: an "edit" identical to the current outline is no edit: on a fresh generation, approving outline 1 with outline equal to its stored content approves version 1 and stores no version 2
    const same = await outlined(f)
    const plain = await approveApi(f.A, { generationId: same.generationId, outlineVersion: 1, outlineSha256: same.sha, outline: ONE_SECTION, acknowledgedMissingFacts: [] })
    expect(plain).toEqual({ generationId: same.generationId, stage: "approved", outlineVersion: 1, outlineSha256: same.sha, sectionCount: 1 })
    expect(await outlineDocOf(same.generationId, 2)).toBeUndefined()
    expect(await briefOf(same.generationId)).toMatchObject({ outlineVersion: 1, approvedOutline: { version: 1, sha256: same.sha } })
    // Only the edit stored a version: three generated outlines and one edited.
    expect((await docsOf("draft_outlines", f.firmId)).map((o) => o.kind).sort()).toEqual(["edited", "generated", "generated", "generated"])
  })

  it("8. rank 4: privileged-restricted is policy_denied with an empty config and with a DPA but not in-region; no deterministic path is offered", async () => {
    const f = await newFirm("privileged-restricted")
    const g = (await start(f)).generationId
    const sent = scripted([])
    for (const cfg of [{}, { "ai-gateway": { dpaExecuted: true, inRegion: false } }]) {
      setProviderConfigForTests(cfg)
      const r = await outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 })
      expect([r.outcome, r.reason, r.path]).toEqual(["blocked", "policy_denied", "ai"])
    }
    expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(0)
    expect(sent).toHaveLength(0)
    expect(await briefOf(g)).toMatchObject({ classification: "privileged-restricted", calls: 2, costMicroUsd: 0, stage: "facts", outlineVersion: 0, path: "ai", inFlight: null })
  })

  it("deterministic-first: a test template gives 501 deterministic_not_built with no transport call, no usage row and the brief unchanged", async () => {
    const f = await newFirm()
    const g = (await start(f)).generationId
    const before = (await briefOf(g))!
    setTemplateStoreForTests(new InMemoryTemplateStore().addTemplate(TYPE, "template_cp_199_v1")); const sent = scripted([])
    const e = await apiErrorOf(outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 }))
    expect([e.status, e.code, sent.length, (await docsOf("ai_usage_logs", f.firmId)).length]).toEqual([501, "deterministic_not_built", 0, 0])
    expect(await briefOf(g)).toMatchObject({ calls: 0, path: null, inFlight: null })
    expect(await briefOf(g)).toEqual(before)
    expect((await briefAudits(f, "draft.generate", g)).map((a) => [a.decision, a.reason])).toEqual([["deny", "deterministic_not_built"]])
    // A template is the type's own: another type's template with the same id is not this type's, and the call is made.
    setTemplateStoreForTests(new InMemoryTemplateStore().addTemplate(DEED, "template_cp_199_v1"))
    scripted([{ text: outlineJson(ONE_SECTION.sections) }])
    expect(await outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 })).toMatchObject({ outcome: "stored", path: "ai" })
  })

  it("ranks 0-4 through setProviderConfigForTests: {} lets ranks 0-1 through, a DPA adds ranks 2-3, a DPA in-region adds rank 4", async () => {
    const labels = ["public", "internal", "confidential", "privileged", "privileged-restricted"]
    const expectFor = { none: ["stored", "stored", "blocked", "blocked", "blocked"], dpa: ["stored", "stored", "stored", "stored", "blocked"], region: ["stored", "stored", "stored", "stored", "stored"] }
    // one firm and one brief per label and config; the public brief is labelled internal
    const f = await newFirm()
    const matters: string[] = []
    for (const label of labels) matters.push(await extraMatter(f, { classification: label }))
    const outcomes: Record<keyof typeof expectFor, string[]> = { none: [], dpa: [], region: [] }
    const configs: Array<[keyof typeof expectFor, Parameters<typeof setProviderConfigForTests>[0]]> = [["none", {}], ["dpa", DPA], ["region", DPA_IN_REGION]]
    for (const [name, cfg] of configs) {
      setProviderConfigForTests(cfg)
      for (const [i, label] of labels.entries()) {
        const out = await start(f, { matterId: matters[i] })
        expect([label, out.classification]).toEqual([label, label === "public" ? "internal" : label])
        scripted([{ text: outlineJson(ONE_SECTION.sections) }])
        const r = await outlineApi(f.A, { generationId: out.generationId, baseOutlineVersion: 0 })
        outcomes[name].push(r.outcome)
        if (r.outcome === "blocked") expect([name, label, r.reason]).toEqual([name, label, "policy_denied"])
        else expect((await outlineDocOf(out.generationId, 1))!.classification).toBe(out.classification)
      }
    }
    expect(outcomes).toEqual(expectFor)
  }, 90_000)

  it("reserved tokens in an outline edit are 422 reserved_tokens, and nothing is stored", async () => {
    const f = await newFirm()
    const { generationId: g, sha } = await outlined(f)
    const e = await apiErrorOf(approveApi(f.A, { generationId: g, outlineVersion: 1, outlineSha256: sha, outline: { sections: [{ heading: "⟦PARTY_1⟧", purpose: "p" }], missingFacts: [] }, acknowledgedMissingFacts: [] }))
    expect([e.status, e.code]).toEqual([422, "reserved_tokens"]); expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(1); expect((await briefOf(g))!.approvedOutline).toBeNull()
    // In any string of the edit, each kind of reserved token, one that exists only once normalised included.
    const edits: OutlineContentJson[] = [
      { sections: [{ heading: "Facts", purpose: "Against PARTY_1." }], missingFacts: [] },
      { sections: [{ heading: "Facts", purpose: "p" }], missingFacts: [{ field: "asAtDate", note: "Was [CNIC] given?" }] },
      { sections: [{ heading: "Facts", purpose: "p" }], missingFacts: [{ field: "x⟧", note: "n" }] },
      { sections: [{ heading: "Facts", purpose: "PAR\u00adTY_1 was served." }], missingFacts: [] },
    ]
    for (const outline of edits) {
      const r = await apiErrorOf(approveApi(f.A, { generationId: g, outlineVersion: 1, outlineSha256: sha, outline, acknowledgedMissingFacts: outline.missingFacts.map((_, i) => i) }))
      expect([JSON.stringify(outline), r.status, r.code]).toEqual([JSON.stringify(outline), 422, "reserved_tokens"])
    }
    // The charset rule comes first, and both come after the permission.
    const hostile = { sections: [{ heading: "Facts", purpose: "PARTY_1 \u202e" }], missingFacts: [] }
    expect(await failure(approveApi(f.A, { generationId: g, outlineVersion: 1, outlineSha256: sha, outline: hostile, acknowledgedMissingFacts: [] }))).toEqual([422, "unsupported_characters"])
    expect(await failure(approveApi(f.C, { generationId: g, outlineVersion: 1, outlineSha256: sha, outline: hostile, acknowledgedMissingFacts: [] }))).toEqual([403, "role_not_permitted"])
    expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(1)
    expect(await briefOf(g)).toMatchObject({ outlineVersion: 1, stage: "outlined", approvedOutline: null })
  })

  it("R12: a member removed during the call gets 403 at the outcome write; nothing is stored and the usage row is present", async () => {
    const f = await newFirm()
    const g = (await start(f)).generationId
    scripted([{ text: outlineJson(ONE_SECTION.sections) }])
    d4GenerationTestSeam.beforeOutcomeWrite = () => adminDb().collection("matter_members").doc(`${f.matterId}_${f.A.uid}`).delete().then(() => undefined)
    const e = await apiErrorOf(outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 }))
    expect([e.status, e.code]).toEqual([403, "not_member"])
    expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(0); expect(await briefOf(g)).toMatchObject({ calls: 0, outlineVersion: 0 })
    expect((await docsOf("ai_usage_logs", f.firmId)).map((u) => u.outcome)).toEqual(["ok"])
    // D12: the refusal writes nothing, so the lease runs out at leaseUntil; the call's row is the router's deny.
    expect((await briefOf(g))!).toMatchObject({ lastAttempt: null, stage: "facts", inFlight: { step: "outline", outlineVersion: 1, section: null, by: f.A.uid } })
    expect((await briefAudits(f, "draft.generate", g)).map((a) => [a.decision, a.reason])).toEqual([["deny", "not_member"]])
  })

  it("a stored outline: version base + 1, kind generated, with its hash, label, path ai, model, prompt version and usage; the answer holds ids and usage only", async () => {
    const f = await newFirm()
    // The brief names the person as a party, so the model sees and writes ⟦PARTY_1⟧ in their place.
    const g = (await start(f, { partyNames: [PERSON] })).generationId
    const outline1Content: OutlineContentJson = {
      sections: [{ heading: "Facts", purpose: `The case of ⟦PARTY_1⟧ as numbered paragraphs.` }, { heading: "Grounds", purpose: `Rely on ${OWN_CITATION}.` }, { heading: "Prayer", purpose: "Set aside the order." }],
      missingFacts: [{ field: "asAtDate", note: "The date of the order is not given." }],
    }
    const stored: OutlineContentJson = { ...outline1Content, sections: outline1Content.sections.map((s, i) => (i === 0 ? { ...s, purpose: `The case of ${PERSON} as numbered paragraphs.` } : s)) }
    const sent = scripted([{ text: "```json\n" + outlineJson(outline1Content.sections, outline1Content.missingFacts) + "\n```" }])
    const r = await outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 })
    expect(Object.keys(r).sort()).toEqual(["called", "generationId", "model", "outcome", "outlineVersion", "path", "reason", "stage", "step", "traceId", "usage", "usageLogId"])
    expect(r).toMatchObject({ stage: "outlined", step: "outline", outlineVersion: 1, called: true, outcome: "stored", reason: null, path: "ai", model: "anthropic/claude-opus-5.5", usage: { inputTokens: 1000, outputTokens: 500, costMicroUsd: 14000 } })
    expect(JSON.stringify(r)).not.toMatch(/Ardeshir|numbered paragraphs|Set aside|asAtDate/)
    const gen = r.generationId
    expect(gen).toBe(g)
    const outline1 = (await outlineDocOf(gen, 1))!
    expect(outline1).toMatchObject({ version: 1, kind: "generated", editedFrom: null, sha256: outlineSha256(stored), classification: "internal", path: "ai", promptVersion: "4b.1", usageLogId: r.usageLogId, traceId: r.traceId, costMicroUsd: 14000 })
    expect(outline1).toMatchObject({ firmId: f.firmId, matterId: f.matterId, generationId: gen, sections: stored.sections, missingFacts: stored.missingFacts, model: OPUS, inputTokens: 1000, outputTokens: 500, createdBy: f.A.uid })
    expect(Object.keys(outline1).sort()).toEqual(
      ["classification", "costMicroUsd", "createdAt", "createdBy", "editedFrom", "firmId", "generationId", "inputTokens", "kind", "matterId", "missingFacts", "model", "outputTokens", "path", "promptVersion", "sections", "sha256", "traceId", "usageLogId", "version"].sort()
    )
    const brief = (await briefOf(gen))!
    expect(brief).toMatchObject({ stage: "outlined", outlineVersion: 1, path: "ai", promptVersion: "4b.1", calls: 1, costMicroUsd: 14000, inFlight: null })
    expect(brief).toMatchObject({ model: OPUS, classification: "internal", approvedOutline: null, sectionCount: null, sectionsStored: 0 })
    expect(brief.lastAttempt).toMatchObject({ step: "outline", outlineVersion: 1, section: null, outcome: "stored", reason: null, unsupportedRefs: [], usageLogId: r.usageLogId, traceId: r.traceId, costMicroUsd: 14000, by: f.A.uid })
    expect(brief.updatedAt.isEqual(outline1.createdAt)).toBe(true)
    // One call, with the drafting route's model and cap; the body carries the party as a token only.
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ model: OPUS, maxTokens: 4096 })
    expect(sent[0]!.body).not.toContain(PERSON)
    expect(tokensIn(sent[0]!.body, "PARTY")).not.toHaveLength(0)
    expect((await docsOf("ai_usage_logs", f.firmId)).map((u) => [u.taskType, u.outcome, u.classification])).toEqual([["drafting", "ok", "internal"]])
    expect((await briefAudits(f, "draft.generate", gen)).map((a) => [a.decision, a.reason])).toEqual([["allow", "ok"]])
    // No events at the outline steps (P4B-15) beyond P1's own.
    expect((await docsOf("events", f.firmId)).map((e) => e.name)).toEqual(["ai.call.completed"])
    // The idempotency store holds the answer, never the outline.
    expect(JSON.stringify(await idempotencyRowsOf(f.firmId))).not.toMatch(/Ardeshir|numbered paragraphs/)
  })

  it("a new outline voids the approval; a stale base is 409 outline_changed; a stored base + 1 is returned with called: false and no transport call", async () => {
    const f = await newFirm()
    const g = (await start(f)).generationId
    const second: OutlineContentJson = { sections: [...ONE_SECTION.sections, { heading: "Prayer", purpose: "Pray for relief." }], missingFacts: [] }
    const sent = scripted([{ text: outlineJson(ONE_SECTION.sections) }, { text: outlineJson(second.sections) }])
    const r1 = await outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 })
    const sha1 = (await outlineDocOf(g, 1))!.sha256 as string
    await approveApi(f.A, { generationId: g, outlineVersion: 1, outlineSha256: sha1, acknowledgedMissingFacts: [] })
    expect(await briefOf(g)).toMatchObject({ stage: "approved", sectionCount: 1 })
    // after approving 1: generateOutline base 1 gives version 2, stage outlined, approvedOutline null, sectionCount null, sectionsStored 0
    const r2 = await outlineApi(f.A, { generationId: g, baseOutlineVersion: 1 })
    expect(r2).toMatchObject({ outlineVersion: 2, stage: "outlined", outcome: "stored", called: true })
    expect(await briefOf(g)).toMatchObject({ outlineVersion: 2, stage: "outlined", approvedOutline: null, sectionCount: null, sectionsStored: 0, calls: 2 })
    expect((await outlineDocOf(g, 2))!.sha256).toBe(outlineSha256(second))
    // base 0 again: called false, outcome stored, outlineVersion 1, usage zeros, usageLogId null, traceId null, sent.length unchanged
    const replay = await outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 })
    expect(replay).toEqual({ generationId: g, stage: "outlined", step: "outline", outlineVersion: 1, called: false, outcome: "stored", reason: null, path: "ai", model: OPUS, usage: NO_USAGE, usageLogId: null, traceId: null })
    expect((await outlineApi(f.A, { generationId: g, baseOutlineVersion: 1 })).outlineVersion).toBe(2)
    expect(sent).toHaveLength(2)
    expect(await briefOf(g)).toMatchObject({ calls: 2, outlineVersion: 2 })
    expect(r1.usageLogId).not.toBeNull()
    // base 5: 409 outline_changed
    expect(await failure(outlineApi(f.A, { generationId: g, baseOutlineVersion: 5 }))).toEqual([409, "outline_changed"])
    expect(await failure(outlineApi(f.A, { generationId: g, baseOutlineVersion: 3 }))).toEqual([409, "outline_changed"])
    // D3: an edited version is not a generateOutline result; its base falls through to outline_changed.
    const sha2 = (await outlineDocOf(g, 2))!.sha256 as string
    await approveApi(f.A, { generationId: g, outlineVersion: 2, outlineSha256: sha2, outline: ONE_SECTION, acknowledgedMissingFacts: [] })
    expect((await outlineDocOf(g, 3))!.kind).toBe("edited")
    expect(await failure(outlineApi(f.A, { generationId: g, baseOutlineVersion: 2 }))).toEqual([409, "outline_changed"])
    expect(sent).toHaveLength(2)
  })

  it("a live lease is 409 generation_in_progress for generateOutline and approveOutline, and the outcome write releases it", async () => {
    const f = await newFirm()
    const { generationId: g, sha } = await outlined(f)
    // a transport held open by a promise: while the first call is in flight, a second generateOutline (new key) and an approveOutline each give 409 generation_in_progress; after the release, brief.inFlight is null
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let entered!: () => void
    const inCall = new Promise<void>((resolve) => (entered = resolve))
    setP1TransportForTests({
      async send() {
        entered()
        await held
        return { text: outlineJson(ONE_SECTION.sections), inputTokens: 1000, outputTokens: 500, finishReason: "stop" }
      },
    })
    const running = outlineApi(f.A, { generationId: g, baseOutlineVersion: 1 })
    await inCall
    expect((await briefOf(g))!.inFlight).toMatchObject({ step: "outline", outlineVersion: 2, section: null, by: f.A.uid })
    expect((await getGenerationApi(f.A, { generationId: g })).inProgress).toBe(true)
    expect(await failure(outlineApi(f.A, { generationId: g, baseOutlineVersion: 1 }))).toEqual([409, "generation_in_progress"])
    expect(await failure(outlineApi(f.C, { generationId: g, baseOutlineVersion: 1 }))).toEqual([409, "generation_in_progress"])
    expect(await failure(approveApi(f.A, { generationId: g, outlineVersion: 1, outlineSha256: sha, acknowledgedMissingFacts: [] }))).toEqual([409, "generation_in_progress"])
    release()
    expect(await running).toMatchObject({ outcome: "stored", outlineVersion: 2, called: true })
    const brief = (await briefOf(g))!
    expect(brief.inFlight).toBeNull()
    expect(brief).toMatchObject({ calls: 2, outlineVersion: 2, approvedOutline: null })
    expect((await getGenerationApi(f.A, { generationId: g })).inProgress).toBe(false)
  })

  it("a lease that is no longer this request's at the outcome write is 409 generation_changed, with nothing stored", async () => {
    const f = await newFirm()
    const g = (await start(f)).generationId
    scripted([{ text: outlineJson(ONE_SECTION.sections) }])
    d4GenerationTestSeam.beforeOutcomeWrite = () => generations().doc(g).update({ "inFlight.claimId": "someone-else" }).then(() => undefined)
    expect((await apiErrorOf(outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 }))).code).toBe("generation_changed")
    expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(0)
    expect(await briefOf(g)).toMatchObject({ calls: 0, outlineVersion: 0, lastAttempt: null, inFlight: { claimId: "someone-else" } })
    expect((await briefAudits(f, "draft.generate", g)).map((a) => [a.decision, a.reason])).toEqual([["deny", "generation_changed"]])
  })

  it("the outcome write is retried to the D4 deadline, and a lost commit answer is confirmed by lastAttempt.usageLogId: one outline, billed once", async () => {
    const f = await newFirm()
    const g = (await start(f)).generationId
    scripted([{ text: outlineJson(ONE_SECTION.sections) }])
    d4GenerationTestSeam.outcomeWriteFailures = [Object.assign(new Error("x"), { code: 14 })]; d4GenerationTestSeam.lostCommitAnswers = [Object.assign(new Error("y"), { code: 14 })]
    const r = await outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 })
    expect(r.outcome).toBe("stored"); expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(1); expect(await briefOf(g)).toMatchObject({ calls: 1, costMicroUsd: 14000 })
    expect([d4GenerationTestSeam.outcomeWriteFailures, d4GenerationTestSeam.lostCommitAnswers]).toEqual([[], []])
    expect(r).toMatchObject({ outlineVersion: 1, stage: "outlined", called: true })
    expect(await briefOf(g)).toMatchObject({ inFlight: null, outlineVersion: 1, lastAttempt: { usageLogId: r.usageLogId, outcome: "stored" } })
    expect((await briefAudits(f, "draft.generate", g)).map((a) => [a.decision, a.reason])).toEqual([["allow", "ok"]])
  })

  it("an outcome write that fails until the start-by time answers 500 with nothing stored, and no retry starts after it (D24, O-85)", async () => {
    const f = await newFirm()
    const g = (await start(f)).generationId
    scripted([{ text: outlineJson(ONE_SECTION.sections) }])
    // Each attempt fails; the clock moves 2,500 ms per reading, so the start-by time (6,000 ms after the call) passes
    // after a few attempts, and the queue is not emptied.
    const failures = Array.from({ length: 20 }, () => Object.assign(new Error("x"), { code: 14 }))
    d4GenerationTestSeam.outcomeWriteFailures = failures
    let t = Date.now()
    d4GenerationTestSeam.beforeOutcomeWrite = async () => {
      d4GenerationTestSeam.wallClock = () => (t += 2_500)
    }
    const logs = spyLogs()
    expect(await failure(outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 }))).toEqual([500, "internal"])
    // The router logs the failure with its code only.
    expect(logs.error.mock.calls.map((c) => c[1])).toEqual([{ code: "grpc_14" }])
    expect(failures.length).toBeGreaterThan(15)
    expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(0)
    expect(await briefOf(g)).toMatchObject({ calls: 0, lastAttempt: null })
    expect((await docsOf("ai_usage_logs", f.firmId)).map((u) => u.outcome)).toEqual(["ok"])
  })

  it("a lost commit answer whose confirming read fails too is confirmed by the next attempt inside its transaction: one outline, billed once", async () => {
    const f = await newFirm()
    const g = (await start(f)).generationId
    scripted([{ text: outlineJson(ONE_SECTION.sections) }])
    const briefPath = generations().doc(g).path
    d4GenerationTestSeam.lostCommitAnswers = [Object.assign(new Error("y"), { code: 14 })]
    // From the outcome write on, a plain read of the brief fails: only the next attempt's own transactional read can see the commit.
    const realGet = DocumentReference.prototype.get
    let refused = 0
    d4GenerationTestSeam.beforeOutcomeWrite = async () => {
      vi.spyOn(DocumentReference.prototype, "get").mockImplementation(function (this: DocumentReference) {
        if (this.path !== briefPath) return realGet.call(this)
        refused += 1
        return Promise.reject(Object.assign(new Error("read failed"), { code: 14 }))
      } as never)
    }
    const r = await outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 })
    vi.restoreAllMocks()
    // The confirming read was refused, so only the next attempt's own transactional read can have confirmed the write.
    expect(refused).toBeGreaterThanOrEqual(1)
    expect(d4GenerationTestSeam.lostCommitAnswers).toEqual([])
    expect(r).toMatchObject({ outcome: "stored", outlineVersion: 1, stage: "outlined", called: true })
    expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(1)
    expect(await briefOf(g)).toMatchObject({ calls: 1, costMicroUsd: 14000, inFlight: null, lastAttempt: { usageLogId: r.usageLogId } })
    expect((await briefAudits(f, "draft.generate", g)).map((a) => [a.decision, a.reason])).toEqual([["allow", "ok"]])
  })

  it("approveOutline judges the matter, the version and the lease again in its transaction: a change that lands after the first checks is refused, with nothing written", async () => {
    const f = await newFirm()
    const { generationId: g, sha } = await outlined(f)
    const briefPath = generations().doc(g).path
    // Each change is made just before the approval transaction reads the brief, so only that transaction can see it.
    let inject: (() => Promise<unknown>) | null = null
    const realGet = Transaction.prototype.get
    vi.spyOn(Transaction.prototype, "get").mockImplementation(async function (this: Transaction, ref: unknown) {
      if (inject !== null && ref instanceof DocumentReference && ref.path === briefPath) {
        const change = inject
        inject = null
        await change()
      }
      return realGet.call(this, ref as never)
    } as never)
    const approve = () => approveApi(f.A, { generationId: g, outlineVersion: 1, outlineSha256: sha, acknowledgedMissingFacts: [] })
    const lease = { claimId: "another-request", step: "outline", outlineVersion: 2, section: null, by: f.C.uid, leaseUntil: Timestamp.fromMillis(Date.now() + 60_000) }
    const cases: Array<[string, () => Promise<unknown>, () => Promise<unknown>, [number, string]]> = [
      ["a lease", () => generations().doc(g).update({ inFlight: lease }), () => generations().doc(g).update({ inFlight: null }), [409, "generation_in_progress"]],
      ["a closed matter", () => adminDb().collection("matters").doc(f.matterId).update({ status: "closed" }), () => adminDb().collection("matters").doc(f.matterId).update({ status: "open" }), [409, "matter_closed"]],
      ["a newer version", () => generations().doc(g).update({ outlineVersion: 2 }), () => generations().doc(g).update({ outlineVersion: 1 }), [409, "outline_changed"]],
      ["a removed member", () => adminDb().collection("matter_members").doc(`${f.matterId}_${f.A.uid}`).delete(), () => adminDb().collection("matter_members").doc(`${f.matterId}_${f.A.uid}`).set({ firmId: f.firmId, matterId: f.matterId, userId: f.A.uid, classification: "internal" }), [403, "not_member"]],
    ]
    for (const [name, change, undo, refusal] of cases) {
      inject = change
      expect([name, ...(await failure(approve()))]).toEqual([name, ...refusal])
      expect([name, inject]).toEqual([name, null])
      expect([name, (await briefOf(g))!.approvedOutline]).toEqual([name, null])
      await undo()
    }
    expect((await briefAudits(f, "draft.outline.approve", g)).map((a) => a.decision)).toEqual(["deny", "deny", "deny", "deny"])
    // With nothing changed, the same request is approved.
    expect(await approve()).toMatchObject({ stage: "approved", outlineVersion: 1 })
    expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(1)
  })

  it("a lease whose commit answer is lost is this request's own when the SDK runs the transaction again: the step goes on, with one call and no lease left", async () => {
    const f = await newFirm()
    const g = (await start(f)).generationId
    const sent = scripted([{ text: outlineJson(ONE_SECTION.sections) }])
    const commits = briefCommits(g, (n) => (n === 1 ? Object.assign(new Error("lost"), { code: 14 }) : null))
    const r = await outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 })
    // The lease (its answer lost), the SDK's second run of it, then the outcome write.
    expect(commits()).toBeGreaterThanOrEqual(3)
    vi.restoreAllMocks()
    expect(r).toMatchObject({ outcome: "stored", outlineVersion: 1, called: true })
    expect(sent).toHaveLength(1)
    expect(await briefOf(g)).toMatchObject({ calls: 1, outlineVersion: 1, inFlight: null })
    expect((await briefAudits(f, "draft.generate", g)).map((a) => [a.decision, a.reason])).toEqual([["allow", "ok"]])
  })

  it("a lease whose commit answer is lost for good is released before the error is rethrown: no call, no lease left", async () => {
    const f = await newFirm()
    const g = (await start(f)).generationId
    const sent = scripted([])
    // An error the SDK does not retry, after the lease has committed.
    const commits = briefCommits(g, (n) => (n === 1 ? new Error("answer lost") : null))
    const logs = spyLogs()
    expect(await failure(outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 }))).toEqual([500, "internal"])
    // The lease, then the release.
    expect(commits()).toBe(2)
    expect(logs.warn.mock.calls.filter((c) => c[0] === "d4.lease_released_after_error").map((c) => (c[1] as { code: string }).code)).toEqual(["released"])
    vi.restoreAllMocks()
    expect(sent).toHaveLength(0)
    expect(await briefOf(g)).toMatchObject({ inFlight: null, calls: 0, lastAttempt: null })
  })

  it("the lease transaction that gives up under contention is 503 generation_busy, with no call made and no lease left", async () => {
    const f = await newFirm()
    const g = (await start(f)).generationId
    const before = (await briefOf(g))!
    const sent = scripted([])
    // The op's clock stands still, so the pre-call budget cannot pass: a 503 here is the contention's.
    d4GenerationTestSeam.wallClock = () => Date.parse("2099-01-01T00:00:00.000Z")
    // Every attempt of the lease transaction is refused ABORTED (the SDK's five attempts); the release that follows commits.
    const commits = briefCommits(g, (n) => (n <= 5 ? Object.assign(new Error("aborted"), { code: 10 }) : null), { commit: false })
    const logs = spyLogs()
    expect(await failure(outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 }))).toEqual([503, "generation_busy"])
    expect(commits()).toBe(6)
    expect(logs.warn.mock.calls.filter((c) => c[0] === "d4.lease_released_after_error").map((c) => (c[1] as { code: string }).code)).toEqual(["not_held"])
    vi.restoreAllMocks()
    expect(sent).toHaveLength(0)
    expect(await briefOf(g)).toEqual(before)
  }, 60_000)

  it("approveOutline whose commit answer is lost answers as the committed approval when the SDK runs it again: one approval, one audit row, with and without an edit", async () => {
    const f = await newFirm()
    const lost = (n: number) => (n === 1 ? Object.assign(new Error("lost"), { code: 14 }) : null)
    // No edit.
    const plain = await outlined(f)
    let commits = briefCommits(plain.generationId, lost)
    expect(await approveApi(f.A, { generationId: plain.generationId, outlineVersion: 1, outlineSha256: plain.sha, acknowledgedMissingFacts: [] })).toEqual({
      generationId: plain.generationId,
      stage: "approved",
      outlineVersion: 1,
      outlineSha256: plain.sha,
      sectionCount: 1,
    })
    expect(commits()).toBe(2)
    vi.restoreAllMocks()
    expect((await briefOf(plain.generationId))!.approvedOutline).toMatchObject({ version: 1, sha256: plain.sha, by: f.A.uid })
    expect((await briefAudits(f, "draft.outline.approve", plain.generationId)).map((a) => [a.decision, a.reason])).toEqual([["allow", "ok"]])
    // With an edit: version 2 is stored once and approved.
    const edited = await outlined(f)
    const edit = { sections: [{ heading: "Facts", purpose: "State the facts." }, { heading: "Prayer", purpose: "Pray for relief." }], missingFacts: [] }
    commits = briefCommits(edited.generationId, lost)
    expect(await approveApi(f.A, { generationId: edited.generationId, outlineVersion: 1, outlineSha256: edited.sha, outline: edit, acknowledgedMissingFacts: [] })).toEqual({
      generationId: edited.generationId,
      stage: "approved",
      outlineVersion: 2,
      outlineSha256: outlineSha256(edit),
      sectionCount: 2,
    })
    expect(commits()).toBe(2)
    vi.restoreAllMocks()
    expect(await briefOf(edited.generationId)).toMatchObject({ outlineVersion: 2, stage: "approved", sectionCount: 2, approvedOutline: { version: 2, sha256: outlineSha256(edit), by: f.A.uid } })
    expect((await docsOf("draft_outlines", f.firmId)).filter((o) => o.generationId === edited.generationId).map((o) => [o.version, o.kind])).toEqual(
      expect.arrayContaining([[1, "generated"], [2, "edited"]])
    )
    expect((await docsOf("draft_outlines", f.firmId)).filter((o) => o.generationId === edited.generationId)).toHaveLength(2)
    expect((await briefAudits(f, "draft.outline.approve", edited.generationId)).map((a) => [a.decision, a.reason])).toEqual([["allow", "ok"]])
  })

  it("the pre-call budget is judged again just before the call: past it, the lease is released and the answer is 503 generation_busy, with no call made", async () => {
    const f = await newFirm()
    const g = (await start(f)).generationId
    const sent = scripted([{ text: outlineJson(ONE_SECTION.sections) }])
    // The clock moves 6,000 ms between the lease and the call (the party names, the prompt), and nowhere else.
    let offset = 0
    let fired = 0
    d4GenerationTestSeam.wallClock = () => Date.now() + offset
    d4GenerationTestSeam.beforeCall = async () => {
      fired += 1
      offset += 6_000
    }
    const logs = spyLogs()
    expect(await failure(outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 }))).toEqual([503, "generation_busy"])
    expect(fired).toBe(1)
    expect(logs.warn.mock.calls.filter((c) => c[0] === "d4.lease_released_after_error").map((c) => (c[1] as { code: string }).code)).toEqual(["released"])
    expect(sent).toHaveLength(0)
    expect(await docsOf("ai_usage_logs", f.firmId)).toHaveLength(0)
    expect(await briefOf(g)).toMatchObject({ inFlight: null, calls: 0, lastAttempt: null })
  })

  it("a failed call: 200 failed transport_error, billed on the brief as one call, the lease released, a deny audit row and no outline", async () => {
    const f = await newFirm()
    const g = (await start(f)).generationId
    let sends = 0
    setP1TransportForTests({
      async send() {
        sends += 1
        throw new P1TransportError("gateway_status", { billable: false, status: 500 })
      },
    })
    spyLogs()
    const r = await outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 })
    expect(sends).toBe(1)
    expect(r).toMatchObject({ outcome: "failed", reason: "transport_error", called: true, path: "ai", model: OPUS, usage: NO_USAGE, outlineVersion: 0, stage: "facts" })
    expect(r.usageLogId).not.toBeNull()
    const brief = (await briefOf(g))!
    expect(brief).toMatchObject({ calls: 1, costMicroUsd: 0, inFlight: null, outlineVersion: 0, stage: "facts", path: "ai" })
    expect(brief.lastAttempt).toMatchObject({ step: "outline", outcome: "failed", reason: "transport_error", usageLogId: r.usageLogId, costMicroUsd: 0, unsupportedRefs: [] })
    expect((await briefAudits(f, "draft.generate", g)).map((a) => [a.decision, a.reason])).toEqual([["deny", "transport_error"]])
    expect((await docsOf("ai_usage_logs", f.firmId)).map((u) => u.outcome)).toEqual(["failed"])
    expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(0)
  })

  it("the pre-call budget: past 5,000 ms before the lease commits is 503 generation_busy, with no call made and no lease left", async () => {
    const f = await newFirm()
    const g = (await start(f)).generationId
    const before = (await briefOf(g))!
    let t = Date.now(); d4GenerationTestSeam.wallClock = () => (t += 6_000); const sent = scripted([])
    expect((await apiErrorOf(outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 }))).code).toBe("generation_busy")
    expect(sent).toHaveLength(0); expect((await briefOf(g))!.inFlight).toBeNull()
    // Refused before the lease transaction: the brief is untouched, its updatedAt included.
    expect(await briefOf(g)).toEqual(before)
  })

  it("the pre-call budget past once the lease has committed releases the lease in its own transaction: 503 generation_busy, no call made, no lease left (D20)", async () => {
    const f = await newFirm()
    const g = (await start(f)).generationId
    const sent = scripted([])
    // The op's clock jumps 6,000 ms when a transaction commits; the lease transaction is the op's first.
    let offset = 0
    let fired = 0
    d4GenerationTestSeam.wallClock = () => Date.now() + offset
    const db = adminDb()
    const real = db.runTransaction.bind(db)
    vi.spyOn(db, "runTransaction").mockImplementation((async (fn: never, opts: never) => {
      const out = await real(fn, opts)
      fired += 1
      offset += 6_000
      return out
    }) as never)
    const logs = spyLogs()
    expect(await failure(outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 }))).toEqual([503, "generation_busy"])
    // The spy fired; the released lease below shows it fired between the lease commit and the post-commit check.
    expect(fired).toBeGreaterThanOrEqual(1)
    expect(logs.warn.mock.calls.filter((c) => c[0] === "d4.lease_released_after_error").map((c) => (c[1] as { code: string }).code)).toEqual(["released"])
    expect(sent).toHaveLength(0)
    expect(await briefOf(g)).toMatchObject({ inFlight: null, calls: 0, lastAttempt: null })
  })

  it("a throw after the lease commits and before the outcome write releases the lease: the request fails, nothing is billed or stored, and a retry runs at once (D27)", async () => {
    const f = await newFirm()
    const g = (await start(f)).generationId
    const logs = spyLogs()
    d4GenerationTestSeam.beforeCall = () => Promise.reject(Object.assign(new Error("boom"), { code: 14 })); const sent = scripted([{ text: outlineJson([{ heading: "Facts", purpose: "State the facts." }]) }])
    expect((await apiErrorOf(outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 }))).status).toBe(500)
    expect(await briefOf(g)).toMatchObject({ inFlight: null, calls: 0, outlineVersion: 0 }); expect(sent).toHaveLength(0); expect(await docsOf("ai_usage_logs", f.firmId)).toHaveLength(0)
    // The release is logged with ids and a code only.
    const released = logs.warn.mock.calls.filter((c) => c[0] === "d4.lease_released_after_error")
    expect(released).toHaveLength(1)
    expect(Object.keys(released[0]![1] as object).sort()).toEqual(["claimId", "code", "generationId"])
    expect(released[0]![1]).toMatchObject({ generationId: g, code: "released" })
    delete d4GenerationTestSeam.beforeCall
    expect(await outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 })).toMatchObject({ outcome: "stored", outlineVersion: 1 })
  })

  it("approveOutline with no edit of a version already approved under the same hash writes only its audit row", async () => {
    const f = await newFirm()
    const { generationId: g, sha } = await outlined(f)
    expect(await approveApi(f.A, { generationId: g, outlineVersion: 1, outlineSha256: sha, acknowledgedMissingFacts: [] })).toEqual({ generationId: g, stage: "approved", outlineVersion: 1, outlineSha256: sha, sectionCount: 1 })
    const briefBefore = (await briefOf(g))!
    await sleep(5)
    expect(await approveApi(f.P, { generationId: g, outlineVersion: 1, outlineSha256: sha, acknowledgedMissingFacts: [] })).toEqual({ generationId: g, stage: "approved", outlineVersion: 1, outlineSha256: sha, sectionCount: 1 })
    const briefAfter = (await briefOf(g))!
    expect(briefAfter.updatedAt.isEqual(briefBefore.updatedAt)).toBe(true)
    expect(briefAfter).toEqual(briefBefore)
    expect(briefAfter.approvedOutline.by).toBe(f.A.uid)
    expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(1)
    const audits = await docsOf("audit_log", f.firmId)
    // requirePermission writes its own rows (target matters/…); the call's rows target the brief
    expect(audits.filter((a) => a.action === "draft.outline.approve" && a.target === `draft_generations/${g}` && a.decision === "allow")).toHaveLength(2)
    expect(audits.filter((a) => a.action === "draft.outline.approve" && a.target === `matters/${f.matterId}` && a.decision === "allow")).toHaveLength(2)
  })

  it("getOutline returns the current or a named version with approved; an absent version is 404 outline_not_found; a closed matter is 409 matter_closed for generateOutline and approveOutline", async () => {
    const f = await newFirm()
    const fresh = (await start(f)).generationId
    expect(await failure(getOutlineApi(f.A, { generationId: fresh }))).toEqual([404, "outline_not_found"])
    expect(await failure(getOutlineApi(f.A, { generationId: fresh, version: "1" }))).toEqual([404, "outline_not_found"])
    const { generationId: g, sha } = await outlined(f)
    expect(await getOutlineApi(f.C, { generationId: g })).toMatchObject({ version: 1, approved: false })
    await approveApi(f.A, { generationId: g, outlineVersion: 1, outlineSha256: sha, acknowledgedMissingFacts: [] })
    expect(await getOutlineApi(f.C, { generationId: g })).toMatchObject({ version: 1, approved: true }); expect((await getOutlineApi(f.C, { generationId: g, version: "9" }).catch((e) => e)).code).toBe("outline_not_found")
    const view = await getOutlineApi(f.low, { generationId: g, version: "1" })
    const stored = (await outlineDocOf(g, 1))!
    expect(view).toEqual({
      generationId: g,
      version: 1,
      kind: "generated",
      sections: ONE_SECTION.sections,
      missingFacts: [],
      sha256: sha,
      classification: "internal",
      editedFrom: null,
      path: "ai",
      model: OPUS,
      promptVersion: "4b.1",
      traceId: stored.traceId,
      inputTokens: 1000,
      outputTokens: 500,
      costMicroUsd: 14000,
      usageLogId: stored.usageLogId,
      createdBy: f.A.uid,
      createdAt: (stored.createdAt as Timestamp).toDate().toISOString(),
      approved: true,
    })
    expect((await briefAudits(f, "draft.read", g)).filter((a) => a.decision === "allow").length).toBeGreaterThan(0)
    // A newer version voids the approval: neither version reads as approved.
    scripted([{ text: outlineJson([{ heading: "Grounds", purpose: "Argue." }]) }])
    await outlineApi(f.A, { generationId: g, baseOutlineVersion: 1 })
    expect(await getOutlineApi(f.C, { generationId: g })).toMatchObject({ version: 2, approved: false, sections: [{ heading: "Grounds", purpose: "Argue." }] })
    expect(await getOutlineApi(f.C, { generationId: g, version: "1" })).toMatchObject({ version: 1, approved: false })
    // The roles and the brief's rules are getGeneration's.
    expect(await failure(getOutlineApi(f.intern, { generationId: g }))).toEqual([403, "intern_channel_denied"])
    expect(await failure(getOutlineApi(f.outsider, { generationId: g }))).toEqual([403, "not_member"])
    expect(await failure(getOutlineApi((await newFirm()).A, { generationId: g }))).toEqual([404, "not_found"])
    // status set to "closed": generateOutline and approveOutline each give 409 matter_closed
    const sha2 = (await outlineDocOf(g, 2))!.sha256 as string
    await adminDb().collection("matters").doc(f.matterId).update({ status: "closed" })
    const sent = scripted([])
    expect(await failure(outlineApi(f.A, { generationId: g, baseOutlineVersion: 2 }))).toEqual([409, "matter_closed"])
    // Before the stored result too: a closed matter answers no step.
    expect(await failure(outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 }))).toEqual([409, "matter_closed"])
    expect(await failure(approveApi(f.A, { generationId: g, outlineVersion: 2, outlineSha256: sha2, acknowledgedMissingFacts: [] }))).toEqual([409, "matter_closed"])
    expect(sent).toHaveLength(0)
    // Reading stays open.
    expect(await getOutlineApi(f.A, { generationId: g })).toMatchObject({ version: 2 })
  })

  it("generateOutline, approveOutline and getOutline check their fields in order before the permission", async () => {
    const f = await newFirm()
    const { generationId: g, sha } = await outlined(f)
    // As the intern: a 403 would show if the permission ran before a check.
    const gen = async (data: Record<string, unknown>) => (await failure(outlineApi(f.intern, data)))[1]
    expect(await gen({})).toBe("invalid_generation_id")
    expect(await gen({ generationId: "", baseOutlineVersion: 0 })).toBe("invalid_generation_id")
    for (const base of [undefined, null, -1, 1.5, "0", Number.MAX_SAFE_INTEGER + 1]) expect([String(base), await gen({ generationId: g, baseOutlineVersion: base })]).toEqual([String(base), "invalid_version"])
    expect(await gen({ generationId: g, baseOutlineVersion: 0 })).toBe("intern_channel_denied")
    expect(await failure(outlineApi(f.A, { generationId: "no-such-generation", baseOutlineVersion: 0 }))).toEqual([404, "not_found"])

    const valid = { generationId: g, outlineVersion: 1, outlineSha256: sha, outline: ONE_SECTION, acknowledgedMissingFacts: [] }
    const approve = async (over: Record<string, unknown>) => (await failure(approveApi(f.intern, { ...valid, ...over })))[1]
    expect(await approve({ generationId: 5, outlineVersion: 0, outlineSha256: "x", outline: {}, acknowledgedMissingFacts: "x" })).toBe("invalid_generation_id")
    expect(await approve({ outlineVersion: 0, outlineSha256: "x", outline: {}, acknowledgedMissingFacts: "x" })).toBe("invalid_version")
    expect(await approve({ outlineSha256: "x", outline: {}, acknowledgedMissingFacts: "x" })).toBe("invalid_outline_hash")
    expect(await approve({ outline: {}, acknowledgedMissingFacts: "x" })).toBe("invalid_outline")
    expect(await approve({ acknowledgedMissingFacts: "x" })).toBe("invalid_acknowledgement")
    for (const v of [undefined, 0, -1, "1", 1.5]) expect([String(v), await approve({ outlineVersion: v })]).toEqual([String(v), "invalid_version"])
    for (const h of [undefined, sha.toUpperCase(), sha.slice(1), `${sha}0`, "g".repeat(64)]) expect([String(h).slice(0, 8), await approve({ outlineSha256: h })]).toEqual([String(h).slice(0, 8), "invalid_outline_hash"])
    for (const o of [null, "x", [], { sections: [] , missingFacts: [] }, { ...ONE_SECTION, extra: 1 }]) expect([JSON.stringify(o), await approve({ outline: o })]).toEqual([JSON.stringify(o), "invalid_outline"])
    for (const a of [undefined, null, {}, [0, 0], [50], [-1], [1.5], ["0"], [null]]) expect([JSON.stringify(a), await approve({ acknowledgedMissingFacts: a })]).toEqual([JSON.stringify(a), "invalid_acknowledgement"])
    expect(await approve({})).toBe("intern_channel_denied")
    expect(await approve({ outline: undefined })).toBe("intern_channel_denied")
    expect(await approve({ acknowledgedMissingFacts: Array.from({ length: 50 }, (_, i) => 49 - i) })).toBe("intern_channel_denied")

    const read = async (data: Record<string, unknown>) => (await failure(getOutlineApi(f.intern, data)))[1]
    expect(await read({})).toBe("invalid_generation_id")
    for (const v of ["0", "01", "x", "-1", "1.0", "1234567890", ""]) expect([v, await read({ generationId: g, version: v })]).toEqual([v, "invalid_version"])
    expect(await read({ generationId: g, version: "1" })).toBe("intern_channel_denied")
    expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(1)
  })
})
