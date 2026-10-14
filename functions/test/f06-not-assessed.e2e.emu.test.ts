import { createHash } from "node:crypto"
import { Timestamp } from "firebase-admin/firestore"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { adminDb } from "../src/admin"
import { InMemoryAuthorityStore, setAuthorityStoreForTests } from "../src/d4/authority"
import { ApiError, apiErrorOf, viaApi } from "./api"
import { EMULATORS, mintIdToken, uniq } from "./emu"

/**
 * Audit finding F06 (HIGH, 2026-10-13): "An empty legal check is represented as OK". End to end, through the HTTP
 * router, with real ID tokens from the Auth emulator and every write read back from the Firestore emulator.
 *
 * The user flow: a member drafts a document whose prose makes a legal assertion (a thirty-day statutory deadline) and
 * cites nothing, gates it, and a partner tries to approve it. Before the fix the gate answered OK on that draft and the
 * partner approved it with no override: nothing legal had been checked, yet the result read as a pass. After the fix
 * the gate answers NOT_ASSESSED with the assessed scope (no citation, no temporal check), approval is blocked until the
 * matter's partner gives an explicit override with a reason, and a law-dependent document type also needs the type's
 * review checklist with evidence (at least 20 characters) for every item before it can be approved. Law-dependent
 * means filed in a forum, or a NON_FORUM type whose own checklist names a legal-verification item (a suit for
 * possession, a legal opinion: re-audit ruling A). A temporal check counts only if the draft pleads its text
 * (ruling C), so an unrelated true check cannot turn uncited prose into OK.
 *
 * Most cases run on the production authority store (EMPTY_AUTHORITY_STORE): F06 must hold while the store is empty
 * (F05 is a separate finding). The VERIFIED-citation and temporal-check cases seed an in-memory store through the test
 * seam. Fixtures follow P4-13: the year 2099 and no real judgment, statute or party.
 */

type GateScope = { citations: number; temporalChecks: number; assessed: boolean }
type GateResult = { draftId: string; version: number; status: string; scope: GateScope; resultId: string; citations: unknown[]; temporal: unknown[] }
type DraftView = { draftId: string; documentTypeId: string; status: string; locked: boolean; approvedBy?: string; approvedVersion?: number; gateResult: null | { status: string; overridden: boolean } }
type ChecklistEntry = { item: string; evidence: string }
type Approved = { draft: DraftView; gateResult: GateResult; reviewChecklist: ChecklistEntry[] | null }
type Overridden = { override: { cleared: Array<Record<string, unknown>>; by: string; reason: string }; draft: DraftView }
type Report = { gateResult: GateResult | null; override: Overridden["override"] | null; current: boolean }
type TypeProfile = { id: string; courtIds: string[]; checklist: string[] }
type DraftRead = DraftView & { body: string; reviewChecklist?: ChecklistEntry[] }
type Page<T> = { items: T[]; nextCursor: string | null }

const createApi = viaApi<DraftView>("createDraft")
const gateApi = viaApi<GateResult>("gateDraft")
const reportApi = viaApi<Report>("getVerificationReport")
const overrideApi = viaApi<Overridden>("overrideGate")
const approveApi = viaApi<Approved>("approveDraft")
const profileApi = viaApi<TypeProfile>("getTypeProfile")
const getDraftApi = viaApi<DraftRead>("getDraft")
const listDraftsApi = viaApi<Page<Record<string, unknown>>>("listDrafts")

/** A forum-filed type (its courtIds name High Courts, not NON_FORUM): law-dependent. */
const FORUM_TYPE = "constitutional_petition_199"
/** A NON_FORUM type (an instrument, not filed in a court). */
const NON_FORUM_TYPE = "sale_deed"
/** The audit's failure scenario: a legal assertion about a thirty-day statutory deadline, with no citation. */
const DEADLINE_PROSE =
  "The petitioner filed the appeal within thirty days of the impugned order, the period the statute allows, so the appeal is within time.\nThe respondents have failed to act."
const DEED_PROSE = "The vendor sells the property to the vendee for the consideration stated in the schedule, free of encumbrances."
/** Cites one judgment, which step 6 seeds as known and never overruled. */
const CITED_PROSE = "The petitioner relies on 2099 SCMR 7 for the rule that the period runs from knowledge of the order."
const REASON = "The partner has read the petition; the deadline assertion was checked by hand against the file."
const NOT_ASSESSED_SCOPE: GateScope = { citations: 0, temporalChecks: 0, assessed: false }
/**
 * NON_FORUM types whose own seed checklist names a legal-verification item (re-audit A10): a suit for possession
 * ("Limitation checked (Module 44)", "Statutory text pleaded as at relevant date (L17.1)", "Citations passed Gate 33")
 * and a legal opinion ("Sources cited and verified (Gate 33 ...)"). Both are law-dependent.
 */
const POSSESSION_SUIT_TYPE = "property_suit_possession"
const OPINION_TYPE = "legal_opinion"
const POSSESSION_PROSE = "The plaintiff is entitled to possession of the suit property, and the suit is within the twelve years the law allows."
const OPINION_PROSE = "Limitation for the appeal is thirty days; see 2099 SCMR 7."
/** Statute text a fixture store holds for test_act_s1 in PK (P4-13: no real statute). */
const SECTION_TEXT = "Test Act s.1 as amended in 2018: the limit is sixty days."
/** Evidence at the floor (20 characters once trimmed) and one character below it (ruling B). */
const EVIDENCE_20 = "Verified on the file"
const EVIDENCE_19 = "Checked by partner."

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

type Member = { uid: string; token: string }
type Firm = { firmId: string; matterId: string; P: Member; A: Member; C: Member }

async function newFirm(): Promise<Firm> {
  const firmId = uniq("firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal", rateLimits: { general: 1000 } })
  const matterId = uniq("matter")
  await adminDb()
    .collection("matters")
    .doc(matterId)
    .set({ firmId, classification: "internal", title: "Appeal against the order", stage: "pre_filing", status: "open", createdAt: Timestamp.now() })
  const member = async (role: string): Promise<Member> => {
    const m = await mintIdToken({ firmId, role, clearanceLevel: "privileged-restricted" })
    await adminDb().collection("matter_members").doc(`${matterId}_${m.uid}`).set({ firmId, matterId, userId: m.uid, classification: "internal" })
    return m
  }
  return { firmId, matterId, P: await member("partner"), A: await member("associate"), C: await member("clerk") }
}

const send = <T>(api: (c: never) => Promise<T>, f: Firm, m: Member, data: Record<string, unknown>): Promise<T> =>
  api({ token: m.token, data: { firmId: f.firmId, ...data } } as never)

const create = (f: Firm, m: Member, documentTypeId: string, body: string) =>
  send(createApi, f, m, { matterId: f.matterId, documentTypeId, title: "Draft for review", body })
const gate = (f: Firm, m: Member, draftId: string, temporalChecks?: unknown) =>
  send(gateApi, f, m, { draftId, version: 1, ...(temporalChecks === undefined ? {} : { temporalChecks }) })
const report = (f: Firm, m: Member, draftId: string) => send(reportApi, f, m, { draftId })
/** The id of the stored result the partner reviewed, as the verification report shows it. */
const reviewedResultId = async (f: Firm, draftId: string): Promise<string> => (await report(f, f.P, draftId)).gateResult?.resultId ?? "no-result"
const override = async (f: Firm, m: Member, draftId: string) =>
  send(overrideApi, f, m, { draftId, version: 1, reason: REASON, resultId: await reviewedResultId(f, draftId) })
const approve = async (f: Firm, m: Member, draftId: string, extra: Record<string, unknown> = {}) =>
  send(approveApi, f, m, { draftId, version: 1, resultId: await reviewedResultId(f, draftId), ...extra })

/** The type's review checklist as the type profile route returns it, each distinct item once, in the type's order. */
async function checklistOf(f: Firm, m: Member, typeId: string): Promise<string[]> {
  const profile = await send(profileApi, f, m, { typeId })
  return [...new Set(profile.checklist)]
}

/** A complete review checklist: every item, with evidence of what the reviewer checked. */
const completeChecklist = (items: readonly string[]): ChecklistEntry[] =>
  items.map((item, i) => ({ item, evidence: `Reviewed against the file, point ${i + 1}: confirmed by the partner on the record.` }))

const draftDoc = async (id: string) => (await adminDb().collection("drafts").doc(id).get()).data()
const resultDoc = async (id: string) => (await adminDb().collection("draft_gate_results").doc(`${id}_1`).get()).data()
const overrideDoc = async (id: string) => (await adminDb().collection("draft_gate_overrides").doc(`${id}_1`).get()).data()
const approvedEvents = async (firmId: string, draftId: string) =>
  (await adminDb().collection("events").where("firmId", "==", firmId).get()).docs.filter((d) => d.data().name === "draft.approved" && d.data().payload?.draftId === draftId)

function expectErr(err: ApiError, status: number, code: string): void {
  expect({ status: err.status, code: err.code }).toEqual({ status, code })
}

beforeEach(() => {
  // The production store: no judgment, no history (P4-3).
  setAuthorityStoreForTests(null)
})
afterEach(() => {
  setAuthorityStoreForTests(null)
})

describe.skipIf(!EMULATORS)("F06: an empty legal check is NOT_ASSESSED, never OK (end to end through the HTTP routes)", () => {
  it("a forum-type draft of uncited prose gates NOT_ASSESSED, is blocked, is cleared only by a partner override, and approves only with the full review checklist", async () => {
    const f = await newFirm()
    const d = await create(f, f.A, FORUM_TYPE, DEADLINE_PROSE)

    // 1. The gate ran no citation check and no temporal check: NOT_ASSESSED with the assessed scope, never OK.
    const g = await gate(f, f.A, d.draftId)
    expect(g.status).toBe("NOT_ASSESSED")
    expect(g.scope).toEqual(NOT_ASSESSED_SCOPE)
    expect(g.citations).toEqual([])
    expect(g.temporal).toEqual([])
    expect(await resultDoc(d.draftId)).toMatchObject({ status: "NOT_ASSESSED", scope: NOT_ASSESSED_SCOPE, resultId: g.resultId })
    expect((await draftDoc(d.draftId))?.gateResult).toMatchObject({ version: 1, status: "NOT_ASSESSED", overridden: false })
    expect((await report(f, f.C, d.draftId)).gateResult).toMatchObject({ status: "NOT_ASSESSED", scope: NOT_ASSESSED_SCOPE })
    const gated = (await adminDb().collection("events").doc(`${d.draftId}_1_gated_1`).get()).data()
    expect(gated?.payload.gateResult).toBe("NOT_ASSESSED")

    const items = await checklistOf(f, f.A, FORUM_TYPE)
    expect(items.length).toBeGreaterThan(0)
    const full = completeChecklist(items)

    // 2. Approval without an override is refused, even with a complete checklist: the gate blocks it.
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, { reviewChecklist: full })), 409, "gate_blocked")
    expect(await draftDoc(d.draftId)).toMatchObject({ status: "draft", locked: false })
    expect(await draftDoc(d.draftId)).not.toHaveProperty("approvedBy")
    expect(await resultDoc(d.draftId)).toMatchObject({ status: "NOT_ASSESSED", scope: NOT_ASSESSED_SCOPE })

    // 3. An associate or a clerk cannot clear a NOT_ASSESSED result: the override is the matter partner's.
    expectErr(await apiErrorOf(override(f, f.A, d.draftId)), 403, "role_not_permitted")
    expectErr(await apiErrorOf(override(f, f.C, d.draftId)), 403, "role_not_permitted")
    expect(await overrideDoc(d.draftId)).toBeUndefined()

    // 4. The member partner overrides with a reason; the override records that it cleared the not-assessed scope.
    const o = await override(f, f.P, d.draftId)
    expect(o.override.cleared).toEqual([{ kind: "scope", status: "NOT_ASSESSED" }])
    expect(o.override.by).toBe(f.P.uid)
    expect(o.draft.gateResult).toMatchObject({ status: "NOT_ASSESSED", overridden: true })
    expect(await overrideDoc(d.draftId)).toMatchObject({ by: f.P.uid, reason: REASON, bodySha256: sha(DEADLINE_PROSE), cleared: [{ kind: "scope", status: "NOT_ASSESSED" }] })

    // A law-dependent type needs the review checklist: none, one item missing, an extra item, a duplicate or an empty
    // evidence is 422 review_checklist_incomplete, and nothing is approved.
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId)), 422, "review_checklist_incomplete")
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, { reviewChecklist: full.slice(1) })), 422, "review_checklist_incomplete")
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, { reviewChecklist: [...full, { item: "Not an item of this type", evidence: "x" }] })), 422, "review_checklist_incomplete")
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, { reviewChecklist: [...full, full[0]] })), 422, "review_checklist_incomplete")
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, { reviewChecklist: full.map((e, i) => (i === 0 ? { ...e, evidence: "   \n " } : e)) })), 422, "review_checklist_incomplete")
    // Ruling B: evidence must be at least 20 characters once trimmed, the override reason's floor; 19 is incomplete.
    expect([...EVIDENCE_19]).toHaveLength(19)
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, { reviewChecklist: full.map((e, i) => (i === 0 ? { ...e, evidence: EVIDENCE_19 } : e)) })), 422, "review_checklist_incomplete")
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, { reviewChecklist: full.map((e) => ({ ...e, evidence: "x" })) })), 422, "review_checklist_incomplete")
    // A malformed checklist is 400 before the permission: an associate learns the shape, not the permission.
    expectErr(await apiErrorOf(approve(f, f.A, d.draftId, { reviewChecklist: "all done" })), 400, "invalid_review_checklist")
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, { reviewChecklist: [{ item: items[0] }] })), 400, "invalid_review_checklist")
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, { reviewChecklist: [{ item: items[0], evidence: "e".repeat(2001) }] })), 400, "invalid_review_checklist")
    expect(await draftDoc(d.draftId)).toMatchObject({ status: "draft", locked: false })
    expect(await approvedEvents(f.firmId, d.draftId)).toHaveLength(0)

    // With every item and its evidence (in any order) the partner's approval passes on the override.
    const a = await approve(f, f.P, d.draftId, { reviewChecklist: [...full].reverse() })
    expect(a.draft).toMatchObject({ status: "approved", locked: true, approvedBy: f.P.uid, approvedVersion: 1 })
    expect(a.draft.gateResult).toMatchObject({ status: "NOT_ASSESSED", overridden: true })
    expect(a.gateResult).toMatchObject({ status: "NOT_ASSESSED", scope: NOT_ASSESSED_SCOPE })
    expect(a.reviewChecklist).toEqual(full)
    // The stored approval holds the checklist in the type's order, with its evidence.
    expect(await draftDoc(d.draftId)).toMatchObject({ status: "approved", locked: true, approvedBy: f.P.uid, reviewChecklist: full })
    const events = await approvedEvents(f.firmId, d.draftId)
    expect(events.map((e) => e.data().payload.gateResult)).toEqual(["NOT_ASSESSED"])
    // It is returned on the draft read, never in the list view.
    expect((await send(getDraftApi, f, f.C, { draftId: d.draftId })).reviewChecklist).toEqual(full)
    const listed = (await send(listDraftsApi, f, f.C, { matterId: f.matterId })).items.find((row) => row.draftId === d.draftId)
    expect(listed).toBeDefined()
    expect(listed).not.toHaveProperty("reviewChecklist")
  })

  it("a NON_FORUM draft of uncited prose gates NOT_ASSESSED and approves after a partner override without a checklist", async () => {
    const f = await newFirm()
    const d = await create(f, f.A, NON_FORUM_TYPE, DEED_PROSE)
    const g = await gate(f, f.A, d.draftId)
    expect(g.status).toBe("NOT_ASSESSED")
    expect(g.scope).toEqual(NOT_ASSESSED_SCOPE)
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId)), 409, "gate_blocked")
    expect(await draftDoc(d.draftId)).toMatchObject({ status: "draft", locked: false })

    // Citation-free documents are not banned: the partner's explicit override is the human approval.
    const o = await override(f, f.P, d.draftId)
    expect(o.override.cleared).toEqual([{ kind: "scope", status: "NOT_ASSESSED" }])
    // A checklist is optional for a NON_FORUM type, but one that is supplied must be complete for the type.
    const items = await checklistOf(f, f.P, NON_FORUM_TYPE)
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId, { reviewChecklist: completeChecklist(items).slice(1) })), 422, "review_checklist_incomplete")
    const a = await approve(f, f.P, d.draftId)
    expect(a.draft).toMatchObject({ status: "approved", locked: true, approvedBy: f.P.uid })
    expect(a.draft.gateResult).toMatchObject({ status: "NOT_ASSESSED", overridden: true })
    expect(a.reviewChecklist).toBeNull()
    expect(await draftDoc(d.draftId)).not.toHaveProperty("reviewChecklist")
  })

  it("a draft whose citation is VERIFIED gates OK with an assessed scope and approves without an override, but a forum type still needs the checklist", async () => {
    const store = new InMemoryAuthorityStore()
    store.addJudgment("j_7", "2099 SCMR 7", "full")
    setAuthorityStoreForTests(store)
    const f = await newFirm()
    const d = await create(f, f.A, FORUM_TYPE, CITED_PROSE)
    const g = await gate(f, f.A, d.draftId)
    expect(g.status).toBe("OK")
    expect(g.scope).toEqual({ citations: 1, temporalChecks: 0, assessed: true })
    expect(g.citations).toEqual([{ ref: "2099 SCMR 7", judgmentId: "j_7", status: "VERIFIED" }])

    // No override is needed, but the checklist of a law-dependent type is.
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId)), 422, "review_checklist_incomplete")
    const full = completeChecklist(await checklistOf(f, f.P, FORUM_TYPE))
    const a = await approve(f, f.P, d.draftId, { reviewChecklist: full })
    expect(a.draft).toMatchObject({ status: "approved", locked: true })
    expect(a.draft.gateResult).toMatchObject({ status: "OK", overridden: false })
    expect(a.gateResult).toMatchObject({ status: "OK", scope: { citations: 1, temporalChecks: 0, assessed: true } })
    expect(a.reviewChecklist).toEqual(full)
    expect(await draftDoc(d.draftId)).toMatchObject({ reviewChecklist: full })
    expect(await adminDb().collection("draft_gate_overrides").doc(`${d.draftId}_1`).get().then((s) => s.exists)).toBe(false)
  })

  it("a NON_FORUM type whose own checklist requires legal verification (a suit for possession) needs the review checklist even after the partner override", async () => {
    const f = await newFirm()
    const d = await create(f, f.A, POSSESSION_SUIT_TYPE, POSSESSION_PROSE)
    const g = await gate(f, f.A, d.draftId)
    expect(g.status).toBe("NOT_ASSESSED")
    expect(g.scope).toEqual(NOT_ASSESSED_SCOPE)
    await override(f, f.P, d.draftId)

    // The partner's override clears the gate, not the review: approval without the checklist is still refused.
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId)), 422, "review_checklist_incomplete")
    expect(await draftDoc(d.draftId)).toMatchObject({ status: "draft", locked: false })
    expect(await approvedEvents(f.firmId, d.draftId)).toHaveLength(0)

    const items = await checklistOf(f, f.P, POSSESSION_SUIT_TYPE)
    expect(items).toEqual(expect.arrayContaining(["Limitation checked (Module 44)", "Statutory text pleaded as at relevant date (L17.1)", "Citations passed Gate 33"]))
    // Evidence of exactly 20 characters once trimmed is enough (ruling B).
    const full = items.map((item) => ({ item, evidence: `  ${EVIDENCE_20}\n` }))
    const a = await approve(f, f.P, d.draftId, { reviewChecklist: full })
    expect(a.draft).toMatchObject({ status: "approved", locked: true, approvedBy: f.P.uid })
    expect(a.draft.gateResult).toMatchObject({ status: "NOT_ASSESSED", overridden: true })
    expect(a.reviewChecklist).toEqual(items.map((item) => ({ item, evidence: EVIDENCE_20 })))
    expect(await draftDoc(d.draftId)).toMatchObject({ reviewChecklist: items.map((item) => ({ item, evidence: EVIDENCE_20 })) })
  })

  it("a legal opinion whose only citation is VERIFIED gates OK and approves without an override, but still needs the review checklist", async () => {
    const store = new InMemoryAuthorityStore()
    store.addJudgment("j_7", "2099 SCMR 7", "full")
    setAuthorityStoreForTests(store)
    const f = await newFirm()
    const d = await create(f, f.A, OPINION_TYPE, OPINION_PROSE)
    const g = await gate(f, f.A, d.draftId)
    expect(g.status).toBe("OK")
    expect(g.scope).toEqual({ citations: 1, temporalChecks: 0, assessed: true })

    // One verified citation does not verify the opinion's legal assertions: the review checklist is required.
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId)), 422, "review_checklist_incomplete")
    expect(await draftDoc(d.draftId)).toMatchObject({ status: "draft", locked: false })
    const items = await checklistOf(f, f.P, OPINION_TYPE)
    expect(items).toContain("Sources cited and verified (Gate 33 where authorities are relied on)")
    const full = completeChecklist(items)
    const a = await approve(f, f.P, d.draftId, { reviewChecklist: full })
    expect(a.draft).toMatchObject({ status: "approved", locked: true })
    expect(a.draft.gateResult).toMatchObject({ status: "OK", overridden: false })
    expect(a.reviewChecklist).toEqual(full)
    expect((await adminDb().collection("draft_gate_overrides").doc(`${d.draftId}_1`).get()).exists).toBe(false)
  })

  it("a temporal check whose text the draft does not plead is refused 422 temporal_check_not_in_draft, so an unrelated true check cannot turn uncited prose OK", async () => {
    const store = new InMemoryAuthorityStore()
    store.addSectionVersion("test_act_s1", "PK", "2010-01-01", null, SECTION_TEXT)
    setAuthorityStoreForTests(store)
    const f = await newFirm()
    const check = { sectionId: "test_act_s1", asAtDate: "2020-01-01", jurisdiction: "PK", usedText: SECTION_TEXT }

    // A NON_FORUM draft of uncited prose with a true check on a section it never pleads: refused before any
    // evaluation, and nothing is stored (no result, no summary, no draft.gated event).
    const d = await create(f, f.A, NON_FORUM_TYPE, DEED_PROSE)
    expectErr(await apiErrorOf(gate(f, f.A, d.draftId, [check])), 422, "temporal_check_not_in_draft")
    expect(await resultDoc(d.draftId)).toBeUndefined()
    expect(await draftDoc(d.draftId)).toMatchObject({ gateResult: null })
    expect(await draftDoc(d.draftId)).not.toHaveProperty("lastGatedVersion")
    expect((await adminDb().collection("events").doc(`${d.draftId}_1_gated_1`).get()).exists).toBe(false)
    // Without the check the prose is what it is: NOT_ASSESSED, and approval needs the partner's override.
    expect((await gate(f, f.A, d.draftId)).status).toBe("NOT_ASSESSED")
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId)), 409, "gate_blocked")

    // A draft that pleads the text (here across a line break, with doubled spaces) is checked, and the match is OK.
    const pleads = await create(f, f.A, NON_FORUM_TYPE, `${DEED_PROSE}\nThe deed relies on Test Act s.1 as amended in 2018:\nthe limit is  sixty days.`)
    const ok = await gate(f, f.A, pleads.draftId, [check])
    expect(ok.status).toBe("OK")
    expect(ok.scope).toEqual({ citations: 0, temporalChecks: 1, assessed: true })
  })

  it("a stored OK result with no findings, written before F06, reads as NOT_ASSESSED and does not approve without an override", async () => {
    const f = await newFirm()
    const d = await create(f, f.A, NON_FORUM_TYPE, DEED_PROSE)
    await gate(f, f.A, d.draftId)
    // A result as the gate stored it before F06: status OK, no findings, no scope; the draft's summary says OK too.
    const legacyId = "11111111-1111-4111-8111-111111111111"
    const legacy: Record<string, unknown> = { ...(await resultDoc(d.draftId)) }
    delete legacy.scope
    await adminDb().collection("draft_gate_results").doc(`${d.draftId}_1`).set({ ...legacy, status: "OK", resultId: legacyId })
    await adminDb().collection("drafts").doc(d.draftId).update({ "gateResult.status": "OK", "gateResult.resultId": legacyId })

    const shown = (await report(f, f.P, d.draftId)).gateResult
    expect(shown).toMatchObject({ status: "NOT_ASSESSED", scope: NOT_ASSESSED_SCOPE, resultId: legacyId })
    // Approval re-runs the gate: the fresh evaluation decides, and it is NOT_ASSESSED.
    expectErr(await apiErrorOf(approve(f, f.P, d.draftId)), 409, "gate_blocked")
    expect(await draftDoc(d.draftId)).toMatchObject({ status: "draft", locked: false })
    expect(await resultDoc(d.draftId)).toMatchObject({ status: "NOT_ASSESSED", scope: NOT_ASSESSED_SCOPE })
    expect(await approvedEvents(f.firmId, d.draftId)).toHaveLength(0)
  })
})
