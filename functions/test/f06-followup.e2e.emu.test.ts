import { Timestamp } from "firebase-admin/firestore"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { adminDb } from "../src/admin"
import { InMemoryAuthorityStore, setAuthorityStoreForTests } from "../src/d4/authority"
import { LAW_DEPENDENT_BY_RULING } from "../src/d4/doctypes"
import { ApiError, apiErrorOf, viaApi } from "./api"
import { EMULATORS, mintIdToken, uniq } from "./emu"

/**
 * Two findings of the automated review on PR #34 (F06), end to end through the HTTP router, with real ID tokens from
 * the Auth emulator and every write read back from the Firestore emulator. Same harness as
 * f06-not-assessed.e2e.emu.test.ts.
 *
 * 1. Approval bypassed the pleaded-text guard (F06 ruling C). gateDraft refuses a temporal check whose usedText the
 *    version does not plead (422 temporal_check_not_in_draft), but approveDraft re-ran the gate with the checks recorded
 *    on the stored result and no such guard. A result stored before F06 can record a check the version never pleads:
 *    here a petition pleads the superseded 2015 text of a section, while the recorded check names the 2018 text in
 *    force. That check matches the store, so the fresh run was OK and the partner's approval passed with no override,
 *    on a petition that pleads law no longer in force. Now approval applies the same guard to the recorded checks:
 *    422 temporal_check_not_in_draft, nothing stored, nothing approved. The recovery is a re-gate on the same key with
 *    the text the version pleads, which shows the partner the mismatch; the partner's override then carries approval.
 *    The re-audit of the follow-up (FU-D1) found the override path open in the same way: a partner could write an
 *    immutable override on such a result, which no approval could use and which froze the version (R5). overrideGate
 *    now applies the same guard (case v).
 * 2. will_wasiyat was not law-dependent. It is NON_FORUM and no line of its checklist matches LEGAL_VERIFICATION_ITEM,
 *    yet "Dispositions within the permitted third or heirs' consent" is a condition of the will's validity (the limit
 *    on bequests). Approval accepted no review checklist for a will. Now the code-side ruling map
 *    (LAW_DEPENDENT_BY_RULING in functions/src/d4/doctypes.ts) makes it law-dependent: approval needs its checklist.
 *    The review on 48e1bab found that the ruling's reason never reached that checklist: a ruled type whose seed names
 *    no rule (a non-compete, a gift) could be approved on evidence for its clerical items alone. Now a ruled type's
 *    review checklist ends with one required item, "Legal verification (ruling): <the ruling's reason>", which
 *    getTypeProfile returns as reviewChecklistItems (case vi; the will's cases iii and iv answer it too; case vii
 *    proves it for every ruled type, with evidence aimed at the rule on a seed item not answering it).
 *
 * Fixtures follow P4-13: the year 2099, a test statute, no real judgment, statute or party.
 */

type GateScope = { citations: number; temporalChecks: number; assessed: boolean }
type TemporalFinding = { sectionId: string; asAtDate: string; jurisdiction: string; usedText: string; status: string; inForceText: string | null }
type GateResult = { draftId: string; version: number; status: string; scope: GateScope; resultId: string; citations: unknown[]; temporal: TemporalFinding[] }
type DraftView = { draftId: string; documentTypeId: string; status: string; locked: boolean; approvedBy?: string; approvedVersion?: number; gateResult: null | { status: string; overridden: boolean } }
type ChecklistEntry = { item: string; evidence: string }
type Approved = { draft: DraftView; gateResult: GateResult; reviewChecklist: ChecklistEntry[] | null }
type Overridden = { override: { cleared: Array<Record<string, unknown>>; by: string; reason: string }; draft: DraftView }
type Report = { gateResult: GateResult | null; override: Overridden["override"] | null; current: boolean }
type TypeProfile = { id: string; courtIds: string[]; checklist: string[]; reviewChecklistItems?: string[]; lawDependent?: boolean }

const createApi = viaApi<DraftView>("createDraft")
const gateApi = viaApi<GateResult>("gateDraft")
const reportApi = viaApi<Report>("getVerificationReport")
const overrideApi = viaApi<Overridden>("overrideGate")
const approveApi = viaApi<Approved>("approveDraft")
const profileApi = viaApi<TypeProfile>("getTypeProfile")

/** A forum-filed type: law-dependent, so every approval below sends its full review checklist. */
const PETITION_TYPE = "constitutional_petition_199"
/** A NON_FORUM instrument whose validity turns on the limit on bequests (finding 2). */
const WILL_TYPE = "will_wasiyat"
const WILL_THIRD_ITEM = "Dispositions within the permitted third or heirs' consent"
/** The will's ruling item: the one review item a ruled type adds after its seed items, from LAW_DEPENDENT_BY_RULING. */
const WILL_RULING_ITEM =
  "Legal verification (ruling): \"Dispositions within the permitted third or heirs' consent\": a bequest beyond the third, or to an heir, fails without the heirs' consent"
/** A ruled NON_FORUM type whose seed checklist names no rule at all: only the ruling item asks for the legal check. */
const NON_COMPETE_TYPE = "non_compete_agreement"
const NON_COMPETE_RULING_ITEM =
  "Legal verification (ruling): the covenant itself: an agreement in restraint of a lawful profession, trade or business is void except as the law saves it"
const NON_COMPETE_PROSE = "The seller shall not carry on a business of the same kind within the district for two years after the sale of the goodwill."
/** Uncited prose any ruled type can carry (case vii). */
const GENERIC_PROSE = "The executant declares the terms stated below, in the presence of the attesting witnesses who sign."

/** The two texts of test_act_s1 in PK: in force 2010-01-01 to 2018-06-01, and from 2018-06-01. */
const TEXT_2015 = "Test Act s.1 as it stood in 2015: the limit is thirty days."
const TEXT_2018 = "Test Act s.1 as amended in 2018: the limit is sixty days."
/** A petition that pleads the superseded 2015 text, and never the 2018 text, for an order made in 2020. */
const PETITION_PROSE = `The petitioner filed the appeal within time. The petition pleads ${TEXT_2015}\nThe respondents have failed to act.`
/** The check a result stored before F06 could record: true for 2020, and not pleaded by the petition. */
const CHECK_2020 = { sectionId: "test_act_s1", asAtDate: "2020-01-01", jurisdiction: "PK" }
const UNPLEADED_CHECK = { ...CHECK_2020, usedText: TEXT_2018 }
/** The same key with the text the petition does plead (R10: the caller's usedText wins on a shared key). */
const PLEADED_CHECK = { ...CHECK_2020, usedText: TEXT_2015 }
/** A pre-F06 result id (R6: every stored result has one). */
const LEGACY_RESULT_ID = "22222222-2222-4222-8222-222222222222"

const WILL_PROSE =
  "The testator, of sound mind and free will, revokes every earlier will and bequeaths one half of the estate to a friend of the family. The attesting witnesses sign below."
const REASON = "The partner has read the draft against the file and accepts the risk on the record."
/** Evidence at the floor (20 characters once trimmed) and one character below it (ruling B). */
const EVIDENCE_20 = "Verified on the file"
const EVIDENCE_19 = "Checked by partner."

type Member = { uid: string; token: string }
type Firm = { firmId: string; matterId: string; P: Member; A: Member }

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
  return { firmId, matterId, P: await member("partner"), A: await member("associate") }
}

const send = <T>(api: (c: never) => Promise<T>, f: Firm, m: Member, data: Record<string, unknown>): Promise<T> =>
  api({ token: m.token, data: { firmId: f.firmId, ...data } } as never)

const create = (f: Firm, m: Member, documentTypeId: string, body: string) =>
  send(createApi, f, m, { matterId: f.matterId, documentTypeId, title: "Draft for review", body })
const gate = (f: Firm, m: Member, draftId: string, temporalChecks?: unknown) =>
  send(gateApi, f, m, { draftId, version: 1, ...(temporalChecks === undefined ? {} : { temporalChecks }) })
/** The id of the stored result the partner reviewed, as the verification report shows it. */
const reviewedResultId = async (f: Firm, draftId: string): Promise<string> =>
  (await send(reportApi, f, f.P, { draftId })).gateResult?.resultId ?? "no-result"
const override = async (f: Firm, draftId: string) =>
  send(overrideApi, f, f.P, { draftId, version: 1, reason: REASON, resultId: await reviewedResultId(f, draftId) })
const approve = async (f: Firm, draftId: string, extra: Record<string, unknown> = {}) =>
  send(approveApi, f, f.P, { draftId, version: 1, resultId: await reviewedResultId(f, draftId), ...extra })

/** The type's seed checklist as the type profile route returns it, each distinct item once, in the seed's order. */
async function checklistOf(f: Firm, typeId: string): Promise<string[]> {
  return [...new Set((await send(profileApi, f, f.P, { typeId })).checklist)]
}
/** The review checklist an approval must answer, as the type profile route returns it (`reviewChecklistItems`). */
async function reviewItemsOf(f: Firm, typeId: string): Promise<string[]> {
  const items = (await send(profileApi, f, f.P, { typeId })).reviewChecklistItems
  expect(Array.isArray(items)).toBe(true)
  return items as string[]
}
const fullChecklist = (items: readonly string[]): ChecklistEntry[] =>
  items.map((item, i) => ({ item, evidence: `Reviewed against the file, point ${i + 1}: confirmed by the partner on the record.` }))

const draftDoc = async (id: string) => (await adminDb().collection("drafts").doc(id).get()).data()
const resultDoc = async (id: string) => (await adminDb().collection("draft_gate_results").doc(`${id}_1`).get()).data()
const approvedEvents = async (firmId: string, draftId: string) =>
  (await adminDb().collection("events").where("firmId", "==", firmId).get()).docs.filter((d) => d.data().name === "draft.approved" && d.data().payload?.draftId === draftId)
const overrideExists = async (id: string) => (await adminDb().collection("draft_gate_overrides").doc(`${id}_1`).get()).exists
const auditOf = async (action: string, target: string) =>
  (await adminDb().collection("audit_log").where("action", "==", action).where("target", "==", target).get()).docs.map((d) => [d.data().decision, d.data().reason])
const approveAudit = (draftId: string) => auditOf("draft.approve", `drafts/${draftId}`)
const overrideAudit = (draftId: string) => auditOf("draft.gate_override", `draft_gate_overrides/${draftId}_1`)

function expectErr(err: ApiError, status: number, code: string): void {
  expect({ status: err.status, code: err.code }).toEqual({ status, code })
}

/**
 * A petition gated once, whose stored result is then rewritten as the gate stored results before F06 ruling C: no
 * scope, and a recorded temporal check on text the petition never pleads. By default the status is OK and the check is
 * the 2018 text in force for 2020 (a true check); a test may give another status, other recorded findings and another
 * body. The draft's summary carries the same status and result id. Returns the draft id and the stored result as seeded.
 */
async function legacyPetition(
  f: Firm,
  legacy: { status?: string; temporal?: TemporalFinding[]; body?: string } = {}
): Promise<{ draftId: string; seeded: Record<string, unknown> }> {
  const status = legacy.status ?? "OK"
  const d = await create(f, f.A, PETITION_TYPE, legacy.body ?? PETITION_PROSE)
  // A real first run (no check) gives the result, its citations, the summary and lastGatedVersion a real shape.
  expect(typeof (await gate(f, f.A, d.draftId)).resultId).toBe("string")
  const seeded: Record<string, unknown> = { ...(await resultDoc(d.draftId)) }
  delete seeded.scope
  Object.assign(seeded, {
    status,
    resultId: LEGACY_RESULT_ID,
    temporal: legacy.temporal ?? [{ ...UNPLEADED_CHECK, status: "OK", inForceText: TEXT_2018 }],
  })
  await adminDb().collection("draft_gate_results").doc(`${d.draftId}_1`).set(seeded)
  await adminDb().collection("drafts").doc(d.draftId).update({ "gateResult.status": status, "gateResult.resultId": LEGACY_RESULT_ID })
  return { draftId: d.draftId, seeded }
}

/** A will drafted by the associate, gated (NOT_ASSESSED: it cites nothing) and overridden by the partner. */
async function overriddenWill(f: Firm): Promise<string> {
  const d = await create(f, f.A, WILL_TYPE, WILL_PROSE)
  const g = await gate(f, f.A, d.draftId)
  expect(g.status).toBe("NOT_ASSESSED")
  const o = await override(f, d.draftId)
  expect(o.override.cleared).toEqual([{ kind: "scope", status: "NOT_ASSESSED" }])
  return d.draftId
}

let store: InMemoryAuthorityStore
beforeEach(() => {
  store = new InMemoryAuthorityStore()
  store.addSectionVersion("test_act_s1", "PK", "2010-01-01", "2018-06-01", TEXT_2015)
  store.addSectionVersion("test_act_s1", "PK", "2018-06-01", null, TEXT_2018)
  setAuthorityStoreForTests(store)
})
afterEach(() => {
  setAuthorityStoreForTests(null)
})

describe.skipIf(!EMULATORS)("F06 follow-up: approval holds recorded checks to the pleaded text, and a will is law-dependent (end to end through the HTTP routes)", () => {
  it("(i) a legacy stored result whose recorded check the version does not plead, though its text is in force, is refused 422 temporal_check_not_in_draft on approval: nothing approved, no result stored", async () => {
    const f = await newFirm()
    const { draftId, seeded } = await legacyPetition(f)
    // The report shows the legacy result as the partner would review it: OK, with the check that matched the store.
    const shown = (await send(reportApi, f, f.P, { draftId })).gateResult
    expect(shown).toMatchObject({ status: "OK", resultId: LEGACY_RESULT_ID, scope: { citations: 0, temporalChecks: 1, assessed: true } })
    const full = fullChecklist(await checklistOf(f, PETITION_TYPE))

    // The partner approves with the full review checklist and no override. Approval re-runs the gate with the recorded
    // check, which the petition does not plead: refused before any evaluation, exactly as gateDraft refuses it.
    expectErr(await apiErrorOf(approve(f, draftId, { reviewChecklist: full })), 422, "temporal_check_not_in_draft")

    // Nothing approved: the draft is unlocked, unapproved, with the summary it had.
    const draft = await draftDoc(draftId)
    expect(draft).toMatchObject({ status: "draft", locked: false, gateResult: { status: "OK", resultId: LEGACY_RESULT_ID } })
    expect(draft).not.toHaveProperty("approvedBy")
    expect(draft).not.toHaveProperty("reviewChecklist")
    expect(await approvedEvents(f.firmId, draftId)).toHaveLength(0)
    // No result stored: the legacy result is exactly as seeded (an approval run would replace it with a fresh resultId).
    expect(await resultDoc(draftId)).toEqual(seeded)
    // One deny row, as for any refusal before the approval's transaction.
    expect(await approveAudit(draftId)).toEqual([["deny", "temporal_check_not_in_draft"]])
  })

  it("(ii) the recovery: a re-gate re-supplies the check on the same key with the text the version pleads, the gate shows the mismatch, and approval passes on the partner's override", async () => {
    const f = await newFirm()
    const { draftId } = await legacyPetition(f)
    const full = fullChecklist(await checklistOf(f, PETITION_TYPE))
    expectErr(await apiErrorOf(approve(f, draftId, { reviewChecklist: full })), 422, "temporal_check_not_in_draft")

    // A re-gate with no check carries the recorded one (R10), which the petition does not plead: refused too.
    expectErr(await apiErrorOf(gate(f, f.A, draftId)), 422, "temporal_check_not_in_draft")
    // The same key with the text the petition pleads replaces it. Now the gate checks what the petition says: the 2015
    // text for a 2020 date is a mismatch with the text in force, which the partner is shown.
    const g = await gate(f, f.A, draftId, [PLEADED_CHECK])
    expect(g.status).toBe("TEMPORAL_MISMATCH")
    expect(g.scope).toEqual({ citations: 0, temporalChecks: 1, assessed: true })
    expect(g.temporal).toEqual([{ ...PLEADED_CHECK, status: "TEMPORAL_MISMATCH", inForceText: TEXT_2018 }])
    expect((await resultDoc(draftId))?.resultId).toBe(g.resultId)

    // Approval on that run is blocked without an override, so the mismatch reaches the partner flagged.
    expectErr(await apiErrorOf(approve(f, draftId, { reviewChecklist: full })), 409, "gate_blocked")
    expect(await draftDoc(draftId)).toMatchObject({ status: "draft", locked: false })

    // The partner overrides the mismatch they were shown, and approval passes on that override.
    const o = await override(f, draftId)
    expect(o.override.cleared).toEqual([{ kind: "temporal", ...CHECK_2020, status: "TEMPORAL_MISMATCH" }])
    const a = await approve(f, draftId, { reviewChecklist: full })
    expect(a.draft).toMatchObject({ status: "approved", locked: true, approvedBy: f.P.uid, approvedVersion: 1 })
    expect(a.draft.gateResult).toMatchObject({ status: "TEMPORAL_MISMATCH", overridden: true })
    expect(a.gateResult.temporal).toEqual([{ ...PLEADED_CHECK, status: "TEMPORAL_MISMATCH", inForceText: TEXT_2018 }])
    expect(await approvedEvents(f.firmId, draftId)).toHaveLength(1)
    // One row per approval call: the guard's refusal, the blocked run, the approval.
    expect((await approveAudit(draftId)).map((row) => row.join(":")).sort()).toEqual(["allow:ok", "deny:gate_blocked", "deny:temporal_check_not_in_draft"])
  })

  it("(iii) a will_wasiyat draft approved with no review checklist, after the partner's override, answers 422 review_checklist_incomplete and stays unapproved", async () => {
    const f = await newFirm()
    const items = await reviewItemsOf(f, WILL_TYPE)
    expect(items).toContain(WILL_THIRD_ITEM)
    expect(items.at(-1)).toBe(WILL_RULING_ITEM)
    const draftId = await overriddenWill(f)

    // The override clears the gate, not the review: a will's validity turns on the limit on bequests.
    expectErr(await apiErrorOf(approve(f, draftId)), 422, "review_checklist_incomplete")
    // Every item but the permitted third is not enough either.
    const withoutThird = fullChecklist(items).filter((e) => e.item !== WILL_THIRD_ITEM)
    expect(withoutThird).toHaveLength(items.length - 1)
    expectErr(await apiErrorOf(approve(f, draftId, { reviewChecklist: withoutThird })), 422, "review_checklist_incomplete")

    expect(await draftDoc(draftId)).toMatchObject({ status: "draft", locked: false })
    expect(await draftDoc(draftId)).not.toHaveProperty("approvedBy")
    expect(await approvedEvents(f.firmId, draftId)).toHaveLength(0)
    expect(await approveAudit(draftId)).toEqual([
      ["deny", "review_checklist_incomplete"],
      ["deny", "review_checklist_incomplete"],
    ])
  })

  it("(iv) the same will, with every checklist item and evidence of 20 or more characters, passes the checklist requirement and is approved", async () => {
    const f = await newFirm()
    // Every item: the distinct seed items, then the ruling item.
    const items = await reviewItemsOf(f, WILL_TYPE)
    expect(items).toEqual([...(await checklistOf(f, WILL_TYPE)), WILL_RULING_ITEM])
    const draftId = await overriddenWill(f)
    expectErr(await apiErrorOf(approve(f, draftId)), 422, "review_checklist_incomplete")
    // The seed items alone, each with evidence, leave the ruling item unanswered.
    expectErr(await apiErrorOf(approve(f, draftId, { reviewChecklist: fullChecklist(items.slice(0, -1)) })), 422, "review_checklist_incomplete")
    // Evidence of 19 characters once trimmed is not evidence (ruling B).
    expect([...EVIDENCE_19]).toHaveLength(19)
    const short = items.map((item) => ({ item, evidence: item === WILL_THIRD_ITEM ? EVIDENCE_19 : `  ${EVIDENCE_20}\n` }))
    expectErr(await apiErrorOf(approve(f, draftId, { reviewChecklist: short })), 422, "review_checklist_incomplete")

    // Every item, with at least 20 characters of evidence each (exactly 20 is enough), in any order.
    const full = items.map((item) => ({ item, evidence: item === WILL_THIRD_ITEM ? "The one-half bequest exceeds the third: heirs' written consent is on the file." : `  ${EVIDENCE_20}\n` }))
    const a = await approve(f, draftId, { reviewChecklist: [...full].reverse() })
    const stored = full.map((e) => ({ item: e.item, evidence: e.evidence.trim() }))
    expect(a.draft).toMatchObject({ status: "approved", locked: true, approvedBy: f.P.uid, approvedVersion: 1 })
    expect(a.draft.gateResult).toMatchObject({ status: "NOT_ASSESSED", overridden: true })
    expect(a.reviewChecklist).toEqual(stored)
    expect(a.reviewChecklist?.at(-1)?.item).toBe(WILL_RULING_ITEM)
    expect(await draftDoc(draftId)).toMatchObject({ status: "approved", locked: true, reviewChecklist: stored })
    expect(await approvedEvents(f.firmId, draftId)).toHaveLength(1)
  })

  it("(v) a partner override of a legacy non-OK result whose recorded check the version does not plead is refused 422 temporal_check_not_in_draft, so the version is not frozen: a re-gate re-supplying the key, then override and approval, pass", async () => {
    const f = await newFirm()
    const full = fullChecklist(await checklistOf(f, PETITION_TYPE))
    // A legacy TEMPORAL_MISMATCH whose recorded check is a wording of the section the petition never pleads.
    const neverPleaded = { ...CHECK_2020, usedText: "Test Act s.1 in a wording the petition never pleads." }
    const { draftId, seeded } = await legacyPetition(f, {
      status: "TEMPORAL_MISMATCH",
      temporal: [{ ...neverPleaded, status: "TEMPORAL_MISMATCH", inForceText: TEXT_2018 }],
    })
    expect((await send(reportApi, f, f.P, { draftId })).gateResult).toMatchObject({ status: "TEMPORAL_MISMATCH", resultId: LEGACY_RESULT_ID })

    // Before the guard, the partner's override was written and froze the version (R5): approval then answered 422 and
    // a re-gate 409 already_overridden. Now the override is refused before anything is written.
    expectErr(await apiErrorOf(override(f, draftId)), 422, "temporal_check_not_in_draft")
    expect(await overrideExists(draftId)).toBe(false)
    expect(await overrideAudit(draftId)).toEqual([["deny", "temporal_check_not_in_draft"]])
    expect(await resultDoc(draftId)).toEqual(seeded)
    expect(await draftDoc(draftId)).toMatchObject({ status: "draft", locked: false, gateResult: { status: "TEMPORAL_MISMATCH", overridden: false, resultId: LEGACY_RESULT_ID } })

    // With no override the version is not frozen: the same key re-supplied with the text the petition pleads re-gates it.
    const g = await gate(f, f.A, draftId, [PLEADED_CHECK])
    expect(g.status).toBe("TEMPORAL_MISMATCH")
    expect(g.temporal).toEqual([{ ...PLEADED_CHECK, status: "TEMPORAL_MISMATCH", inForceText: TEXT_2018 }])
    // The normal path: the partner overrides the run they were shown, then approves.
    const o = await override(f, draftId)
    expect(o.override.cleared).toEqual([{ kind: "temporal", ...CHECK_2020, status: "TEMPORAL_MISMATCH" }])
    const a = await approve(f, draftId, { reviewChecklist: full })
    expect(a.draft).toMatchObject({ status: "approved", locked: true, approvedBy: f.P.uid, approvedVersion: 1 })
    expect(a.draft.gateResult).toMatchObject({ status: "TEMPORAL_MISMATCH", overridden: true })
    expect((await overrideAudit(draftId)).map((row) => row.join(":")).sort()).toEqual(["allow:ok", "deny:temporal_check_not_in_draft"])

    // The same refusal for a legacy UNVERIFIED citation beside an unpleaded check the store says is true: the override
    // would clear the citation and leave a version no approval and no re-gate could move.
    const cited = await legacyPetition(f, {
      status: "UNVERIFIED",
      body: `${PETITION_PROSE}\nThe petitioner relies on 2099 SCMR 7.`,
      temporal: [{ ...UNPLEADED_CHECK, status: "OK", inForceText: TEXT_2018 }],
    })
    expect((cited.seeded.citations as Array<{ status: string }>).map((c) => c.status)).toEqual(["UNVERIFIED"])
    expectErr(await apiErrorOf(override(f, cited.draftId)), 422, "temporal_check_not_in_draft")
    expect(await overrideExists(cited.draftId)).toBe(false)
    expect(await overrideAudit(cited.draftId)).toEqual([["deny", "temporal_check_not_in_draft"]])
  })

  it("(vi) a ruled type whose seed checklist names no rule (a non-compete) is not approved on evidence for its seed items alone: the ruling item needs evidence too, and is stored last", async () => {
    const f = await newFirm()
    const seedItems = await checklistOf(f, NON_COMPETE_TYPE)
    // The seed asks about parties, recitals, consideration, execution, registration and stamp duty: nothing on the
    // restraint of trade that makes the covenant law-dependent.
    expect(seedItems.filter((item) => /restrain|restraint|trade|compet/i.test(item))).toEqual([])
    const d = await create(f, f.A, NON_COMPETE_TYPE, NON_COMPETE_PROSE)
    expect((await gate(f, f.A, d.draftId)).status).toBe("NOT_ASSESSED")
    await override(f, d.draftId)

    // Evidence on every seed item, none on the ruled legal verification: refused, nothing approved.
    const seedOnly = fullChecklist(seedItems)
    expectErr(await apiErrorOf(approve(f, d.draftId, { reviewChecklist: seedOnly })), 422, "review_checklist_incomplete")
    expect(await draftDoc(d.draftId)).toMatchObject({ status: "draft", locked: false })
    expect(await draftDoc(d.draftId)).not.toHaveProperty("reviewChecklist")
    expect(await approvedEvents(f.firmId, d.draftId)).toHaveLength(0)

    // A client learns the item before any approval: the type profile adds the review checklist and whether it is
    // required, and keeps the seed row's own fields as they were.
    const profile = await send(profileApi, f, f.P, { typeId: NON_COMPETE_TYPE })
    expect(profile.reviewChecklistItems).toEqual([...seedItems, NON_COMPETE_RULING_ITEM])
    expect(profile.lawDependent).toBe(true)
    expect([...new Set(profile.checklist)]).toEqual(seedItems)
    expect(profile.checklist).not.toContain(NON_COMPETE_RULING_ITEM)

    // The ruling item goes through the same rule as every other item: evidence under 20 characters, the item twice, or
    // a ruling item the type does not have, is 422.
    const ruling = { item: NON_COMPETE_RULING_ITEM, evidence: "The restraint is limited to the goodwill sold, within the district, for two years: within the saving." }
    expectErr(await apiErrorOf(approve(f, d.draftId, { reviewChecklist: [...seedOnly, { ...ruling, evidence: EVIDENCE_19 }] })), 422, "review_checklist_incomplete")
    expectErr(await apiErrorOf(approve(f, d.draftId, { reviewChecklist: [...seedOnly, ruling, ruling] })), 422, "review_checklist_incomplete")
    expectErr(
      await apiErrorOf(approve(f, d.draftId, { reviewChecklist: [...seedOnly, { ...ruling, item: WILL_RULING_ITEM }] })),
      422,
      "review_checklist_incomplete"
    )
    expect(await approvedEvents(f.firmId, d.draftId)).toHaveLength(0)

    // With the ruling item answered (sent first: any order), it is approved; the stored checklist keeps the type's
    // order, the ruling item last.
    const a = await approve(f, d.draftId, { reviewChecklist: [ruling, ...seedOnly] })
    expect(a.draft).toMatchObject({ status: "approved", locked: true, approvedBy: f.P.uid, approvedVersion: 1 })
    expect(a.reviewChecklist).toEqual([...seedOnly, ruling])
    expect(a.reviewChecklist?.at(-1)).toEqual(ruling)
    expect(await draftDoc(d.draftId)).toMatchObject({ status: "approved", locked: true, reviewChecklist: [...seedOnly, ruling] })
    expect(await approvedEvents(f.firmId, d.draftId)).toHaveLength(1)
  })

  // Every ruled type, not one example: the ruling item is its own distinct item, so evidence on the seed items (even
  // evidence that names the ruled rule) never answers it.
  it.each([...LAW_DEPENDENT_BY_RULING.keys()].sort())(
    "(vii) %s requires its own ruling item: evidence on every seed item, even evidence aimed at the rule, is 422; with the ruling item it is approved and stored last",
    async (typeId) => {
      const f = await newFirm()
      const seedItems = await checklistOf(f, typeId)
      const d = await create(f, f.A, typeId, GENERIC_PROSE)
      expect((await gate(f, f.A, d.draftId)).status).toBe("NOT_ASSESSED")
      await override(f, d.draftId)
      const ruling = `Legal verification (ruling): ${LAW_DEPENDENT_BY_RULING.get(typeId)}`

      // Evidence on every seed item, the first one aimed at the ruled rule itself: the ruling item is still unanswered.
      const seedOnly = fullChecklist(seedItems).map((e, i) => (i === 0 ? { ...e, evidence: `${ruling}: checked against the file by the partner.` } : e))
      expectErr(await apiErrorOf(approve(f, d.draftId, { reviewChecklist: seedOnly })), 422, "review_checklist_incomplete")
      expect(await draftDoc(d.draftId)).toMatchObject({ status: "draft", locked: false })
      expect(await approvedEvents(f.firmId, d.draftId)).toHaveLength(0)

      // The type profile names the item; answered as itself, the approval passes and stores it last.
      expect(await reviewItemsOf(f, typeId)).toEqual([...seedItems, ruling])
      const answer = { item: ruling, evidence: "The partner verified the ruled rule against the file and the law in force." }
      const a = await approve(f, d.draftId, { reviewChecklist: [answer, ...seedOnly] })
      expect(a.draft).toMatchObject({ status: "approved", locked: true, approvedBy: f.P.uid })
      expect(a.reviewChecklist).toEqual([...seedOnly, answer])
      expect(await draftDoc(d.draftId)).toMatchObject({ status: "approved", reviewChecklist: [...seedOnly, answer] })
    }
  )
})
