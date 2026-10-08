import { describe, expect, it } from "vitest"
import { Timestamp } from "firebase-admin/firestore"
import { adminDb } from "../src/admin"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { apiErrorOf, expectKind, viaApi } from "./api"

/**
 * Phase 2b-A Task 5 (spec P2-18, P2-30, P2-41; Review Focus 4): the L17.2 conflict-check
 * invariants across Tasks 1 and 4 and the 2a engine. A pair of clients A and B shares one CNIC
 * (one candidate link); a matter for a third client carries an opposing matter_parties row that
 * names B's entity. A check for A must never treat B's party row as A's confirmed identity until a
 * human has confirmed the pair, and a dispute or rejection never hardens it into a FLAG.
 */

type Hit = Record<string, unknown> & { outcome: string; type: string; hitRole: string; identityBasis: string; reliedOnLinkIds: string[]; matterNo: unknown }
type Check = { checkId: string; result: string; identityBasis: string; decision: string; hits: Hit[] }

const registerClient = viaApi<{ clientId: string; clientCode: string; entityId: string }>("registerClient")
const runCheck = viaApi<Check>("runConflictCheck")
const resolveReviewItem = viaApi<Check>("resolveReviewItem")
const openMatter = viaApi<Record<string, unknown>>("openMatter")
const confirmMerge = viaApi<{ mergeEventId: string | null; state: string }>("confirmMerge")
const disputeLink = viaApi<{ state: string; disputed: boolean }>("disputeLink")
const rejectLink = viaApi<{ state: string }>("rejectLink")

const CNIC_X = "4210112345671"
const NOTE = "Same CNIC and name on both intake forms, checked."
const RESOLVE_NOTE = "Different people: the party row is another man."
const claims = (firmId: string, role: string, clearanceLevel = "privileged-restricted") => ({ firmId, role, clearanceLevel })

async function newFirm(extra: Record<string, unknown> = {}): Promise<string> {
  const firmId = uniq("firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS", ...extra })
  return firmId
}

let mobileSeq = 0
const nextMobile = () => `0302${String(4000000 + ++mobileSeq)}`

async function register(token: string, firmId: string, extra: Record<string, unknown> = {}) {
  return registerClient({
    token,
    data: { firmId, name: "Muhammad Ali", type: "individual", primaryMobile: nextMobile(), classification: "internal", ...extra },
  } as never)
}

/** Firm with partner, associate, clients A and B (same CNIC), and the seeded opposing party row naming B's entity. */
async function seed(firmExtra: Record<string, unknown> = {}) {
  const firmId = await newFirm(firmExtra)
  const partner = await mintIdToken(claims(firmId, "partner"))
  const associate = await mintIdToken(claims(firmId, "associate", "internal"))
  const a = await register(partner.token, firmId, { name: "Muhammad Ali", cnic: CNIC_X })
  const b = await register(partner.token, firmId, { name: "Mohammad Ali Khan", cnic: CNIC_X })
  const third = await register(partner.token, firmId, { name: "Third Client" })
  const matterRef = adminDb().collection("matters").doc()
  await matterRef.set({
    firmId, clientId: third.clientId, matterNo: "NHS/2026/0009", title: "Seeded matter", stage: "pre_filing", status: "live",
    conflictCheckId: "seeded", classification: "confidential", createdAt: Timestamp.now(),
  })
  await adminDb().collection("matter_parties").add({
    firmId, matterId: matterRef.id, role: "opposing", name: "B Trading", names: ["b trading"], keys: { cnic: CNIC_X }, entityId: b.entityId,
    matterClassification: "confidential", matterStatus: "live", classification: "confidential",
  })
  const [left, right] = [a.entityId, b.entityId].sort()
  const cnicRowId = `${firmId}_${left}_${right}_cnic`
  const check = () =>
    runCheck({ token: partner.token, data: { firmId, client: { clientId: a.clientId }, opposingParties: [{ name: "Kamran Akmal" }] } } as never)
  return { firmId, partner, associate, a, b, third, cnicRowId, check }
}
type Seed = Awaited<ReturnType<typeof seed>>

const linkCall = (s: Seed, token: string, note = NOTE) => ({ token, data: { firmId: s.firmId, linkId: s.cnicRowId, note } }) as never
const open = (s: Seed, checkId: string) =>
  openMatter({ token: s.partner.token, data: { firmId: s.firmId, conflictCheckId: checkId, title: "Recovery suit", classification: "confidential" } } as never)

/** The requester resolves every review hit different_person; returns the cleared check. */
async function resolveAll(s: Seed, checkId: string): Promise<Check> {
  const stored = (await adminDb().collection("conflict_checks").doc(checkId).get()).data()!
  let last: Check | undefined
  for (const [index, h] of (stored.hits as Hit[]).entries()) {
    if (h.outcome !== "POSSIBLE_CANDIDATE_REVIEW") continue
    last = await resolveReviewItem({ token: s.partner.token, data: { firmId: s.firmId, checkId, hitIndex: index, resolution: "different_person", note: RESOLVE_NOTE } } as never)
  }
  return last!
}

/** Same-role hits: A's own record and client B (informational, role client). */
const sameRole = (hits: Hit[]) => hits.filter((h) => h.hitRole === "client")
const crossing = (hits: Hit[]) => hits.filter((h) => h.type === "adverse_history")

describe.skipIf(!EMULATORS)("L17.2 conflict invariants (P2-18, P2-30, P2-41)", () => {
  it("L17.2 invariant: confirmMerge turns a key review into FLAG and a contradicted resolution into check_stale", async () => {
    const s = await seed()
    const first = await s.check()
    expect(first.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    const reviews = first.hits.filter((h) => h.outcome === "POSSIBLE_CANDIDATE_REVIEW")
    expect(sameRole(first.hits)).toHaveLength(2)
    expect(reviews).toHaveLength(3)
    expect(crossing(first.hits)[0]).toMatchObject({ outcome: "POSSIBLE_CANDIDATE_REVIEW", identityBasis: "candidate_only", reliedOnLinkIds: [s.cnicRowId] })

    const cleared = await resolveAll(s, first.checkId)
    expect(cleared).toMatchObject({ result: "CLEAR", decision: "cleared" })

    const confirmed = await confirmMerge(linkCall(s, s.associate.token))
    expect(confirmed.state).toBe("confirmed")

    // Review Focus 4: the stored different_person resolution on the role-crossing hit is contradicted.
    expectKind(await apiErrorOf(open(s, first.checkId)), "failed-precondition", "check_stale")
    expect((await adminDb().collection("conflict_checks").doc(first.checkId).get()).data()).toMatchObject({ stale: true, boundMatterId: null })

    const fresh = await s.check()
    expect(fresh.result).toBe("FLAG")
    expect(crossing(fresh.hits)[0]).toMatchObject({ outcome: "FLAG", identityBasis: "confirmed_identity", reliedOnLinkIds: [s.cnicRowId] })
    expect(sameRole(fresh.hits).length).toBeGreaterThan(0)
    for (const h of sameRole(fresh.hits)) expect(h.outcome).toBe("NONE")
  })

  it("L17.2 invariant: a rejected or disputed pair is never confirmed identity", async () => {
    // Disputed: never FLAG, still a candidate identity; a check cleared before the dispute still opens a matter (P2-30).
    const d = await seed()
    const dBefore = await d.check()
    const dCleared = await resolveAll(d, dBefore.checkId)
    expect(dCleared).toMatchObject({ result: "CLEAR", decision: "cleared" })
    expect((await disputeLink(linkCall(d, d.partner.token))).disputed).toBe(true)
    const disputed = await d.check()
    expect(disputed.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    expect(disputed.identityBasis).toBe("candidate_only")
    expect(crossing(disputed.hits)[0]).toMatchObject({ outcome: "POSSIBLE_CANDIDATE_REVIEW", identityBasis: "candidate_only", reliedOnLinkIds: [d.cnicRowId] })
    expect(disputed.hits.some((h) => h.outcome === "FLAG")).toBe(false)
    expect(typeof (await open(d, dBefore.checkId)).matterId).toBe("string")

    // Rejected (separate firm): the same-role hit drops out, the role-crossing hit stays a review, never FLAG, never CLEAR.
    const r = await seed()
    const rBefore = await r.check()
    const rCleared = await resolveAll(r, rBefore.checkId)
    expect(rCleared).toMatchObject({ result: "CLEAR", decision: "cleared" })
    expect((await rejectLink(linkCall(r, r.partner.token))).state).toBe("rejected")
    const rejected = await r.check()
    expect(rejected.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    expect(sameRole(rejected.hits).length).toBeGreaterThan(0)
    for (const h of sameRole(rejected.hits)) expect(h.outcome).toBe("NONE")
    expect(crossing(rejected.hits)[0]).toMatchObject({ outcome: "POSSIBLE_CANDIDATE_REVIEW" })
    expect(rejected.hits.some((h) => h.outcome === "FLAG")).toBe(false)
    expect(typeof (await open(r, rBefore.checkId)).matterId).toBe("string")

    // Flag off: a confirmed pair is still only a candidate identity (P2-18).
    const off = await seed({ featureFlags: { L17_2_ENABLED: false } })
    await adminDb().collection("entity_links").doc(off.cnicRowId).update({ state: "confirmed" })
    const offCheck = await off.check()
    expect(offCheck.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    expect(offCheck.hits.some((h) => h.outcome === "FLAG")).toBe(false)
  })
})
