import { createHash } from "node:crypto"
import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { adminDb } from "../src/admin"
import { InMemoryAuthorityStore, setAuthorityStoreForTests, type AuthorityStore } from "../src/d4/authority"
import { approvalPasses, clearedItemsOf, normaliseEvaluation, parseTemporalChecks } from "../src/d4/gateOps"
import type { GateEvaluation } from "../src/d4/types"
import { ApiError, apiErrorOf, viaApi } from "./api"
import { EMULATORS, mintIdToken, uniq } from "./emu"

/**
 * Phase 4a Task 3 (spec P4-6..P4-9, P4-12, P4-14): the citation gate, the partner override and the approval stand-in,
 * through the HTTP router over the Auth and Firestore emulators, on an in-memory authority store seeded with 2099
 * fixtures (P4-13: no real judgment, statute or party is named). Every stored value is read back with the Admin SDK,
 * so a response alone never proves a write.
 */

type View = {
  draftId: string
  matterId: string
  documentTypeId: string
  title: string
  classification: string
  status: string
  currentVersion: number
  currentBodySha256: string
  locked: boolean
  gateResult: null | { version: number; bodySha256: string; status: string; gatedAt: string | null; overridden: boolean }
  approvedBy?: string
  approvedAt?: string | null
  approvedVersion?: number
  updatedAt: string
}
type Saved = { saved: boolean; draft: View }
type CitationFinding = { ref: string; judgmentId: string | null; status: string }
type TemporalFinding = { sectionId: string; asAtDate: string; jurisdiction: string; usedText: string; status: string; inForceText: string | null }
type GateResult = {
  draftId: string
  version: number
  bodySha256: string
  status: string
  citations: CitationFinding[]
  temporal: TemporalFinding[]
  gatedBy: string
  gatedAt: string
}
type OverrideView = { draftId: string; version: number; bodySha256: string; by: string; at: string; reason: string; cleared: Array<Record<string, unknown>> }
type Report = { gateResult: GateResult | null; override: OverrideView | null; current: boolean }
type Overridden = { override: OverrideView; draft: View }
type Approved = { draft: View; gateResult: GateResult }

const createApi = viaApi<View>("createDraft")
const saveApi = viaApi<Saved>("saveDraftVersion")
const restoreApi = viaApi<Saved>("restoreDraftVersion")
const gateApi = viaApi<GateResult>("gateDraft")
const reportApi = viaApi<Report>("getVerificationReport")
const overrideApi = viaApi<Overridden>("overrideGate")
const approveApi = viaApi<Approved>("approveDraft")

const TYPE = "constitutional_petition_199"
const TITLE = "Petition against the impugned order"
/** Cites a division-bench judgment the store records as overruled by a larger bench. */
const BODY_OVERRULED = "The petitioner relies on PLD 2099 SC 101 for the rule.\nThe respondents have failed to act."
/** Cites a judgment the store knows and nobody has overruled. */
const BODY_VERIFIED = "The petitioner relies on 2099 SCMR 7 for the rule."
/** Cites a judgment the store does not know. */
const BODY_UNKNOWN = "The petitioner relies on PLD 2099 SC 202 for the rule."
/** Cites nothing. */
const BODY_PLAIN = "The petitioner submits as follows. The respondents have failed to act."
const TEXT_2015 = "Test Act s.1 as it stood in 2015: the limit is thirty days."
const TEXT_2018 = "Test Act s.1 as amended in 2018: the limit is sixty days."
const REASON = "The overruling bench decided a different question; the partner accepts the risk on the record."

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
const claims = (firmId: string, role: string, clearanceLevel = "privileged-restricted") => ({ firmId, role, clearanceLevel })
const check = (usedText: string, asAtDate = "2015-03-01", sectionId = "test_act_s1", jurisdiction = "PK") => ({ sectionId, asAtDate, jurisdiction, usedText })

/** The seeded corpus (P4-13): one overruled judgment, one verified one, and the two versions of test_act_s1 in PK. */
function seededStore(): InMemoryAuthorityStore {
  const s = new InMemoryAuthorityStore()
  s.addJudgment("j_101", "PLD 2099 SC 101", "division")
  s.addJudgment("j_900", "PLD 2099 SC 900", "larger")
  s.addTreatment("j_900", "j_101", "overruled", "larger")
  s.addJudgment("j_7", "2099 SCMR 7", "full")
  s.addSectionVersion("test_act_s1", "PK", "2010-01-01", "2018-06-01", TEXT_2015)
  s.addSectionVersion("test_act_s1", "PK", "2018-06-01", null, TEXT_2018)
  return s
}

let store: InMemoryAuthorityStore
beforeEach(() => {
  store = seededStore()
  setAuthorityStoreForTests(store)
})
afterEach(() => {
  setAuthorityStoreForTests(null)
})

type Member = { uid: string; token: string }
type Firm = {
  firmId: string
  matterId: string
  P: Member
  A: Member
  C: Member
  intern: Member
  accounts: Member
  client: Member
  /** A partner of the firm who is not a member of the matter. */
  outsider: Member
}

async function addMember(firmId: string, matterId: string, uid: string): Promise<void> {
  await adminDb().collection("matter_members").doc(`${matterId}_${uid}`).set({ firmId, matterId, userId: uid, classification: "internal" })
}

async function newFirm(): Promise<Firm> {
  const firmId = uniq("firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal", rateLimits: { general: 1000 } })
  const matterId = uniq("matter")
  await adminDb()
    .collection("matters")
    .doc(matterId)
    .set({ firmId, classification: "internal", title: "Recovery suit", stage: "pre_filing", status: "open", createdAt: Timestamp.now() })
  const mint = async (role: string, member = true): Promise<Member> => {
    const m = await mintIdToken(claims(firmId, role))
    if (member) await addMember(firmId, matterId, m.uid)
    return m
  }
  const [P, A, C, intern, accounts, client, outsider] = [
    await mint("partner"),
    await mint("associate"),
    await mint("clerk"),
    await mint("intern"),
    await mint("accounts"),
    await mint("client"),
    await mint("partner", false),
  ]
  return { firmId, matterId, P, A, C, intern, accounts, client, outsider }
}

/** A member of the matter whose token claims `claimed` while the authoritative users record says `actual`. */
async function spoofed(f: Firm, claimed: string, actual: string): Promise<Member> {
  const m = await mintIdToken(claims(f.firmId, claimed), { userDoc: false })
  await adminDb().collection("users").doc(m.uid).set({ firmId: f.firmId, role: actual, clearanceLevel: "privileged-restricted", active: true })
  await addMember(f.firmId, f.matterId, m.uid)
  return m
}

/** A second partner who is a member of the matter. */
async function memberPartner(f: Firm): Promise<Member> {
  const m = await mintIdToken(claims(f.firmId, "partner"))
  await addMember(f.firmId, f.matterId, m.uid)
  return m
}

const send = <T>(api: (c: never) => Promise<T>, f: Firm, m: Member, data: Record<string, unknown>): Promise<T> =>
  api({ token: m.token, data: { firmId: f.firmId, ...data } } as never)

const create = (f: Firm, m: Member, body: string, title = TITLE) => send(createApi, f, m, { matterId: f.matterId, documentTypeId: TYPE, title, body })
const save = (f: Firm, m: Member, draftId: string, baseVersion: number, body: string, title = TITLE) => send(saveApi, f, m, { draftId, baseVersion, title, body })
const restore = (f: Firm, m: Member, draftId: string, baseVersion: number, fromVersion: number) => send(restoreApi, f, m, { draftId, baseVersion, fromVersion })
const gate = (f: Firm, m: Member, draftId: string, version: unknown, temporalChecks?: unknown) =>
  send(gateApi, f, m, { draftId, version, ...(temporalChecks === undefined ? {} : { temporalChecks }) })
const report = (f: Firm, m: Member, draftId: string) => send(reportApi, f, m, { draftId })
const override = (f: Firm, m: Member, draftId: string, version: unknown, reason: unknown = REASON, extra: Record<string, unknown> = {}) =>
  send(overrideApi, f, m, { draftId, version, reason, ...extra })
const approve = (f: Firm, m: Member, draftId: string, version: unknown) => send(approveApi, f, m, { draftId, version })

function expectErr(err: ApiError, status: number, code: string): void {
  expect({ status: err.status, code: err.code }).toEqual({ status, code })
}

const draftDoc = async (id: string) => (await adminDb().collection("drafts").doc(id).get()).data()
const versionDoc = async (id: string, n: number) => (await adminDb().collection("draft_versions").doc(`${id}_${n}`).get()).data()
const resultDoc = async (id: string, n: number) => (await adminDb().collection("draft_gate_results").doc(`${id}_${n}`).get()).data()
const overrideDoc = async (id: string, n: number) => (await adminDb().collection("draft_gate_overrides").doc(`${id}_${n}`).get()).data()
const byFirm = async (collection: string, firmId: string): Promise<Array<{ id: string; data: DocumentData }>> =>
  (await adminDb().collection(collection).where("firmId", "==", firmId).get()).docs.map((d) => ({ id: d.id, data: d.data() }))
const eventsNamed = async (firmId: string, draftId: string, name: string) =>
  (await byFirm("events", firmId)).filter((e) => e.data.payload?.draftId === draftId && e.data.name === name)
/** Audit rows with the given action and target (the routes' own CallAudit rows). */
const auditRows = async (action: string, target: string) =>
  (await adminDb().collection("audit_log").where("action", "==", action).where("target", "==", target).get()).docs.map((d) => d.data())

// ---------------------------------------------------------------------------
// Pure helpers (no emulator): the status domain and the approval rule.
// ---------------------------------------------------------------------------

describe("normaliseEvaluation: the status domain before anything is stored or compared", () => {
  it("a citation status outside VERIFIED / UNVERIFIED / OVERRULED becomes UNVERIFIED, and the overall status is recomputed from the findings", () => {
    const raw = { status: "OK", citations: [{ ref: "PLD 2099 SC 1", judgmentId: "j", status: "OK" }], temporal: [] } as unknown as GateEvaluation
    const out = normaliseEvaluation(raw)
    expect(out.citations).toEqual([{ ref: "PLD 2099 SC 1", judgmentId: "j", status: "UNVERIFIED" }])
    expect(out.status).toBe("UNVERIFIED")
  })

  it("a temporal status outside the temporal domain becomes TEMPORAL_UNAVAILABLE (verify manually), never OK", () => {
    const raw = {
      status: "OK",
      citations: [],
      temporal: [{ ...check(TEXT_2015), status: "PASSED", inForceText: TEXT_2015 }],
    } as unknown as GateEvaluation
    const out = normaliseEvaluation(raw)
    expect(out.temporal[0].status).toBe("TEMPORAL_UNAVAILABLE")
    expect(out.status).toBe("TEMPORAL_UNAVAILABLE")
  })

  it("an overall status outside the domain is UNVERIFIED, and a more severe finding still wins", () => {
    expect(normaliseEvaluation({ status: "FINE", citations: [], temporal: [] } as unknown as GateEvaluation).status).toBe("UNVERIFIED")
    const raw = { status: "FINE", citations: [{ ref: "PLD 2099 SC 101", judgmentId: "j_101", status: "OVERRULED" }], temporal: [] } as unknown as GateEvaluation
    expect(normaliseEvaluation(raw).status).toBe("OVERRULED")
  })

  it("never lowers the runner's overall status: a stated OVERRULED stays OVERRULED", () => {
    const raw: GateEvaluation = { status: "OVERRULED", citations: [], temporal: [] }
    expect(normaliseEvaluation(raw).status).toBe("OVERRULED")
  })

  it("keeps only the named fields of each finding", () => {
    const raw = {
      status: "UNVERIFIED",
      citations: [{ ref: "PLD 2099 SC 202", judgmentId: null, status: "UNVERIFIED", forged: true }],
      temporal: [{ ...check(TEXT_2015), status: "OK", inForceText: TEXT_2015, extra: "x" }],
    } as unknown as GateEvaluation
    const out = normaliseEvaluation(raw)
    expect(out.citations[0]).toEqual({ ref: "PLD 2099 SC 202", judgmentId: null, status: "UNVERIFIED" })
    expect(out.temporal[0]).toEqual({ ...check(TEXT_2015), status: "OK", inForceText: TEXT_2015 })
  })
})

describe("approvalPasses and clearedItemsOf (P4-7, P4-8)", () => {
  const hash = "a".repeat(64)
  const evaluation = (citations: CitationFinding[], temporal: TemporalFinding[] = []): GateEvaluation =>
    normaliseEvaluation({ status: "OK", citations, temporal } as unknown as GateEvaluation)
  const unknown = { ref: "PLD 2099 SC 202", judgmentId: null, status: "UNVERIFIED" }
  const overruled = { ref: "PLD 2099 SC 101", judgmentId: "j_101", status: "OVERRULED" }
  const verified = { ref: "2099 SCMR 7", judgmentId: "j_7", status: "VERIFIED" }
  const unavailable = { ...check(TEXT_2015, "2015-03-01", "test_act_s9"), status: "TEMPORAL_UNAVAILABLE", inForceText: null }
  const okCheck = { ...check(TEXT_2015), status: "OK", inForceText: TEXT_2015 }

  it("clearedItemsOf lists every non-OK citation and temporal entry with its status, and nothing that passed", () => {
    expect(clearedItemsOf(evaluation([verified, unknown, overruled], [okCheck, unavailable]))).toEqual([
      { kind: "citation", ref: "PLD 2099 SC 202", status: "UNVERIFIED" },
      { kind: "citation", ref: "PLD 2099 SC 101", status: "OVERRULED" },
      { kind: "temporal", sectionId: "test_act_s9", asAtDate: "2015-03-01", jurisdiction: "PK", status: "TEMPORAL_UNAVAILABLE" },
    ])
  })

  it("an OK evaluation passes with or without an override", () => {
    expect(approvalPasses(evaluation([verified], [okCheck]), null, hash)).toEqual({ pass: true, overrideUsed: false })
    const o = { bodySha256: hash, cleared: [{ kind: "citation", ref: "PLD 2099 SC 202", status: "UNVERIFIED" }] }
    expect(approvalPasses(evaluation([verified]), o, hash)).toEqual({ pass: true, overrideUsed: false })
  })

  it("a non-OK evaluation passes only when an override with the same hash clears every non-OK item with the same status", () => {
    const e = evaluation([verified, unknown], [unavailable])
    const cleared = clearedItemsOf(e)
    expect(approvalPasses(e, null, hash)).toEqual({ pass: false, overrideUsed: false })
    expect(approvalPasses(e, { bodySha256: hash, cleared }, hash)).toEqual({ pass: true, overrideUsed: true })
    // Another hash: the override is bound to a body that is not this one.
    expect(approvalPasses(e, { bodySha256: "b".repeat(64), cleared }, hash).pass).toBe(false)
    // One item missing from the cleared set.
    expect(approvalPasses(e, { bodySha256: hash, cleared: cleared.slice(1) }, hash).pass).toBe(false)
  })

  it("a cleared UNVERIFIED that is now OVERRULED is not cleared; a cleared TEMPORAL_UNAVAILABLE that is now a mismatch is not cleared", () => {
    const before = evaluation([{ ...overruled, status: "UNVERIFIED" }], [unavailable])
    const o = { bodySha256: hash, cleared: clearedItemsOf(before) }
    expect(approvalPasses(evaluation([overruled], [unavailable]), o, hash).pass).toBe(false)
    expect(approvalPasses(evaluation([{ ...overruled, status: "UNVERIFIED" }], [{ ...unavailable, status: "TEMPORAL_MISMATCH", inForceText: "x" }]), o, hash).pass).toBe(false)
  })

  it("a non-OK status with no non-OK item to name cannot be cleared, even by an override with an empty list", () => {
    const e = normaliseEvaluation({ status: "UNVERIFIED", citations: [], temporal: [] })
    expect(e.status).toBe("UNVERIFIED")
    expect(approvalPasses(e, { bodySha256: hash, cleared: [] }, hash)).toEqual({ pass: false, overrideUsed: false })
  })

  it("a cleared item whose kind or status is outside the domain clears nothing (fails closed)", () => {
    const e = evaluation([unknown])
    expect(approvalPasses(e, { bodySha256: hash, cleared: [{ kind: "citation", ref: "PLD 2099 SC 202", status: "ANY" }] }, hash).pass).toBe(false)
    expect(approvalPasses(e, { bodySha256: hash, cleared: [{ kind: "authority", ref: "PLD 2099 SC 202", status: "UNVERIFIED" }] }, hash).pass).toBe(false)
    expect(approvalPasses(e, { bodySha256: hash, cleared: "everything" as never }, hash).pass).toBe(false)
  })
})

describe("parseTemporalChecks (P4-6): 400 invalid_temporal_checks", () => {
  const bad = (value: unknown) => {
    try {
      parseTemporalChecks(value)
    } catch (err) {
      return (err as { status?: number; code?: string }).status === 400 && (err as { code?: string }).code === "invalid_temporal_checks"
    }
    return false
  }

  it("absent is no checks; anything but an array is refused", () => {
    expect(parseTemporalChecks(undefined)).toEqual([])
    for (const v of [null, "x", 1, {}, true]) expect([v, bad(v)]).toEqual([v, true])
  })

  it("at most 20 entries; each entry an object with the four fields", () => {
    expect(parseTemporalChecks(Array.from({ length: 20 }, () => check(TEXT_2015)))).toHaveLength(20)
    expect(bad(Array.from({ length: 21 }, () => check(TEXT_2015)))).toBe(true)
    for (const entry of [null, "x", [], 7]) expect([entry, bad([entry])]).toEqual([entry, true])
    for (const field of ["sectionId", "asAtDate", "jurisdiction", "usedText"]) {
      const entry: Record<string, unknown> = { ...check(TEXT_2015) }
      delete entry[field]
      expect([field, bad([entry])]).toEqual([field, true])
    }
  })

  it("sectionId matches /^[A-Za-z0-9_.:-]{1,200}$/", () => {
    for (const ok of ["test_act_s1", "a", "A.b:c-d_1", "x".repeat(200)]) expect(parseTemporalChecks([{ ...check(TEXT_2015), sectionId: ok }])[0].sectionId).toBe(ok)
    for (const no of ["", "x".repeat(201), "test act", "a/b", "s\u00e9c", "a|b", 12]) expect([no, bad([{ ...check(TEXT_2015), sectionId: no }])]).toEqual([no, true])
  })

  it("asAtDate is a real YYYY-MM-DD calendar date", () => {
    for (const ok of ["2015-03-01", "2016-02-29", "2000-02-29", "2099-12-31", "0001-01-01"]) expect(parseTemporalChecks([check(TEXT_2015, ok)])[0].asAtDate).toBe(ok)
    for (const no of ["2015-02-30", "2019-02-29", "1900-02-29", "2015-13-01", "2015-00-10", "2015-01-00", "2015-04-31", "15-03-01", "2015-3-1", "2015-03-01T00:00:00Z", " 2015-03-01", "0000-01-01", "", 20150301]) {
      expect([no, bad([check(TEXT_2015, no as string)])]).toEqual([no, true])
    }
  })

  it("jurisdiction is 1 to 50 characters; usedText is 1 to 10,000 characters", () => {
    expect(parseTemporalChecks([check(TEXT_2015, "2015-03-01", "test_act_s1", "J".repeat(50))])[0].jurisdiction).toHaveLength(50)
    expect(bad([check(TEXT_2015, "2015-03-01", "test_act_s1", "J".repeat(51))])).toBe(true)
    expect(bad([check(TEXT_2015, "2015-03-01", "test_act_s1", "")])).toBe(true)
    expect(bad([{ ...check(TEXT_2015), jurisdiction: 5 }])).toBe(true)
    expect(parseTemporalChecks([check("u".repeat(10_000))])[0].usedText).toHaveLength(10_000)
    expect(bad([check("u".repeat(10_001))])).toBe(true)
    expect(bad([check("")])).toBe(true)
    expect(bad([{ ...check(TEXT_2015), usedText: ["x"] }])).toBe(true)
  })

  it("returns only the four fields of each entry (anything else the caller sent is dropped)", () => {
    expect(parseTemporalChecks([{ ...check(TEXT_2015), status: "OK", inForceText: TEXT_2015 }])).toEqual([check(TEXT_2015)])
  })
})

// ---------------------------------------------------------------------------
// The named G-1 equivalents (P4-14). The Phase 4a gate script selects these two by name.
// ---------------------------------------------------------------------------

describe.skipIf(!EMULATORS)("G-1 equivalents (P4-14)", () => {
  it("G-1 test 4: an authority overruled by a larger bench blocks approval until the matter's partner overrides with a reason", async () => {
    const f = await newFirm()
    const other = await newFirm()
    const d = await create(f, f.A, BODY_OVERRULED)

    // The gate reports OVERRULED, and approval is blocked.
    const gated = await gate(f, f.A, d.draftId, 1)
    expect(gated.status).toBe("OVERRULED")
    expect(gated.citations).toEqual([{ ref: "PLD 2099 SC 101", judgmentId: "j_101", status: "OVERRULED" }])
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, 1)), 409, "gate_blocked")
    expect((await draftDoc(d.draftId))?.locked).toBe(false)

    // Nobody but the matter's partner may override, and the partner needs a reason.
    expectErr(await apiErrorOf(override(f, f.intern, d.draftId, 1)), 403, "intern_channel_denied")
    expectErr(await apiErrorOf(override(f, f.A, d.draftId, 1)), 403, "role_not_permitted")
    expectErr(await apiErrorOf(override(f, f.A, d.draftId, 1, REASON, { by: f.P.uid, partnerId: f.P.uid })), 403, "role_not_permitted")
    expectErr(await apiErrorOf(override(other, other.P, d.draftId, 1)), 404, "not_found")
    expectErr(await apiErrorOf(override(f, f.outsider, d.draftId, 1)), 403, "not_member")
    const forged = await spoofed(f, "partner", "associate")
    expectErr(await apiErrorOf(override(f, forged, d.draftId, 1)), 401, "claims_stale")
    expectErr(await apiErrorOf(override(f, f.P, d.draftId, 1, "Too short a reason")), 400, "invalid_reason")
    expect(await overrideDoc(d.draftId, 1)).toBeUndefined()

    // The member partner overrides; a `by` or `partnerId` in the body is ignored: the actor is the authenticated caller.
    const o = await override(f, f.P, d.draftId, 1, REASON, { by: f.A.uid, partnerId: f.A.uid })
    const stored = await overrideDoc(d.draftId, 1)
    expect(stored).toEqual({
      firmId: f.firmId,
      matterId: f.matterId,
      draftId: d.draftId,
      version: 1,
      bodySha256: sha(BODY_OVERRULED),
      by: f.P.uid,
      at: stored?.at,
      reason: REASON,
      cleared: [{ kind: "citation", ref: "PLD 2099 SC 101", status: "OVERRULED" }],
    })
    expect(stored?.at).toBeInstanceOf(Timestamp)
    expect(o.override.by).toBe(f.P.uid)
    expect(o.draft.gateResult?.overridden).toBe(true)
    const rows = await auditRows("draft.gate_override", `draft_gate_overrides/${d.draftId}_1`)
    expect(rows.filter((r) => r.decision === "allow")).toEqual([expect.objectContaining({ actorId: f.P.uid, firmId: f.firmId, decision: "allow", reason: "ok" })])

    // Approval now passes: the draft is approved and locked, and draft.approved is written once.
    const a = await approve(f, f.P, d.draftId, 1)
    expect(a.draft).toMatchObject({ status: "approved", locked: true, approvedBy: f.P.uid, approvedVersion: 1 })
    expect(a.draft.gateResult).toMatchObject({ version: 1, status: "OVERRULED", overridden: true })
    expect(await draftDoc(d.draftId)).toMatchObject({ status: "approved", locked: true, approvedBy: f.P.uid, approvedVersion: 1 })
    const approved = await eventsNamed(f.firmId, d.draftId, "draft.approved")
    expect(approved.map((e) => e.id)).toEqual([`${d.draftId}_1_approved`])
    expect(approved[0].data.payload).toEqual({ draftId: d.draftId, matterId: f.matterId, documentTypeId: TYPE, version: 1, gateResult: "OVERRULED", masterVersion: null })
  })

  it("G-1 test 5: a 2015-dated check against a section amended in 2018 is TEMPORAL_MISMATCH with both texts; no history is TEMPORAL_UNAVAILABLE", async () => {
    const f = await newFirm()
    const d = await create(f, f.P, BODY_PLAIN)

    // A 2015 date, pleaded with the 2018 text: a mismatch that carries the text in force in 2015 beside the text used.
    const mismatch = await gate(f, f.A, d.draftId, 1, [check(TEXT_2018)])
    expect(mismatch.status).toBe("TEMPORAL_MISMATCH")
    expect(mismatch.temporal).toEqual([{ sectionId: "test_act_s1", asAtDate: "2015-03-01", jurisdiction: "PK", usedText: TEXT_2018, status: "TEMPORAL_MISMATCH", inForceText: TEXT_2015 }])
    expect((await resultDoc(d.draftId, 1))?.temporal).toEqual(mismatch.temporal)
    expect((await report(f, f.A, d.draftId)).gateResult?.temporal).toEqual(mismatch.temporal)

    // The 2015 text for the 2015 date is OK.
    expect((await gate(f, f.A, d.draftId, 1, [check(TEXT_2015)])).status).toBe("OK")

    // No history for the section, or none in the jurisdiction: verify manually, never a silent pass.
    const none = await gate(f, f.A, d.draftId, 1, [check(TEXT_2015, "2015-03-01", "test_act_s9"), check(TEXT_2015, "2015-03-01", "test_act_s1", "AJK")])
    expect(none.status).toBe("TEMPORAL_UNAVAILABLE")
    expect(none.temporal.map((t) => [t.sectionId, t.jurisdiction, t.status, t.inForceText])).toEqual([
      ["test_act_s9", "PK", "TEMPORAL_UNAVAILABLE", null],
      ["test_act_s1", "AJK", "TEMPORAL_UNAVAILABLE", null],
    ])
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, 1)), 409, "gate_blocked")
  })
})

// ---------------------------------------------------------------------------
// gateDraft
// ---------------------------------------------------------------------------

describe.skipIf(!EMULATORS)("gateDraft (P4-6, P4-12)", () => {
  it("gates the current version: the result, the draft's summary, the draft.gated event and the audit row in one go", async () => {
    const f = await newFirm()
    const d = await create(f, f.P, `${BODY_OVERRULED}\nSee also 2099 SCMR 7 and PLD 2099 SC 202.`)
    const body = `${BODY_OVERRULED}\nSee also 2099 SCMR 7 and PLD 2099 SC 202.`
    const r = await gate(f, f.C, d.draftId, 1, [check(TEXT_2018)])
    expect(r).toEqual({
      draftId: d.draftId,
      version: 1,
      bodySha256: sha(body),
      status: "OVERRULED",
      citations: [
        { ref: "PLD 2099 SC 101", judgmentId: "j_101", status: "OVERRULED" },
        { ref: "2099 SCMR 7", judgmentId: "j_7", status: "VERIFIED" },
        { ref: "PLD 2099 SC 202", judgmentId: null, status: "UNVERIFIED" },
      ],
      temporal: [{ ...check(TEXT_2018), status: "TEMPORAL_MISMATCH", inForceText: TEXT_2015 }],
      gatedBy: f.C.uid,
      gatedAt: r.gatedAt,
    })
    expect(new Date(r.gatedAt).toISOString()).toBe(r.gatedAt)

    const stored = await resultDoc(d.draftId, 1)
    expect(stored).toMatchObject({
      firmId: f.firmId,
      matterId: f.matterId,
      draftId: d.draftId,
      version: 1,
      bodySha256: sha(body),
      status: "OVERRULED",
      citations: r.citations,
      temporal: r.temporal,
      gatedBy: f.C.uid,
      gateRuns: 1,
    })
    expect((stored?.gatedAt as Timestamp).toDate().toISOString()).toBe(r.gatedAt)

    const draft = await draftDoc(d.draftId)
    expect(draft?.gateResult).toEqual({ version: 1, bodySha256: sha(body), status: "OVERRULED", gatedAt: stored?.gatedAt, overridden: false })
    expect(draft).toMatchObject({ status: "draft", locked: false, currentVersion: 1 })

    const events = await eventsNamed(f.firmId, d.draftId, "draft.gated")
    expect(events.map((e) => e.id)).toEqual([`${d.draftId}_1_gated_1`])
    expect(events[0].data).toMatchObject({
      name: "draft.gated",
      firmId: f.firmId,
      classification: "internal",
      payload: { draftId: d.draftId, matterId: f.matterId, documentTypeId: TYPE, version: 1, gateResult: "OVERRULED", masterVersion: null },
      idempotencyKey: `${d.draftId}:1:gated_1`,
    })
    expect(await auditRows("draft.gate", `drafts/${d.draftId}`)).toEqual([expect.objectContaining({ actorId: f.C.uid, firmId: f.firmId, decision: "allow", reason: "ok" })])
  })

  it("reports and never rewrites: the version's title and body are unchanged and no version is added", async () => {
    const f = await newFirm()
    const d = await create(f, f.P, BODY_UNKNOWN)
    const before = await versionDoc(d.draftId, 1)
    await gate(f, f.P, d.draftId, 1)
    expect(await versionDoc(d.draftId, 1)).toEqual(before)
    expect(await byFirm("draft_versions", f.firmId)).toHaveLength(1)
    expect((await draftDoc(d.draftId))?.currentBodySha256).toBe(sha(BODY_UNKNOWN))
  })

  it("reads citations from the title as well as the body", async () => {
    const f = await newFirm()
    const d = await create(f, f.P, BODY_PLAIN, "Appeal under PLD 2099 SC 101")
    const r = await gate(f, f.P, d.draftId, 1)
    expect(r.citations).toEqual([{ ref: "PLD 2099 SC 101", judgmentId: "j_101", status: "OVERRULED" }])
  })

  it("re-gating the same version replaces the result and writes a distinct draft.gated event per run", async () => {
    const f = await newFirm()
    const d = await create(f, f.P, BODY_UNKNOWN)
    const first = await gate(f, f.P, d.draftId, 1)
    expect(first.status).toBe("UNVERIFIED")
    store.addJudgment("j_202", "PLD 2099 SC 202", "division")
    const second = await gate(f, f.A, d.draftId, 1)
    expect(second.status).toBe("OK")
    const stored = await resultDoc(d.draftId, 1)
    expect(stored).toMatchObject({ status: "OK", gatedBy: f.A.uid, gateRuns: 2, citations: [{ ref: "PLD 2099 SC 202", judgmentId: "j_202", status: "VERIFIED" }] })
    expect(await byFirm("draft_gate_results", f.firmId)).toHaveLength(1)
    await gate(f, f.P, d.draftId, 1)
    const events = await eventsNamed(f.firmId, d.draftId, "draft.gated")
    expect(events.map((e) => e.id).sort()).toEqual([`${d.draftId}_1_gated_1`, `${d.draftId}_1_gated_2`, `${d.draftId}_1_gated_3`])
    expect(events.find((e) => e.id.endsWith("_gated_1"))?.data.payload.gateResult).toBe("UNVERIFIED")
    expect(events.find((e) => e.id.endsWith("_gated_2"))?.data.payload.gateResult).toBe("OK")
    expect((await auditRows("draft.gate", `drafts/${d.draftId}`)).filter((r) => r.decision === "allow")).toHaveLength(3)
    expect((await draftDoc(d.draftId))?.gateResult).toMatchObject({ version: 1, status: "OK", overridden: false })
  })

  it("the run count is per version: the first gate of version 2 is <draftId>_2_gated_1", async () => {
    const f = await newFirm()
    const d = await create(f, f.P, BODY_UNKNOWN)
    await gate(f, f.P, d.draftId, 1)
    await gate(f, f.P, d.draftId, 1)
    await save(f, f.P, d.draftId, 1, BODY_VERIFIED)
    await gate(f, f.P, d.draftId, 2)
    const ids = (await eventsNamed(f.firmId, d.draftId, "draft.gated")).map((e) => e.id).sort()
    expect(ids).toEqual([`${d.draftId}_1_gated_1`, `${d.draftId}_1_gated_2`, `${d.draftId}_2_gated_1`])
    expect((await resultDoc(d.draftId, 2))?.gateRuns).toBe(1)
    expect((await resultDoc(d.draftId, 1))?.status).toBe("UNVERIFIED")
  })

  it("a version that is not the current one is 409 draft_changed, and nothing is written", async () => {
    const f = await newFirm()
    const d = await create(f, f.P, BODY_UNKNOWN)
    await save(f, f.P, d.draftId, 1, BODY_VERIFIED)
    expectErr(await apiErrorOf(gate(f, f.P, d.draftId, 1)), 409, "draft_changed")
    expectErr(await apiErrorOf(gate(f, f.P, d.draftId, 3)), 409, "draft_changed")
    expect(await byFirm("draft_gate_results", f.firmId)).toHaveLength(0)
    expect(await eventsNamed(f.firmId, d.draftId, "draft.gated")).toHaveLength(0)
    expect((await draftDoc(d.draftId))?.gateResult).toBeNull()
    const denies = (await auditRows("draft.gate", `drafts/${d.draftId}`)).map((r) => [r.decision, r.reason])
    expect(denies).toEqual([
      ["deny", "draft_changed"],
      ["deny", "draft_changed"],
    ])
  })

  it("the input checks come first: a malformed version is 400 invalid_version, no draftId is 400 invalid_query", async () => {
    const f = await newFirm()
    const d = await create(f, f.P, BODY_UNKNOWN)
    for (const v of [undefined, 0, -1, 1.5, "1", null]) expectErr(await apiErrorOf(gate(f, f.P, d.draftId, v)), 400, "invalid_version")
    expectErr(await apiErrorOf(send(gateApi, f, f.P, { version: 1 })), 400, "invalid_query")
    // Before the permission: an intern with bad checks is told 400, not 403.
    expectErr(await apiErrorOf(gate(f, f.intern, d.draftId, 1, "all")), 400, "invalid_temporal_checks")
    expect(await byFirm("draft_gate_results", f.firmId)).toHaveLength(0)
  })

  it("bad temporal checks are 400 invalid_temporal_checks through the route; 20 good ones are accepted", async () => {
    const f = await newFirm()
    const d = await create(f, f.P, BODY_PLAIN)
    for (const bad of [
      null,
      {},
      Array.from({ length: 21 }, () => check(TEXT_2015)),
      [check(TEXT_2015, "2015-02-30")],
      [check(TEXT_2015, "2015-03-01", "test act")],
      [check(TEXT_2015, "2015-03-01", "test_act_s1", "")],
      [check("u".repeat(10_001))],
    ]) {
      expectErr(await apiErrorOf(gate(f, f.P, d.draftId, 1, bad)), 400, "invalid_temporal_checks")
    }
    expect(await byFirm("draft_gate_results", f.firmId)).toHaveLength(0)
    const r = await gate(f, f.P, d.draftId, 1, Array.from({ length: 20 }, () => check(TEXT_2015)))
    expect(r.temporal).toHaveLength(20)
    expect(r.status).toBe("OK")
  })

  it("access: partner, associate and clerk members gate; an intern, a client, accounts and a non-member are refused; another firm's draft is 404", async () => {
    const f = await newFirm()
    const other = await newFirm()
    const d = await create(f, f.P, BODY_UNKNOWN)
    for (const m of [f.P, f.A, f.C]) expect((await gate(f, m, d.draftId, 1)).gatedBy).toBe(m.uid)
    expectErr(await apiErrorOf(gate(f, f.intern, d.draftId, 1)), 403, "intern_channel_denied")
    expectErr(await apiErrorOf(gate(f, f.client, d.draftId, 1)), 403, "client_denied")
    expectErr(await apiErrorOf(gate(f, f.accounts, d.draftId, 1)), 403, "accounts_register_only")
    expectErr(await apiErrorOf(gate(f, f.outsider, d.draftId, 1)), 403, "not_member")
    expectErr(await apiErrorOf(gate(other, other.P, d.draftId, 1)), 404, "not_found")
    expectErr(await apiErrorOf(gate(f, f.P, "no-such-draft", 1)), 404, "not_found")
    expectErr(await apiErrorOf(gate(f, f.P, "a/b", 1)), 404, "not_found")
    expect(await eventsNamed(f.firmId, d.draftId, "draft.gated")).toHaveLength(3)
  })

  it("a summary written by a re-gate shows overridden: true while an override for that version and hash clears the result", async () => {
    const f = await newFirm()
    const d = await create(f, f.A, BODY_UNKNOWN)
    await gate(f, f.A, d.draftId, 1)
    await override(f, f.P, d.draftId, 1)
    await gate(f, f.A, d.draftId, 1)
    expect((await draftDoc(d.draftId))?.gateResult).toMatchObject({ version: 1, status: "UNVERIFIED", overridden: true })
    // The corpus now overrules it: the override no longer covers the result, so the summary does not claim it.
    store.addJudgment("j_202", "PLD 2099 SC 202", "division")
    store.addTreatment("j_900", "j_202", "overruled", "larger")
    await gate(f, f.A, d.draftId, 1)
    expect((await draftDoc(d.draftId))?.gateResult).toMatchObject({ version: 1, status: "OVERRULED", overridden: false })
  })
})

// ---------------------------------------------------------------------------
// overrideGate
// ---------------------------------------------------------------------------

describe.skipIf(!EMULATORS)("overrideGate (P4-7)", () => {
  it("records every non-OK citation and temporal entry with its status, and nothing that passed", async () => {
    const f = await newFirm()
    const body = "Relying on PLD 2099 SC 101, 2099 SCMR 7 and PLD 2099 SC 202."
    const d = await create(f, f.A, body)
    await gate(f, f.A, d.draftId, 1, [check(TEXT_2015), check(TEXT_2018), check(TEXT_2015, "2015-03-01", "test_act_s9")])
    const o = await override(f, f.P, d.draftId, 1, `   ${REASON}   `)
    expect(o.override).toEqual({
      draftId: d.draftId,
      version: 1,
      bodySha256: sha(body),
      by: f.P.uid,
      at: o.override.at,
      reason: REASON,
      cleared: [
        { kind: "citation", ref: "PLD 2099 SC 101", status: "OVERRULED" },
        { kind: "citation", ref: "PLD 2099 SC 202", status: "UNVERIFIED" },
        { kind: "temporal", sectionId: "test_act_s1", asAtDate: "2015-03-01", jurisdiction: "PK", status: "TEMPORAL_MISMATCH" },
        { kind: "temporal", sectionId: "test_act_s9", asAtDate: "2015-03-01", jurisdiction: "PK", status: "TEMPORAL_UNAVAILABLE" },
      ],
    })
    const stored = await overrideDoc(d.draftId, 1)
    expect(stored?.cleared).toEqual(o.override.cleared)
    expect(stored?.reason).toBe(REASON)
    expect((stored?.at as Timestamp).toDate().toISOString()).toBe(o.override.at)
    expect(o.draft.gateResult).toMatchObject({ version: 1, bodySha256: sha(body), status: "OVERRULED", overridden: true })
    expect((await draftDoc(d.draftId))?.gateResult).toMatchObject({ overridden: true, status: "OVERRULED" })
    // The override writes no event and changes nothing else on the draft.
    expect(await eventsNamed(f.firmId, d.draftId, "draft.approved")).toHaveLength(0)
    expect(await draftDoc(d.draftId)).toMatchObject({ status: "draft", locked: false, currentVersion: 1 })
  })

  it("the author-partner may override their own draft; the audit row names them", async () => {
    const f = await newFirm()
    const d = await create(f, f.P, BODY_UNKNOWN)
    await gate(f, f.P, d.draftId, 1)
    await override(f, f.P, d.draftId, 1)
    expect((await overrideDoc(d.draftId, 1))?.by).toBe(f.P.uid)
    const rows = await auditRows("draft.gate_override", `draft_gate_overrides/${d.draftId}_1`)
    expect(rows).toEqual([expect.objectContaining({ actorId: f.P.uid, decision: "allow" })])
  })

  it("refusals: draft_changed, not_gated, nothing_to_override, already_overridden; nothing is written", async () => {
    const f = await newFirm()
    // not_gated: never gated.
    const never = await create(f, f.P, BODY_UNKNOWN)
    expectErr(await apiErrorOf(override(f, f.P, never.draftId, 1)), 409, "not_gated")
    // nothing_to_override: the result is OK.
    const clean = await create(f, f.P, BODY_VERIFIED)
    await gate(f, f.P, clean.draftId, 1)
    expectErr(await apiErrorOf(override(f, f.P, clean.draftId, 1)), 409, "nothing_to_override")
    // draft_changed: version 1 was gated, then version 2 was saved.
    const moved = await create(f, f.P, BODY_UNKNOWN)
    await gate(f, f.P, moved.draftId, 1)
    await save(f, f.P, moved.draftId, 1, `${BODY_UNKNOWN} More.`)
    expectErr(await apiErrorOf(override(f, f.P, moved.draftId, 1)), 409, "draft_changed")
    // not_gated: version 2 is current but was never gated.
    expectErr(await apiErrorOf(override(f, f.P, moved.draftId, 2)), 409, "not_gated")
    expect(await byFirm("draft_gate_overrides", f.firmId)).toHaveLength(0)
    // already_overridden: a second override of the same version, even by another member partner with another reason.
    const twice = await create(f, f.P, BODY_UNKNOWN)
    await gate(f, f.P, twice.draftId, 1)
    await override(f, f.P, twice.draftId, 1)
    const P2 = await memberPartner(f)
    expectErr(await apiErrorOf(override(f, P2, twice.draftId, 1, `${REASON} A second view.`)), 409, "already_overridden")
    expect((await overrideDoc(twice.draftId, 1))?.by).toBe(f.P.uid)
    expect(await byFirm("draft_gate_overrides", f.firmId)).toHaveLength(1)
  })

  it("a reason must be 20 to 2,000 characters after trimming (400 invalid_reason); the bounds are accepted", async () => {
    const f = await newFirm()
    const d = await create(f, f.P, BODY_UNKNOWN)
    await gate(f, f.P, d.draftId, 1)
    // No reason at all (the helper's default would supply one, so this call is made without it).
    expectErr(await apiErrorOf(send(overrideApi, f, f.P, { draftId: d.draftId, version: 1 })), 400, "invalid_reason")
    for (const bad of [null, 42, ["a reason long enough to pass"], "", "x".repeat(19), `   ${"x".repeat(19)}   `, "x".repeat(2001)]) {
      expectErr(await apiErrorOf(override(f, f.P, d.draftId, 1, bad)), 400, "invalid_reason")
    }
    expect(await overrideDoc(d.draftId, 1)).toBeUndefined()
    // Validated before the permission: an intern with a short reason is told 400, not 403.
    expectErr(await apiErrorOf(override(f, f.intern, d.draftId, 1, "short")), 400, "invalid_reason")
    await override(f, f.P, d.draftId, 1, ` ${"x".repeat(20)} `)
    expect((await overrideDoc(d.draftId, 1))?.reason).toBe("x".repeat(20))
    const e = await create(f, f.P, BODY_UNKNOWN)
    await gate(f, f.P, e.draftId, 1)
    await override(f, f.P, e.draftId, 1, "y".repeat(2000))
    expect((await overrideDoc(e.draftId, 1))?.reason).toHaveLength(2000)
  })

  it("a malformed version is 400 invalid_version", async () => {
    const f = await newFirm()
    const d = await create(f, f.P, BODY_UNKNOWN)
    for (const v of [undefined, 0, "1", 2.5]) expectErr(await apiErrorOf(override(f, f.P, d.draftId, v)), 400, "invalid_version")
  })

  it("access: a clerk, a client, accounts and an associate are refused; refusals are audited as denies on the override doc", async () => {
    const f = await newFirm()
    const d = await create(f, f.P, BODY_UNKNOWN)
    await gate(f, f.P, d.draftId, 1)
    expectErr(await apiErrorOf(override(f, f.C, d.draftId, 1)), 403, "role_not_permitted")
    expectErr(await apiErrorOf(override(f, f.client, d.draftId, 1)), 403, "client_denied")
    expectErr(await apiErrorOf(override(f, f.accounts, d.draftId, 1)), 403, "accounts_register_only")
    expectErr(await apiErrorOf(override(f, f.A, d.draftId, 1)), 403, "role_not_permitted")
    expectErr(await apiErrorOf(override(f, f.P, "no-such-draft", 1)), 404, "not_found")
    const rows = await auditRows("draft.gate_override", `draft_gate_overrides/${d.draftId}_1`)
    expect(rows.map((r) => r.decision)).toEqual(["deny", "deny", "deny", "deny"])
    expect(await overrideDoc(d.draftId, 1)).toBeUndefined()
    expect((await draftDoc(d.draftId))?.gateResult?.overridden).toBe(false)
  })

  it("two partners overriding at once: exactly one override is written, the other is already_overridden", async () => {
    const f = await newFirm()
    const P2 = await memberPartner(f)
    const d = await create(f, f.P, BODY_UNKNOWN)
    await gate(f, f.P, d.draftId, 1)
    const results = await Promise.allSettled([override(f, f.P, d.draftId, 1), override(f, P2, d.draftId, 1)])
    const ok = results.filter((r) => r.status === "fulfilled")
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
    expect(ok).toHaveLength(1)
    expect(failed.map((r) => (r.reason as ApiError).code)).toEqual(["already_overridden"])
    expect(await byFirm("draft_gate_overrides", f.firmId)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// approveDraft
// ---------------------------------------------------------------------------

describe.skipIf(!EMULATORS)("approveDraft (P4-8)", () => {
  it("an OK draft is approved without an override: status, lock, approver, version, the event and the audit row", async () => {
    const f = await newFirm()
    const d = await create(f, f.A, BODY_VERIFIED)
    await gate(f, f.A, d.draftId, 1)
    const a = await approve(f, f.P, d.draftId, 1)
    expect(a.gateResult).toMatchObject({ draftId: d.draftId, version: 1, status: "OK", gatedBy: f.P.uid })
    expect(a.draft).toMatchObject({ status: "approved", locked: true, approvedBy: f.P.uid, approvedVersion: 1, currentVersion: 1 })
    expect(a.draft.gateResult).toMatchObject({ version: 1, status: "OK", overridden: false })
    expect(new Date(a.draft.approvedAt as string).toISOString()).toBe(a.draft.approvedAt)
    const stored = await draftDoc(d.draftId)
    expect(stored).toMatchObject({ status: "approved", locked: true, approvedBy: f.P.uid, approvedVersion: 1 })
    expect(stored?.approvedAt).toBeInstanceOf(Timestamp)
    expect(stored?.gateResult).toMatchObject({ version: 1, bodySha256: sha(BODY_VERIFIED), status: "OK", overridden: false })
    const events = await eventsNamed(f.firmId, d.draftId, "draft.approved")
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      id: `${d.draftId}_1_approved`,
      data: { name: "draft.approved", classification: "internal", payload: { draftId: d.draftId, matterId: f.matterId, documentTypeId: TYPE, version: 1, gateResult: "OK", masterVersion: null } },
    })
    expect(await auditRows("draft.approve", `drafts/${d.draftId}`)).toEqual([expect.objectContaining({ actorId: f.P.uid, decision: "allow", reason: "ok" })])
    // The approval's gate run is stored as the version's result; it is not a gateDraft run, so no draft.gated event is added.
    expect(await resultDoc(d.draftId, 1)).toMatchObject({ gatedBy: f.P.uid, gateRuns: 1, status: "OK" })
    expect(await eventsNamed(f.firmId, d.draftId, "draft.gated")).toHaveLength(1)
  })

  it("a blocked approval stores the fresh result and the summary before answering 409 gate_blocked; one deny row, nothing approved", async () => {
    const f = await newFirm()
    const d = await create(f, f.A, BODY_UNKNOWN)
    await gate(f, f.A, d.draftId, 1)
    store.addJudgment("j_202", "PLD 2099 SC 202", "division")
    store.addTreatment("j_900", "j_202", "overruled", "larger")
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, 1)), 409, "gate_blocked")
    expect(await resultDoc(d.draftId, 1)).toMatchObject({
      status: "OVERRULED",
      gatedBy: f.P.uid,
      gateRuns: 1,
      citations: [{ ref: "PLD 2099 SC 202", judgmentId: "j_202", status: "OVERRULED" }],
    })
    const draft = await draftDoc(d.draftId)
    expect(draft).toMatchObject({ status: "draft", locked: false })
    expect(draft).not.toHaveProperty("approvedBy")
    expect(draft?.gateResult).toMatchObject({ version: 1, status: "OVERRULED", overridden: false })
    const r = await report(f, f.A, d.draftId)
    expect(r.gateResult?.citations).toEqual([{ ref: "PLD 2099 SC 202", judgmentId: "j_202", status: "OVERRULED" }])
    expect(r.current).toBe(true)
    expect((await auditRows("draft.approve", `drafts/${d.draftId}`)).map((row) => [row.actorId, row.decision, row.reason])).toEqual([[f.P.uid, "deny", "gate_blocked"]])
    expect(await eventsNamed(f.firmId, d.draftId, "draft.approved")).toHaveLength(0)
    expect(await eventsNamed(f.firmId, d.draftId, "draft.gated")).toHaveLength(1)
  })

  it("refusals in order: a locked draft is draft_locked, a version that is not current draft_changed, an ungated version not_gated", async () => {
    const f = await newFirm()
    const never = await create(f, f.P, BODY_VERIFIED)
    expectErr(await apiErrorOf(approve(f, f.P, never.draftId, 1)), 409, "not_gated")
    expectErr(await apiErrorOf(approve(f, f.P, never.draftId, 2)), 409, "draft_changed")
    await gate(f, f.P, never.draftId, 1)
    await approve(f, f.P, never.draftId, 1)
    expectErr(await apiErrorOf(approve(f, f.P, never.draftId, 1)), 409, "draft_locked")
    expectErr(await apiErrorOf(approve(f, f.P, never.draftId, 2)), 409, "draft_locked")
    expect(await eventsNamed(f.firmId, never.draftId, "draft.approved")).toHaveLength(1)
  })

  it("a summary for another version, or no summary, is not_gated even when a result document exists for the version", async () => {
    const f = await newFirm()
    const d = await create(f, f.P, BODY_VERIFIED)
    await gate(f, f.P, d.draftId, 1)
    await adminDb().collection("drafts").doc(d.draftId).update({ gateResult: null })
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, 1)), 409, "not_gated")
    await adminDb().collection("drafts").doc(d.draftId).update({ gateResult: { version: 7, bodySha256: sha(BODY_VERIFIED), status: "OK", gatedAt: Timestamp.now(), overridden: false } })
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, 1)), 409, "not_gated")
    expect((await draftDoc(d.draftId))?.locked).toBe(false)
  })

  it("access: an associate, a clerk, an intern, a client, accounts and a non-member partner cannot approve; another firm's partner gets 404", async () => {
    const f = await newFirm()
    const other = await newFirm()
    const d = await create(f, f.P, BODY_VERIFIED)
    await gate(f, f.P, d.draftId, 1)
    expectErr(await apiErrorOf(approve(f, f.A, d.draftId, 1)), 403, "role_not_permitted")
    expectErr(await apiErrorOf(approve(f, f.C, d.draftId, 1)), 403, "role_not_permitted")
    expectErr(await apiErrorOf(approve(f, f.intern, d.draftId, 1)), 403, "intern_channel_denied")
    expectErr(await apiErrorOf(approve(f, f.client, d.draftId, 1)), 403, "client_denied")
    expectErr(await apiErrorOf(approve(f, f.accounts, d.draftId, 1)), 403, "accounts_register_only")
    expectErr(await apiErrorOf(approve(f, f.outsider, d.draftId, 1)), 403, "not_member")
    expectErr(await apiErrorOf(approve(other, other.P, d.draftId, 1)), 404, "not_found")
    const forged = await spoofed(f, "partner", "associate")
    expectErr(await apiErrorOf(approve(f, forged, d.draftId, 1)), 401, "claims_stale")
    expect(await draftDoc(d.draftId)).toMatchObject({ status: "draft", locked: false })
    expect(await eventsNamed(f.firmId, d.draftId, "draft.approved")).toHaveLength(0)
  })

  it("re-runs with the temporal checks recorded in the version's result, against the store as it is now", async () => {
    const f = await newFirm()
    const d = await create(f, f.A, BODY_PLAIN)
    await gate(f, f.A, d.draftId, 1, [check(TEXT_2015, "2015-03-01", "test_act_s9")])
    await override(f, f.P, d.draftId, 1)
    // The section now has a history, and the pleaded text is not it: a cleared TEMPORAL_UNAVAILABLE is now a mismatch.
    store.addSectionVersion("test_act_s9", "PK", "2010-01-01", null, "Test Act s.9 in force text.")
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, 1)), 409, "gate_blocked")
    expect((await resultDoc(d.draftId, 1))?.temporal).toEqual([{ ...check(TEXT_2015, "2015-03-01", "test_act_s9"), status: "TEMPORAL_MISMATCH", inForceText: "Test Act s.9 in force text." }])
  })

  it("an override bound to another body hash clears nothing", async () => {
    const f = await newFirm()
    const d = await create(f, f.A, BODY_UNKNOWN)
    await gate(f, f.A, d.draftId, 1)
    await adminDb()
      .collection("draft_gate_overrides")
      .doc(`${d.draftId}_1`)
      .set({ firmId: f.firmId, matterId: f.matterId, draftId: d.draftId, version: 1, bodySha256: sha("another body"), by: f.P.uid, at: Timestamp.now(), reason: REASON, cleared: [{ kind: "citation", ref: "PLD 2099 SC 202", status: "UNVERIFIED" }] })
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, 1)), 409, "gate_blocked")
    expect((await draftDoc(d.draftId))?.locked).toBe(false)
  })

  it("an override that is no longer needed is not used: the corpus now verifies the authority, the summary says overridden false", async () => {
    const f = await newFirm()
    const d = await create(f, f.A, BODY_UNKNOWN)
    await gate(f, f.A, d.draftId, 1)
    await override(f, f.P, d.draftId, 1)
    store.addJudgment("j_202", "PLD 2099 SC 202", "division")
    const a = await approve(f, f.P, d.draftId, 1)
    expect(a.draft.gateResult).toMatchObject({ status: "OK", overridden: false })
    expect((await eventsNamed(f.firmId, d.draftId, "draft.approved"))[0].data.payload.gateResult).toBe("OK")
  })

  it("a re-gate that lands while the approval re-runs the gate is draft_changed: never an approval on the checks it replaced", async () => {
    const f = await newFirm()
    const d = await create(f, f.A, BODY_VERIFIED)
    expect((await gate(f, f.A, d.draftId, 1)).status).toBe("OK")
    // The store fires one re-gate (with a check that mismatches) from inside the approval's own gate run.
    let fired = false
    const inner = seededStore()
    const hooked: AuthorityStore = {
      async findJudgment(canonical) {
        if (!fired) {
          fired = true
          expect((await gate(f, f.C, d.draftId, 1, [check(TEXT_2018)])).status).toBe("TEMPORAL_MISMATCH")
        }
        return inner.findJudgment(canonical)
      },
      listTreatments: (id) => inner.listTreatments(id),
      getSectionAsAt: (sectionId, asAtDate, jurisdiction) => inner.getSectionAsAt(sectionId, asAtDate, jurisdiction),
    }
    setAuthorityStoreForTests(hooked)
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, 1)), 409, "draft_changed")
    expect(fired).toBe(true)
    expect(await draftDoc(d.draftId)).toMatchObject({ status: "draft", locked: false })
    expect((await resultDoc(d.draftId, 1))?.status).toBe("TEMPORAL_MISMATCH")
    // Decided again on the new result: blocked.
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, 1)), 409, "gate_blocked")
    expect(await eventsNamed(f.firmId, d.draftId, "draft.approved")).toHaveLength(0)
  })

  it("two approvals at once: exactly one approves, the other is draft_locked, and draft.approved is written once", async () => {
    const f = await newFirm()
    const P2 = await memberPartner(f)
    const d = await create(f, f.A, BODY_VERIFIED)
    await gate(f, f.A, d.draftId, 1)
    const results = await Promise.allSettled([approve(f, f.P, d.draftId, 1), approve(f, P2, d.draftId, 1)])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => (r.reason as ApiError).code)).toEqual(["draft_locked"])
    expect(await eventsNamed(f.firmId, d.draftId, "draft.approved")).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Review Focus 1-2: pinning to the version and the body; a corpus change after the override.
// ---------------------------------------------------------------------------

describe.skipIf(!EMULATORS)("pinning: a body change after a gate or an override (P4-7, P4-8)", () => {
  it("gate version 1, save version 2, approve version 1: draft_changed; approve version 2: not_gated", async () => {
    const f = await newFirm()
    const d = await create(f, f.A, BODY_VERIFIED)
    await gate(f, f.A, d.draftId, 1)
    await save(f, f.A, d.draftId, 1, `${BODY_VERIFIED} Further submissions follow.`)
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, 1)), 409, "draft_changed")
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, 2)), 409, "not_gated")
    expect(await draftDoc(d.draftId)).toMatchObject({ status: "draft", locked: false, gateResult: null })
  })

  it("an override of version 1 does not clear version 2: approving version 2 after gating it is gate_blocked", async () => {
    const f = await newFirm()
    const d = await create(f, f.A, BODY_OVERRULED)
    await gate(f, f.A, d.draftId, 1)
    await override(f, f.P, d.draftId, 1)
    await save(f, f.A, d.draftId, 1, `${BODY_OVERRULED} One more line.`)
    const g2 = await gate(f, f.A, d.draftId, 2)
    expect(g2.status).toBe("OVERRULED")
    expect((await draftDoc(d.draftId))?.gateResult).toMatchObject({ version: 2, overridden: false })
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, 2)), 409, "gate_blocked")
    // The old override cannot be re-aimed: version 1 is not current.
    expectErr(await apiErrorOf(override(f, f.P, d.draftId, 1)), 409, "draft_changed")
    expect((await draftDoc(d.draftId))?.locked).toBe(false)
  })

  it("restoring version 1's text as version 3 (the same body hash) still needs its own override", async () => {
    const f = await newFirm()
    const d = await create(f, f.A, BODY_UNKNOWN)
    await gate(f, f.A, d.draftId, 1)
    await override(f, f.P, d.draftId, 1)
    await save(f, f.A, d.draftId, 1, BODY_VERIFIED)
    await restore(f, f.A, d.draftId, 2, 1)
    expect((await draftDoc(d.draftId))?.currentBodySha256).toBe(sha(BODY_UNKNOWN))
    await gate(f, f.A, d.draftId, 3)
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, 3)), 409, "gate_blocked")
    await override(f, f.P, d.draftId, 3)
    expect((await approve(f, f.P, d.draftId, 3)).draft).toMatchObject({ approvedVersion: 3, locked: true })
  })

  it("corpus change: an UNVERIFIED citation overridden, then overruled by a larger bench in the store, blocks approval", async () => {
    const f = await newFirm()
    const d = await create(f, f.A, BODY_UNKNOWN)
    expect((await gate(f, f.A, d.draftId, 1)).status).toBe("UNVERIFIED")
    await override(f, f.P, d.draftId, 1)
    store.addJudgment("j_202", "PLD 2099 SC 202", "division")
    store.addTreatment("j_900", "j_202", "overruled", "larger")
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, 1)), 409, "gate_blocked")
    expect(await draftDoc(d.draftId)).toMatchObject({ status: "draft", locked: false })
    expect(await eventsNamed(f.firmId, d.draftId, "draft.approved")).toHaveLength(0)
    expect((await resultDoc(d.draftId, 1))?.status).toBe("OVERRULED")
  })
})

// ---------------------------------------------------------------------------
// The lock, the verification report, the production store
// ---------------------------------------------------------------------------

describe.skipIf(!EMULATORS)("the lock (P4-8)", () => {
  it("an approved draft refuses save, restore, gate, override and approval with 409 draft_locked; nothing is written", async () => {
    const f = await newFirm()
    const d = await create(f, f.A, BODY_UNKNOWN)
    await gate(f, f.A, d.draftId, 1)
    await override(f, f.P, d.draftId, 1)
    await approve(f, f.P, d.draftId, 1)
    const before = await draftDoc(d.draftId)
    const resultBefore = await resultDoc(d.draftId, 1)
    expectErr(await apiErrorOf(save(f, f.A, d.draftId, 1, BODY_VERIFIED)), 409, "draft_locked")
    expectErr(await apiErrorOf(restore(f, f.A, d.draftId, 1, 1)), 409, "draft_locked")
    expectErr(await apiErrorOf(gate(f, f.A, d.draftId, 1)), 409, "draft_locked")
    expectErr(await apiErrorOf(override(f, f.P, d.draftId, 1)), 409, "draft_locked")
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, 1)), 409, "draft_locked")
    expect(await draftDoc(d.draftId)).toEqual(before)
    expect(await resultDoc(d.draftId, 1)).toEqual(resultBefore)
    expect(await byFirm("draft_versions", f.firmId)).toHaveLength(1)
    expect(await eventsNamed(f.firmId, d.draftId, "draft.gated")).toHaveLength(1)
  })
})

describe.skipIf(!EMULATORS)("getVerificationReport (P4-6, P4-7)", () => {
  it("before any gate: no result, no override, not current", async () => {
    const f = await newFirm()
    const d = await create(f, f.P, BODY_UNKNOWN)
    expect(await report(f, f.P, d.draftId)).toEqual({ gateResult: null, override: null, current: false })
  })

  it("after a gate and an override: the stored result, the override and current: true", async () => {
    const f = await newFirm()
    const d = await create(f, f.A, BODY_UNKNOWN)
    const g = await gate(f, f.A, d.draftId, 1)
    expect(await report(f, f.C, d.draftId)).toEqual({ gateResult: g, override: null, current: true })
    const o = await override(f, f.P, d.draftId, 1)
    expect(await report(f, f.C, d.draftId)).toEqual({ gateResult: g, override: o.override, current: true })
  })

  it("after a save the last result is shown with current: false; gating the new version shows its result and no override", async () => {
    const f = await newFirm()
    const d = await create(f, f.A, BODY_UNKNOWN)
    const g1 = await gate(f, f.A, d.draftId, 1)
    await override(f, f.P, d.draftId, 1)
    await save(f, f.A, d.draftId, 1, BODY_VERIFIED)
    const r = await report(f, f.A, d.draftId)
    expect(r.current).toBe(false)
    expect(r.gateResult).toEqual(g1)
    expect(r.override?.version).toBe(1)
    const g2 = await gate(f, f.A, d.draftId, 2)
    expect(await report(f, f.A, d.draftId)).toEqual({ gateResult: g2, override: null, current: true })
  })

  it("is audited as an allow under draft.read; access: an intern, a client, accounts and a non-member are refused, another firm's is 404, no draftId 400", async () => {
    const f = await newFirm()
    const other = await newFirm()
    const d = await create(f, f.P, BODY_UNKNOWN)
    await gate(f, f.P, d.draftId, 1)
    await report(f, f.P, d.draftId)
    expect((await auditRows("draft.read", `drafts/${d.draftId}`)).map((r) => [r.actorId, r.decision])).toEqual([[f.P.uid, "allow"]])
    expectErr(await apiErrorOf(report(f, f.intern, d.draftId)), 403, "intern_channel_denied")
    expectErr(await apiErrorOf(report(f, f.client, d.draftId)), 403, "client_denied")
    expectErr(await apiErrorOf(report(f, f.accounts, d.draftId)), 403, "accounts_register_only")
    expectErr(await apiErrorOf(report(f, f.outsider, d.draftId)), 403, "not_member")
    expectErr(await apiErrorOf(report(other, other.P, d.draftId)), 404, "not_found")
    expectErr(await apiErrorOf(send(reportApi, f, f.P, {})), 400, "invalid_query")
  })
})

describe.skipIf(!EMULATORS)("the production store (P4-3: EMPTY_AUTHORITY_STORE until O-59)", () => {
  it("every draft that cites an authority needs an override to approve; a draft that cites nothing and checks nothing approves", async () => {
    setAuthorityStoreForTests(null)
    const f = await newFirm()
    const d = await create(f, f.A, BODY_VERIFIED)
    const g = await gate(f, f.A, d.draftId, 1, [check(TEXT_2015)])
    expect(g.status).toBe("UNVERIFIED")
    expect(g.citations).toEqual([{ ref: "2099 SCMR 7", judgmentId: null, status: "UNVERIFIED" }])
    expect(g.temporal.map((t) => t.status)).toEqual(["TEMPORAL_UNAVAILABLE"])
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, 1)), 409, "gate_blocked")
    await override(f, f.P, d.draftId, 1)
    expect((await approve(f, f.P, d.draftId, 1)).draft).toMatchObject({ status: "approved", locked: true })

    const plain = await create(f, f.A, BODY_PLAIN)
    expect((await gate(f, f.A, plain.draftId, 1)).status).toBe("OK")
    expect((await approve(f, f.P, plain.draftId, 1)).draft.gateResult).toMatchObject({ status: "OK", overridden: false })
  })
})
