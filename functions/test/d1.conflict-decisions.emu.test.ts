import { describe, expect, it } from "vitest"
import { Timestamp } from "firebase-admin/firestore"
import { adminDb } from "../src/admin"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { apiErrorOf, expectKind, viaApi } from "./api"

/**
 * Review resolution, partner waiver and the conflict trail (spec P2-7, P2-8, P2-14, P2-19, P2-20).
 * Checks are seeded with the Admin SDK in the stored shape so every hit type is reachable.
 */

type Hit = Record<string, unknown> & { outcome: string; identityBasis: string; review?: { resolution: string; by: string; note: string } }
type Check = { checkId: string; result: string; identityBasis: string; decision: string; hits: Hit[] }

const resolve = viaApi<Check>("resolveReviewItem")
const waive = viaApi<Check>("recordPartnerWaiver")
const trail = viaApi<{ items: { kind: string; actorId: string }[]; nextCursor: null }>("getConflictTrail")
const getResult = viaApi<Check & { waiver?: unknown }>("getConflictResult")

const claims = (firmId: string, role: string, clearanceLevel = "privileged-restricted") => ({ firmId, role, clearanceLevel })
const NOTE20 = "Different people: CNIC differs on file."
const NOTE50 = "Partner waiver: the clients are not adverse in substance, informed consent is on file."

async function newFirm(): Promise<string> {
  const firmId = uniq("firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal" })
  return firmId
}

const hit = (type: string, outcome: string, extra: Record<string, unknown> = {}) => ({
  subjectIndex: 0,
  hitRole: "client",
  type,
  basis: "key",
  score: 1,
  identityBasis: outcome === "FLAG" ? "confirmed_identity" : "candidate_only",
  outcome,
  matchedName: "Muhammad Ali",
  matterId: null,
  matterNo: null,
  matterClassification: "confidential",
  reliedOnLinkIds: [],
  ...extra,
})

async function seedCheck(
  firmId: string,
  requestedBy: string,
  hits: Record<string, unknown>[],
  extra: Record<string, unknown> = {}
): Promise<string> {
  const top = hits.some((h) => h.outcome === "FLAG") ? "FLAG" : hits.some((h) => h.outcome === "POSSIBLE_CANDIDATE_REVIEW") ? "POSSIBLE_CANDIDATE_REVIEW" : "CLEAR"
  const ref = adminDb().collection("conflict_checks").doc()
  await ref.set({
    firmId,
    requestedBy,
    subjects: [{ role: "opposing", name: "Muhammad Ali", keys: {} }],
    hits,
    result: top,
    identityBasis: hits.some((h) => h.outcome !== "NONE" && h.identityBasis === "candidate_only") ? "candidate_only" : "confirmed_identity",
    classification: "confidential",
    decision: top === "CLEAR" ? "cleared" : "pending",
    boundMatterId: null,
    stale: false,
    createdAt: Timestamp.now(),
    ...extra,
  })
  await adminDb().collection("conflict_events").add({
    firmId, checkId: ref.id, kind: "decided", actorId: requestedBy, detail: {}, classification: "confidential", createdAt: Timestamp.now(),
  })
  return ref.id
}

const review = (checkId: string, token: string, firmId: string, hitIndex: number, resolution: string, note = NOTE20) =>
  resolve({ token, data: { firmId, checkId, hitIndex, resolution, note } } as never)

describe.skipIf(!EMULATORS)("resolveReviewItem", () => {
  it("different_person → NONE, recorded on the hit; last review item resolved → CLEAR, decision cleared, trail row", async () => {
    const firmId = await newFirm()
    const associate = await mintIdToken(claims(firmId, "associate"))
    const checkId = await seedCheck(firmId, associate.uid, [hit("direct_adverse", "POSSIBLE_CANDIDATE_REVIEW")])
    const out = await review(checkId, associate.token, firmId, 0, "different_person")
    expect(out).toMatchObject({ result: "CLEAR", decision: "cleared", identityBasis: "confirmed_identity" })
    expect(out.hits[0]).toMatchObject({ outcome: "NONE", review: { resolution: "different_person", by: associate.uid, note: NOTE20 } })
    const stored = (await adminDb().collection("conflict_checks").doc(checkId).get()).data()
    expect(stored).toMatchObject({ result: "CLEAR", decision: "cleared" })
    const rows = await adminDb().collection("conflict_events").where("checkId", "==", checkId).get()
    expect(rows.docs.map((d) => d.data().kind).sort()).toEqual(["decided", "review_resolved"])
  })

  it("same_person on a role-crossing hit → FLAG with confirmed_identity; the check stays pending and the overall basis follows the remaining hits", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const checkId = await seedCheck(firmId, partner.uid, [hit("former_client", "POSSIBLE_CANDIDATE_REVIEW"), hit("adverse_history", "POSSIBLE_CANDIDATE_REVIEW")])
    const first = await review(checkId, partner.token, firmId, 0, "same_person")
    expect(first.hits[0]).toMatchObject({ outcome: "FLAG", identityBasis: "confirmed_identity" })
    expect(first).toMatchObject({ result: "FLAG", decision: "pending", identityBasis: "candidate_only" })
    const second = await review(checkId, partner.token, firmId, 1, "different_person")
    expect(second).toMatchObject({ result: "FLAG", decision: "pending", identityBasis: "confirmed_identity" })
  })

  it("same_person on an informational (same-role) hit → NONE", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const checkId = await seedCheck(firmId, partner.uid, [hit("informational", "POSSIBLE_CANDIDATE_REVIEW")])
    const out = await review(checkId, partner.token, firmId, 0, "same_person")
    expect(out.hits[0]).toMatchObject({ outcome: "NONE", review: { resolution: "same_person" } })
    expect(out).toMatchObject({ result: "CLEAR", decision: "cleared" })
  })

  it("not a review item (FLAG, NONE, already reviewed, out of range) → 409 not_review_item", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const checkId = await seedCheck(firmId, partner.uid, [hit("direct_adverse", "FLAG"), hit("informational", "NONE"), hit("former_client", "POSSIBLE_CANDIDATE_REVIEW")])
    for (const i of [0, 1, 9]) {
      expectKind(await apiErrorOf(review(checkId, partner.token, firmId, i, "different_person")), "failed-precondition", "not_review_item")
    }
    await review(checkId, partner.token, firmId, 2, "different_person")
    expectKind(await apiErrorOf(review(checkId, partner.token, firmId, 2, "different_person")), "failed-precondition", "not_review_item")
  })

  it("note under 20 characters → 400 note_too_short, nothing changes", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const checkId = await seedCheck(firmId, partner.uid, [hit("direct_adverse", "POSSIBLE_CANDIDATE_REVIEW")])
    expectKind(await apiErrorOf(review(checkId, partner.token, firmId, 0, "different_person", "too short")), "invalid-argument", "note_too_short")
    expect((await adminDb().collection("conflict_checks").doc(checkId).get()).data()?.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
  })

  it("a bound check → 409 check_already_bound; a clerk → 403; another firm → 404 not_found", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const bound = await seedCheck(firmId, partner.uid, [hit("direct_adverse", "POSSIBLE_CANDIDATE_REVIEW")], { boundMatterId: "m1" })
    expectKind(await apiErrorOf(review(bound, partner.token, firmId, 0, "different_person")), "failed-precondition", "check_already_bound")
    const open = await seedCheck(firmId, partner.uid, [hit("direct_adverse", "POSSIBLE_CANDIDATE_REVIEW")])
    const clerk = await mintIdToken(claims(firmId, "clerk"))
    expectKind(await apiErrorOf(review(open, clerk.token, firmId, 0, "different_person")), "permission-denied", "role_not_permitted")
    const otherFirm = await newFirm()
    const outsider = await mintIdToken(claims(otherFirm, "partner"))
    expectKind(await apiErrorOf(review(open, outsider.token, otherFirm, 0, "different_person")), "not-found", "not_found")
  })

  it("one allow audit row per call and no rule number in the response", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const checkId = await seedCheck(firmId, partner.uid, [hit("direct_adverse", "POSSIBLE_CANDIDATE_REVIEW")])
    const out = await review(checkId, partner.token, firmId, 0, "different_person")
    expect(JSON.stringify(out)).not.toMatch(/Rule\s*\d/i)
    const rows = await adminDb().collection("audit_log").where("actorId", "==", partner.uid).where("action", "==", "conflict.resolve_review").get()
    expect(rows.docs.map((d) => d.data()).filter((r) => r.target === `conflict_checks/${checkId}`).map((r) => r.decision)).toEqual(["allow"])
  })
})

describe.skipIf(!EMULATORS)("recordPartnerWaiver", () => {
  const body = (firmId: string, checkId: string, extra: Record<string, unknown> = {}) => ({
    firmId, checkId, note: NOTE50, clientConsent: true, consentReference: "Letter 2026-10-01", ...extra,
  })

  it("partner happy path → decision cleared, waiver stored, waived trail row, conflict.waived event", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const checkId = await seedCheck(firmId, partner.uid, [hit("direct_adverse", "FLAG")])
    const out = await waive({ token: partner.token, data: body(firmId, checkId) } as never)
    expect(out).toMatchObject({ result: "FLAG", decision: "cleared" })
    const stored = (await adminDb().collection("conflict_checks").doc(checkId).get()).data()
    expect(stored?.waiver).toMatchObject({ partnerId: partner.uid, note: NOTE50, clientConsent: true, consentReference: "Letter 2026-10-01" })
    const rows = await adminDb().collection("conflict_events").where("checkId", "==", checkId).get()
    expect(rows.docs.map((d) => d.data().kind).sort()).toEqual(["decided", "waived"])
    const event = (await adminDb().collection("events").where("firmId", "==", firmId).where("name", "==", "conflict.waived").get()).docs.map((d) => d.data())
    expect(event).toEqual([
      expect.objectContaining({ payload: { checkId, partnerId: partner.uid }, classification: "confidential", idempotencyKey: `${checkId}:waived` }),
    ])
    expect(JSON.stringify(out)).not.toMatch(/Rule\s*\d/i)
  })

  it("an associate → 403; a second waiver → 409 already_waived", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const associate = await mintIdToken(claims(firmId, "associate"))
    const checkId = await seedCheck(firmId, associate.uid, [hit("direct_adverse", "FLAG")])
    expectKind(await apiErrorOf(waive({ token: associate.token, data: body(firmId, checkId) } as never)), "permission-denied", "role_not_permitted")
    await waive({ token: partner.token, data: body(firmId, checkId) } as never)
    expectKind(await apiErrorOf(waive({ token: partner.token, data: body(firmId, checkId) } as never)), "failed-precondition", "already_waived")
  })

  it("an unresolved review hit → 409 review_pending; a CLEAR or review-only check → 409 not_waivable", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const pending = await seedCheck(firmId, partner.uid, [hit("direct_adverse", "FLAG"), hit("former_client", "POSSIBLE_CANDIDATE_REVIEW")])
    expectKind(await apiErrorOf(waive({ token: partner.token, data: body(firmId, pending) } as never)), "failed-precondition", "review_pending")
    const reviewOnly = await seedCheck(firmId, partner.uid, [hit("former_client", "POSSIBLE_CANDIDATE_REVIEW")])
    expectKind(await apiErrorOf(waive({ token: partner.token, data: body(firmId, reviewOnly) } as never)), "failed-precondition", "not_waivable")
    const clear = await seedCheck(firmId, partner.uid, [])
    expectKind(await apiErrorOf(waive({ token: partner.token, data: body(firmId, clear) } as never)), "failed-precondition", "not_waivable")
  })

  it("note under 50 → note_too_short; no consent or empty reference → consent_required", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const checkId = await seedCheck(firmId, partner.uid, [hit("direct_adverse", "FLAG")])
    expectKind(await apiErrorOf(waive({ token: partner.token, data: body(firmId, checkId, { note: "x".repeat(49) }) } as never)), "invalid-argument", "note_too_short")
    expectKind(await apiErrorOf(waive({ token: partner.token, data: body(firmId, checkId, { clientConsent: false }) } as never)), "invalid-argument", "consent_required")
    expectKind(await apiErrorOf(waive({ token: partner.token, data: body(firmId, checkId, { consentReference: "  " }) } as never)), "invalid-argument", "consent_required")
    expectKind(await apiErrorOf(waive({ token: partner.token, data: body(firmId, checkId, { clientConsent: "true" }) } as never)), "invalid-argument", "consent_required")
  })

  it("a partner cleared below the check's classification → 403 exceeds_own_clearance; a bound check → 409; another firm → 404", async () => {
    const firmId = await newFirm()
    const low = await mintIdToken(claims(firmId, "partner", "internal"))
    const partner = await mintIdToken(claims(firmId, "partner"))
    const checkId = await seedCheck(firmId, partner.uid, [hit("direct_adverse", "FLAG")])
    const err = await apiErrorOf(waive({ token: low.token, data: body(firmId, checkId) } as never))
    expectKind(err, "permission-denied", "exceeds_own_clearance")
    const bound = await seedCheck(firmId, partner.uid, [hit("direct_adverse", "FLAG")], { boundMatterId: "m1" })
    expectKind(await apiErrorOf(waive({ token: partner.token, data: body(firmId, bound) } as never)), "failed-precondition", "check_already_bound")
    const otherFirm = await newFirm()
    const outsider = await mintIdToken(claims(otherFirm, "partner"))
    expectKind(await apiErrorOf(waive({ token: outsider.token, data: body(otherFirm, checkId) } as never)), "not-found", "not_found")
  })

  it("the requester may waive their own check (a one-partner firm)", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const checkId = await seedCheck(firmId, partner.uid, [hit("direct_adverse", "FLAG")])
    expect((await waive({ token: partner.token, data: body(firmId, checkId) } as never)).decision).toBe("cleared")
  })
})

describe.skipIf(!EMULATORS)("getConflictTrail", () => {
  it("returns decided, review_resolved, waived in order", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const checkId = await seedCheck(firmId, partner.uid, [hit("direct_adverse", "FLAG"), hit("former_client", "POSSIBLE_CANDIDATE_REVIEW")])
    await review(checkId, partner.token, firmId, 1, "different_person")
    await waive({ token: partner.token, data: { firmId, checkId, note: NOTE50, clientConsent: true, consentReference: "R-1" } } as never)
    const out = await trail({ token: partner.token, data: { firmId, checkId } } as never)
    expect(out.items.map((i) => i.kind)).toEqual(["decided", "review_resolved", "waived"])
    expect(out.nextCursor).toBeNull()
    expect(out.items[2].actorId).toBe(partner.uid)
  })

  it("an associate reads only the trail of a check they requested; a non-requester → 404 not_found", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const associate = await mintIdToken(claims(firmId, "associate"))
    const mine = await seedCheck(firmId, associate.uid, [hit("direct_adverse", "FLAG")])
    const theirs = await seedCheck(firmId, partner.uid, [hit("direct_adverse", "FLAG")])
    expect((await trail({ token: associate.token, data: { firmId, checkId: mine } } as never)).items).toHaveLength(1)
    expectKind(await apiErrorOf(trail({ token: associate.token, data: { firmId, checkId: theirs } } as never)), "not-found", "not_found")
    expect((await trail({ token: partner.token, data: { firmId, checkId: mine } } as never)).items).toHaveLength(1)
  })

  it("another firm or a missing check → 404 not_found; a clerk → 403", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const checkId = await seedCheck(firmId, partner.uid, [])
    const otherFirm = await newFirm()
    const outsider = await mintIdToken(claims(otherFirm, "partner"))
    expectKind(await apiErrorOf(trail({ token: outsider.token, data: { firmId: otherFirm, checkId } } as never)), "not-found", "not_found")
    expectKind(await apiErrorOf(trail({ token: partner.token, data: { firmId, checkId: "nope" } } as never)), "not-found", "not_found")
    const clerk = await mintIdToken(claims(firmId, "clerk"))
    expectKind(await apiErrorOf(trail({ token: clerk.token, data: { firmId, checkId } } as never)), "permission-denied", "role_not_permitted")
  })
})

describe.skipIf(!EMULATORS)("read gate and clearance (controller ruling)", () => {
  const snapshot = async (checkId: string, firmId: string) => ({
    check: (await adminDb().collection("conflict_checks").doc(checkId).get()).data(),
    trail: (await adminDb().collection("conflict_events").where("checkId", "==", checkId).get()).size,
    events: (await adminDb().collection("events").where("firmId", "==", firmId).get()).size,
  })
  const wbody = (firmId: string, checkId: string, extra: Record<string, unknown> = {}) => ({
    firmId, checkId, note: NOTE50, clientConsent: true, consentReference: "Letter 1", ...extra,
  })

  it("trail: requester below the check's classification → 403 exceeds_own_clearance; low-clearance partner → 403; non-requesting associate → 404", async () => {
    const firmId = await newFirm()
    const low = await mintIdToken(claims(firmId, "associate", "internal"))
    const lowPartner = await mintIdToken(claims(firmId, "partner", "internal"))
    const other = await mintIdToken(claims(firmId, "associate"))
    const checkId = await seedCheck(firmId, low.uid, [hit("direct_adverse", "FLAG")])
    expectKind(await apiErrorOf(trail({ token: low.token, data: { firmId, checkId } } as never)), "permission-denied", "exceeds_own_clearance")
    expectKind(await apiErrorOf(trail({ token: lowPartner.token, data: { firmId, checkId } } as never)), "permission-denied", "exceeds_own_clearance")
    expectKind(await apiErrorOf(trail({ token: other.token, data: { firmId, checkId } } as never)), "not-found", "not_found")
  })

  it("resolve: non-requesting associate → 404 and unchanged; requester below the classification → 403 and unchanged", async () => {
    const firmId = await newFirm()
    const requester = await mintIdToken(claims(firmId, "associate", "internal"))
    const other = await mintIdToken(claims(firmId, "associate"))
    const checkId = await seedCheck(firmId, requester.uid, [hit("direct_adverse", "POSSIBLE_CANDIDATE_REVIEW")])
    const before = await snapshot(checkId, firmId)
    expectKind(await apiErrorOf(review(checkId, other.token, firmId, 0, "different_person")), "not-found", "not_found")
    expectKind(await apiErrorOf(review(checkId, requester.token, firmId, 0, "different_person")), "permission-denied", "exceeds_own_clearance")
    expect(await snapshot(checkId, firmId)).toEqual(before)
  })

  it("the clearance check precedes state checks (no oracle): a low-clearance requester on a bound check gets 403", async () => {
    const firmId = await newFirm()
    const requester = await mintIdToken(claims(firmId, "associate", "internal"))
    const checkId = await seedCheck(firmId, requester.uid, [hit("direct_adverse", "POSSIBLE_CANDIDATE_REVIEW")], { boundMatterId: "m1" })
    expectKind(await apiErrorOf(review(checkId, requester.token, firmId, 0, "different_person")), "permission-denied", "exceeds_own_clearance")
  })

  it("core flow: same_person on a role-crossing hit → FLAG confirmed, partner waiver clears it; trail decided → review_resolved → waived; one waive allow audit row", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const associate = await mintIdToken(claims(firmId, "associate"))
    const checkId = await seedCheck(firmId, associate.uid, [hit("direct_adverse", "POSSIBLE_CANDIDATE_REVIEW")])
    const flagged = await review(checkId, associate.token, firmId, 0, "same_person")
    expect(flagged).toMatchObject({ result: "FLAG", identityBasis: "confirmed_identity", decision: "pending" })
    expect(flagged.hits[0]).toMatchObject({ outcome: "FLAG", identityBasis: "confirmed_identity" })
    const out = await waive({ token: partner.token, data: wbody(firmId, checkId) } as never)
    expect(out.decision).toBe("cleared")
    const stored = (await adminDb().collection("conflict_checks").doc(checkId).get()).data()
    expect(stored).toMatchObject({ decision: "cleared", waiver: { partnerId: partner.uid, clientConsent: true } })
    const t = await trail({ token: partner.token, data: { firmId, checkId } } as never)
    expect(t.items.map((i) => i.kind)).toEqual(["decided", "review_resolved", "waived"])
    const ev = await adminDb().collection("events").where("firmId", "==", firmId).where("name", "==", "conflict.waived").get()
    expect(ev.size).toBe(1)
    const rows = await adminDb().collection("audit_log").where("actorId", "==", partner.uid).where("action", "==", "conflict.waive").get()
    expect(rows.docs.map((d) => d.data()).filter((r) => r.target === `conflict_checks/${checkId}`).map((r) => r.decision)).toEqual(["allow"])
  })

  it("boundaries: review note 19 → note_too_short, 20 → ok; waiver note 50 → ok", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const checkId = await seedCheck(firmId, partner.uid, [hit("direct_adverse", "POSSIBLE_CANDIDATE_REVIEW")])
    expectKind(await apiErrorOf(review(checkId, partner.token, firmId, 0, "same_person", "x".repeat(19))), "invalid-argument", "note_too_short")
    expect((await review(checkId, partner.token, firmId, 0, "same_person", "x".repeat(20))).result).toBe("FLAG")
    expect((await waive({ token: partner.token, data: wbody(firmId, checkId, { note: "y".repeat(50) }) } as never)).decision).toBe("cleared")
  })

  it("invalid resolution, out-of-range or non-integer hitIndex → 400 invalid_query (out of range → 409 not_review_item)", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const checkId = await seedCheck(firmId, partner.uid, [hit("direct_adverse", "POSSIBLE_CANDIDATE_REVIEW")])
    for (const [i, r] of [[0, "maybe"], [0, undefined], [-1, "same_person"], [1.5, "same_person"], ["0", "same_person"], [undefined, "same_person"]] as const) {
      expectKind(await apiErrorOf(resolve({ token: partner.token, data: { firmId, checkId, hitIndex: i, resolution: r, note: NOTE20 } } as never)), "invalid-argument", "invalid_query")
    }
    expectKind(await apiErrorOf(review(checkId, partner.token, firmId, 5, "same_person")), "failed-precondition", "not_review_item")
  })

  it("a rejected waiver leaves the check and the events collection untouched", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const low = await mintIdToken(claims(firmId, "partner", "internal"))
    const associate = await mintIdToken(claims(firmId, "associate"))
    const checkId = await seedCheck(firmId, partner.uid, [hit("direct_adverse", "FLAG")])
    const before = await snapshot(checkId, firmId)
    await apiErrorOf(waive({ token: low.token, data: wbody(firmId, checkId) } as never))
    await apiErrorOf(waive({ token: associate.token, data: wbody(firmId, checkId) } as never))
    await apiErrorOf(waive({ token: partner.token, data: wbody(firmId, checkId, { note: "short" }) } as never))
    await apiErrorOf(waive({ token: partner.token, data: wbody(firmId, checkId, { clientConsent: false }) } as never))
    expect(await snapshot(checkId, firmId)).toEqual(before)
  })
})

describe.skipIf(!EMULATORS)("conflict.decided on a decision change (final review I6)", () => {
  const decidedEvents = async (firmId: string) =>
    (await adminDb().collection("events").where("firmId", "==", firmId).where("name", "==", "conflict.decided").get()).docs.map((d) => ({ id: d.id, ...d.data() }))

  it("a resolve that changes the result emits conflict.decided as {checkId}_decided_1; one that changes neither result nor decision emits none", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const checkId = await seedCheck(firmId, partner.uid, [hit("former_client", "POSSIBLE_CANDIDATE_REVIEW"), hit("adverse_history", "POSSIBLE_CANDIDATE_REVIEW")])
    await review(checkId, partner.token, firmId, 0, "same_person") // POSSIBLE_CANDIDATE_REVIEW → FLAG
    expect(await decidedEvents(firmId)).toEqual([
      expect.objectContaining({
        id: `${checkId}_decided_1`,
        payload: { checkId, result: "FLAG", identityBasis: "candidate_only" },
        classification: "confidential",
        idempotencyKey: `${checkId}:decided:1`,
      }),
    ])
    await review(checkId, partner.token, firmId, 1, "different_person") // FLAG stays FLAG, pending stays pending
    expect((await decidedEvents(firmId)).map((e) => e.id)).toEqual([`${checkId}_decided_1`])
  })

  it("the n-th decision change is numbered n, from the counter stored on the check", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const checkId = await seedCheck(firmId, partner.uid, [hit("direct_adverse", "POSSIBLE_CANDIDATE_REVIEW")], { decidedChanges: 2 })
    const out = await review(checkId, partner.token, firmId, 0, "different_person") // → CLEAR, cleared
    expect(out).toMatchObject({ result: "CLEAR", decision: "cleared" })
    const events = await decidedEvents(firmId)
    expect(events).toEqual([
      expect.objectContaining({ id: `${checkId}_decided_3`, payload: { checkId, result: "CLEAR", identityBasis: "confirmed_identity" }, idempotencyKey: `${checkId}:decided:3` }),
    ])
    expect((await adminDb().collection("conflict_checks").doc(checkId).get()).data()?.decidedChanges).toBe(3)
  })
})

describe.skipIf(!EMULATORS)("waiver record (final review M3)", () => {
  it("the waived trail row carries note, clientConsent and consentReference; readers cleared for the check see the waiver", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const low = await mintIdToken(claims(firmId, "partner", "internal"))
    const checkId = await seedCheck(firmId, partner.uid, [hit("direct_adverse", "FLAG")])
    const out = await waive({ token: partner.token, data: { firmId, checkId, note: NOTE50, clientConsent: true, consentReference: "Letter 2026-10-01" } } as never)
    const waiver = { partnerId: partner.uid, note: NOTE50, clientConsent: true, consentReference: "Letter 2026-10-01" }
    expect((out as Check & { waiver?: unknown }).waiver).toMatchObject(waiver)

    const rows = (await adminDb().collection("conflict_events").where("checkId", "==", checkId).where("kind", "==", "waived").get()).docs
    expect(rows).toHaveLength(1)
    expect(rows[0].data().detail).toMatchObject({ partnerId: partner.uid, requestedBy: partner.uid, note: NOTE50, clientConsent: true, consentReference: "Letter 2026-10-01" })

    expect((await getResult({ token: partner.token, data: { firmId, checkId } } as never)).waiver).toMatchObject(waiver)
    expect(await getResult({ token: low.token, data: { firmId, checkId } } as never)).not.toHaveProperty("waiver")
  })
})
