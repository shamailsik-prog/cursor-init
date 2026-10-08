import { describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { adminDb } from "../src/admin"
import { effectiveLinkState } from "../src/d1/entity/linkState"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { apiErrorOf, expectKind, viaApi } from "./api"

/**
 * Phase 2b-A Task 4 (spec P2-24..P2-28, P2-34, P2-35, P2-39): the decision routes of the L17.2
 * entity review — confirmMerge, disputeLink, rejectLink — over the emulators through the HTTP
 * router, on a fake clock (`now`). Every decision applies to every key row of the entity pair.
 */

const NOW = Date.parse("2026-10-08T00:00:00Z")
const DAY = 24 * 60 * 60 * 1000
const clock = { now: () => NOW }

type Decision = { pairId: string; linkIds: string[]; state: string; disputed: boolean; mergeEventId: string | null; classification: string }

const registerClient = viaApi<{ clientId: string; clientCode: string; entityId: string }>("registerClient")
const confirmMerge = viaApi<Decision>("confirmMerge", clock)
const disputeLink = viaApi<Decision>("disputeLink", clock)
const rejectLink = viaApi<Decision>("rejectLink", clock)

const CNIC = "42101-1234567-1"
const MOBILE = "03001234567"
const NOTE = "Same CNIC and mobile on both intake forms, checked."

const claims = (firmId: string, role: string, clearanceLevel = "privileged-restricted") => ({ firmId, role, clearanceLevel })

async function newFirm(extra: Record<string, unknown> = {}): Promise<string> {
  const firmId = uniq("firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS", ...extra })
  return firmId
}

type Reg = { clientId: string; clientCode: string; entityId: string }
async function register(token: string, firmId: string, extra: Record<string, unknown> = {}): Promise<Reg> {
  return registerClient({
    token,
    data: { firmId, name: "Muhammad Ali", type: "individual", primaryMobile: MOBILE, cnic: CNIC, classification: "internal", ...extra },
  } as never)
}

type Setup = { firmId: string; partner: { uid: string; token: string }; associate: { uid: string; token: string }; a: Reg; b: Reg; left: string; right: string; pairId: string; cnicRow: string; phoneRow: string }

/** A firm with A and B registered on the same CNIC and mobile: one pair, rows `…_cnic` and `…_phone`. */
async function setup(bExtra: Record<string, unknown> = {}, associateClearance = "internal"): Promise<Setup> {
  const firmId = await newFirm()
  const partner = await mintIdToken(claims(firmId, "partner"))
  const associate = await mintIdToken(claims(firmId, "associate", associateClearance))
  const a = await register(partner.token, firmId, { name: "Muhammad Ali" })
  const b = await register(partner.token, firmId, { name: "Mohammad Ali", ...bExtra })
  const [left, right] = [a.entityId, b.entityId].sort()
  return {
    firmId,
    partner,
    associate,
    a,
    b,
    left,
    right,
    pairId: `${left}_${right}`,
    cnicRow: `${firmId}_${left}_${right}_cnic`,
    phoneRow: `${firmId}_${left}_${right}_phone`,
  }
}

const rowsOf = async (s: Setup): Promise<DocumentData[]> =>
  Promise.all([s.cnicRow, s.phoneRow].map(async (id) => (await adminDb().collection("entity_links").doc(id).get()).data()!))

async function ageRows(s: Setup, ageMs: number) {
  for (const id of [s.cnicRow, s.phoneRow]) await adminDb().collection("entity_links").doc(id).update({ createdAt: Timestamp.fromMillis(NOW - ageMs) })
}

const call = (token: string, firmId: string, linkId: string, note = NOTE) => ({ token, data: { firmId, linkId, note } }) as never

async function mergeEventsOf(firmId: string, pairId: string) {
  return (await adminDb().collection("merge_events").where("firmId", "==", firmId).where("pairId", "==", pairId).get()).docs
}

async function confirmedEventsOf(firmId: string) {
  return (await adminDb().collection("events").where("firmId", "==", firmId).where("name", "==", "entity.confirmed").get()).docs
}

/** The call's own allow rows (the permission decision row names the firm, not the link). */
async function allowRows(uid: string, action: string, target: string) {
  const rows = await adminDb().collection("audit_log").where("actorId", "==", uid).where("action", "==", action).get()
  return rows.docs.map((d) => d.data()).filter((r) => r.decision === "allow" && r.target === target)
}

describe.skipIf(!EMULATORS)("confirmMerge (P2-24, P2-26, P2-39)", () => {
  it("an associate confirms the pair by its phone row: every key row confirmed, one immutable merge_event, one entity.confirmed event, one allow row", async () => {
    const s = await setup()
    expect((await rowsOf(s)).map((r) => r.state)).toEqual(["candidate", "candidate"])

    const out = await confirmMerge(call(s.associate.token, s.firmId, s.phoneRow))
    expect(out).toMatchObject({ pairId: s.pairId, state: "confirmed", disputed: false, classification: "internal" })
    expect(out.linkIds).toEqual([s.cnicRow, s.phoneRow].sort())
    expect(typeof out.mergeEventId).toBe("string")
    const id = out.mergeEventId!

    for (const row of await rowsOf(s)) {
      expect(row.state).toBe("confirmed")
      expect(row.disputed).toBe(false)
      expect(row.classification).toBe("internal")
      expect(row.confirmation).toMatchObject({ by: s.associate.uid, role: "associate", note: NOTE, mergeEventId: id })
      expect(row.confirmation.at).toBeInstanceOf(Timestamp)
    }

    const me = (await adminDb().collection("merge_events").doc(id).get()).data()!
    expect(me).toMatchObject({
      firmId: s.firmId,
      kind: "link_confirmed",
      leftId: s.left,
      rightId: s.right,
      pairId: s.pairId,
      linkIds: [s.cnicRow, s.phoneRow].sort(),
      keys: ["cnic", "phone"],
      score: 0.99,
      basis: "deterministic_key",
      priorState: "candidate",
      actorId: s.associate.uid,
      actorRole: "associate",
      reverted: false,
      classification: "internal",
      evidence: { note: NOTE, keyValues: { cnic: "4210112345671", phone: "+923001234567" } },
    })
    expect(me.confirmedAt).toBeInstanceOf(Timestamp)
    expect(me.createdAt).toBeInstanceOf(Timestamp)
    const names = { [s.a.entityId]: "Muhammad Ali", [s.b.entityId]: "Mohammad Ali" }
    expect(me.snapshot.left).toMatchObject({ entityId: s.left, canonicalName: names[s.left], cnic: "4210112345671", phone: "+923001234567", classification: "internal" })
    expect(me.snapshot.right).toMatchObject({ entityId: s.right, canonicalName: names[s.right], classification: "internal" })

    const events = await confirmedEventsOf(s.firmId)
    expect(events).toHaveLength(1)
    expect(events[0].id).toBe(`${id}_confirmed`)
    expect(events[0].data()).toMatchObject({
      name: "entity.confirmed",
      firmId: s.firmId,
      payload: { entityIds: [s.left, s.right], mergeEventId: id, score: 0.99 },
      classification: "internal",
      idempotencyKey: `${id}:confirmed`,
    })
    expect(await allowRows(s.associate.uid, "entity.confirm", `entity_links/${s.phoneRow}`)).toHaveLength(1)

    // A second confirm (either row) is a 409; nothing more is written.
    expectKind(await apiErrorOf(confirmMerge(call(s.partner.token, s.firmId, s.cnicRow))), "failed-precondition", "link_not_candidate")
    expect(await mergeEventsOf(s.firmId, s.pairId)).toHaveLength(1)
  })

  it("two parallel confirms on one pair (one per row id) → one 200 and one 409 link_not_candidate; one merge_event, one event (Review Focus 1)", async () => {
    const s = await setup()
    const settled = await Promise.allSettled([
      confirmMerge(call(s.associate.token, s.firmId, s.cnicRow)),
      confirmMerge(call(s.partner.token, s.firmId, s.phoneRow)),
    ])
    const statuses = settled.map((r) => (r.status === "fulfilled" ? 200 : (r.reason as { status: number }).status)).sort()
    expect(statuses).toEqual([200, 409])
    const refused = settled.find((r) => r.status === "rejected") as PromiseRejectedResult
    expect((refused.reason as { code: string }).code).toBe("link_not_candidate")
    expect(await mergeEventsOf(s.firmId, s.pairId)).toHaveLength(1)
    expect(await confirmedEventsOf(s.firmId)).toHaveLength(1)
    const ids = new Set((await rowsOf(s)).map((r) => r.confirmation.mergeEventId))
    expect(ids.size).toBe(1)
  })

  it("rows aged 31 d (auto-confirmed) → confirm records priorState auto_confirmed", async () => {
    const s = await setup()
    await ageRows(s, 31 * DAY)
    const out = await confirmMerge(call(s.associate.token, s.firmId, s.cnicRow))
    const me = (await adminDb().collection("merge_events").doc(out.mergeEventId!).get()).data()!
    expect(me.priorState).toBe("auto_confirmed")
  })

  it("classification is monotonic: a lowered row is raised to the pair label; an internal associate gets 404 and nothing is written (Review Focus 5)", async () => {
    const s = await setup({ classification: "confidential" })
    for (const row of await rowsOf(s)) expect(row.classification).toBe("confidential")
    await adminDb().collection("entity_links").doc(s.cnicRow).update({ classification: "internal" })

    // The internal associate addresses the (now internal) row: the pair's label is confidential → 404.
    expectKind(await apiErrorOf(confirmMerge(call(s.associate.token, s.firmId, s.cnicRow))), "not-found", "not_found")
    expectKind(await apiErrorOf(disputeLink(call(s.associate.token, s.firmId, s.cnicRow))), "not-found", "not_found")
    expect((await rowsOf(s)).map((r) => [r.state, r.disputed])).toEqual([
      ["candidate", false],
      ["candidate", false],
    ])
    expect(await mergeEventsOf(s.firmId, s.pairId)).toHaveLength(0)

    const confidentialPartner = await mintIdToken(claims(s.firmId, "partner", "confidential"))
    const out = await confirmMerge(call(confidentialPartner.token, s.firmId, s.cnicRow))
    expect(out.classification).toBe("confidential")
    for (const row of await rowsOf(s)) expect([row.state, row.classification]).toEqual(["confirmed", "confidential"])
    const me = (await adminDb().collection("merge_events").doc(out.mergeEventId!).get()).data()!
    expect(me.classification).toBe("confidential")
    expect((await adminDb().collection("events").doc(`${out.mergeEventId}_confirmed`).get()).data()!.classification).toBe("confidential")
  })

  it("a disputed pair: an associate's confirm → 403 role_not_permitted, pair unchanged; a partner's → 200, priorState disputed, rows keep disputed (Review Focus 3)", async () => {
    const s = await setup()
    await disputeLink(call(s.associate.token, s.firmId, s.cnicRow, "These look like two different people, check."))
    const before = await rowsOf(s)

    expectKind(await apiErrorOf(confirmMerge(call(s.associate.token, s.firmId, s.phoneRow))), "permission-denied", "role_not_permitted")
    expect(await rowsOf(s)).toEqual(before)
    expect(await mergeEventsOf(s.firmId, s.pairId)).toHaveLength(0)

    const out = await confirmMerge(call(s.partner.token, s.firmId, s.phoneRow))
    expect(out).toMatchObject({ state: "confirmed", disputed: true })
    const me = (await adminDb().collection("merge_events").doc(out.mergeEventId!).get()).data()!
    expect(me).toMatchObject({ priorState: "disputed", actorRole: "partner" })
    for (const row of await rowsOf(s)) {
      expect(row).toMatchObject({ state: "confirmed", disputed: true, dispute: { by: s.associate.uid } })
      expect(row.confirmation).toMatchObject({ by: s.partner.uid, role: "partner", mergeEventId: out.mergeEventId })
    }
  })

  it("the same Idempotency-Key twice → identical body, one merge_event", async () => {
    const s = await setup()
    const key = randomUUID()
    const once = () =>
      confirmMerge({ token: s.associate.token, data: { firmId: s.firmId, linkId: s.cnicRow, note: NOTE }, headers: { "idempotency-key": key } } as never)
    const first = await once()
    const second = await once()
    // The router replays the stored body and marks it `reused: true` (http/idempotency.ts).
    expect(second).toEqual({ ...first, reused: true })
    expect(await mergeEventsOf(s.firmId, s.pairId)).toHaveLength(1)
  })

  it("merge_events are immutable: a later dispute attempt on the confirmed pair leaves the doc's updateTime unchanged", async () => {
    const s = await setup()
    const out = await confirmMerge(call(s.associate.token, s.firmId, s.cnicRow))
    const ref = adminDb().collection("merge_events").doc(out.mergeEventId!)
    const before = (await ref.get()).updateTime!
    expectKind(await apiErrorOf(disputeLink(call(s.partner.token, s.firmId, s.phoneRow))), "failed-precondition", "link_not_candidate")
    expectKind(await apiErrorOf(rejectLink(call(s.partner.token, s.firmId, s.phoneRow))), "failed-precondition", "link_not_candidate")
    expect((await ref.get()).updateTime!.isEqual(before)).toBe(true)
  })
})

describe.skipIf(!EMULATORS)("disputeLink (P2-26, P2-28)", () => {
  it("an associate disputes: every key row disputed with the note; a second dispute → 409 already_disputed; no event", async () => {
    const s = await setup()
    const note = "Different fathers' names on the two CNIC copies."
    const out = await disputeLink(call(s.associate.token, s.firmId, s.phoneRow, `  ${note}  `))
    expect(out).toMatchObject({ pairId: s.pairId, state: "candidate", disputed: true, mergeEventId: null, classification: "internal" })
    expect(out.linkIds).toEqual([s.cnicRow, s.phoneRow].sort())
    for (const row of await rowsOf(s)) {
      expect(row).toMatchObject({ state: "candidate", disputed: true, classification: "internal", dispute: { by: s.associate.uid, role: "associate", note } })
      expect(row.dispute.at).toBeInstanceOf(Timestamp)
      expect(row.confirmation).toBeUndefined()
    }
    expect(await allowRows(s.associate.uid, "entity.dispute", `entity_links/${s.phoneRow}`)).toHaveLength(1)
    expectKind(await apiErrorOf(disputeLink(call(s.partner.token, s.firmId, s.cnicRow))), "failed-precondition", "already_disputed")
    expect(await confirmedEventsOf(s.firmId)).toHaveLength(0)
    expect(await mergeEventsOf(s.firmId, s.pairId)).toHaveLength(0)
  })

  it("a 31-day-old (auto-confirmed) pair may still be disputed; its effective state becomes disputed (late dispute)", async () => {
    const s = await setup()
    await ageRows(s, 31 * DAY)
    for (const row of await rowsOf(s)) expect(effectiveLinkState(row, NOW, true)).toBe("auto_confirmed")
    await disputeLink(call(s.associate.token, s.firmId, s.cnicRow))
    for (const row of await rowsOf(s)) expect(effectiveLinkState(row, NOW, true)).toBe("disputed")
  })
})

describe.skipIf(!EMULATORS)("rejectLink (P2-26, P2-27)", () => {
  it("an associate → 403 role_not_permitted; a partner rejects every key row; every decision afterwards → 409 link_not_candidate", async () => {
    const s = await setup()
    expectKind(await apiErrorOf(rejectLink(call(s.associate.token, s.firmId, s.cnicRow))), "permission-denied", "role_not_permitted")
    expect((await rowsOf(s)).map((r) => r.state)).toEqual(["candidate", "candidate"])

    const out = await rejectLink(call(s.partner.token, s.firmId, s.cnicRow))
    expect(out).toMatchObject({ pairId: s.pairId, state: "rejected", disputed: false, mergeEventId: null, classification: "internal" })
    for (const row of await rowsOf(s)) {
      expect(row).toMatchObject({ state: "rejected", classification: "internal", rejection: { by: s.partner.uid, role: "partner", note: NOTE } })
      expect(row.rejection.at).toBeInstanceOf(Timestamp)
    }
    expect(await allowRows(s.partner.uid, "entity.reject", `entity_links/${s.cnicRow}`)).toHaveLength(1)
    for (const op of [confirmMerge, disputeLink, rejectLink]) {
      expectKind(await apiErrorOf(op(call(s.partner.token, s.firmId, s.phoneRow))), "failed-precondition", "link_not_candidate")
    }
    expect(await mergeEventsOf(s.firmId, s.pairId)).toHaveLength(0)
  })
})

describe.skipIf(!EMULATORS)("registry version (Bugbot PR #8: openMatter's re-screen guard)", () => {
  const version = async (firmId: string) => (await adminDb().collection("counters").doc(`${firmId}_registry`).get()).data()?.version ?? 0

  it("confirmMerge, disputeLink and rejectLink each bump the firm's registry version once; a refused decision leaves it", async () => {
    const confirmed = await setup()
    const before = await version(confirmed.firmId)
    await confirmMerge(call(confirmed.associate.token, confirmed.firmId, confirmed.phoneRow))
    expect(await version(confirmed.firmId)).toBe(before + 1)
    await apiErrorOf(confirmMerge(call(confirmed.associate.token, confirmed.firmId, confirmed.cnicRow))) // 409 link_not_candidate
    expect(await version(confirmed.firmId)).toBe(before + 1)

    const disputed = await setup()
    const beforeDispute = await version(disputed.firmId)
    await disputeLink(call(disputed.associate.token, disputed.firmId, disputed.cnicRow))
    expect(await version(disputed.firmId)).toBe(beforeDispute + 1)

    const rejected = await setup()
    const beforeReject = await version(rejected.firmId)
    await apiErrorOf(rejectLink(call(rejected.associate.token, rejected.firmId, rejected.cnicRow))) // 403 role_not_permitted
    expect(await version(rejected.firmId)).toBe(beforeReject)
    await rejectLink(call(rejected.partner.token, rejected.firmId, rejected.cnicRow))
    expect(await version(rejected.firmId)).toBe(beforeReject + 1)
  })
})

describe.skipIf(!EMULATORS)("decision validation and gates (P2-31, P2-34, P2-35)", () => {
  it("note of 19 chars → 400 note_too_short; non-string note or linkId 'a/b' → 400 invalid_query; unknown and other-firm linkId → 404", async () => {
    const s = await setup()
    for (const op of [confirmMerge, disputeLink, rejectLink]) {
      expectKind(await apiErrorOf(op(call(s.partner.token, s.firmId, s.cnicRow, "x".repeat(19)))), "invalid-argument", "note_too_short")
      expectKind(await apiErrorOf(op(call(s.partner.token, s.firmId, s.cnicRow, `  ${"x".repeat(19)}   `))), "invalid-argument", "note_too_short")
      expectKind(await apiErrorOf(op({ token: s.partner.token, data: { firmId: s.firmId, linkId: s.cnicRow, note: 42 } } as never)), "invalid-argument", "invalid_query")
      expectKind(await apiErrorOf(op(call(s.partner.token, s.firmId, "a/b"))), "invalid-argument", "invalid_query")
      expectKind(await apiErrorOf(op(call(s.partner.token, s.firmId, "no-such-link"))), "not-found", "not_found")
    }
    const other = await newFirm()
    const otherPartner = await mintIdToken(claims(other, "partner"))
    for (const op of [confirmMerge, disputeLink, rejectLink]) {
      expectKind(await apiErrorOf(op(call(otherPartner.token, other, s.cnicRow))), "not-found", "not_found")
    }
    expect((await rowsOf(s)).map((r) => [r.state, r.disputed])).toEqual([
      ["candidate", false],
      ["candidate", false],
    ])
  })

  it("a client above the caller's clearance hides the pair (as in the queue): 404 not_found, nothing written; a cleared partner's decision carries the client's label", async () => {
    const s = await setup()
    await adminDb().collection("clients").doc(s.b.clientId).update({ classification: "confidential" })
    expectKind(await apiErrorOf(disputeLink(call(s.associate.token, s.firmId, s.cnicRow))), "not-found", "not_found")
    expect((await rowsOf(s)).map((r) => [r.disputed, r.classification])).toEqual([
      [false, "internal"],
      [false, "internal"],
    ])
    const out = await disputeLink(call(s.partner.token, s.firmId, s.cnicRow))
    expect(out.classification).toBe("confidential")
    for (const row of await rowsOf(s)) expect(row.classification).toBe("confidential")
  })

  it("L17.2 off → 404 feature_disabled; clerk → 403 role_not_permitted", async () => {
    const off = await newFirm({ featureFlags: { L17_2_ENABLED: false } })
    const partner = await mintIdToken(claims(off, "partner"))
    for (const op of [confirmMerge, disputeLink, rejectLink]) {
      expectKind(await apiErrorOf(op(call(partner.token, off, "some-link"))), "not-found", "feature_disabled")
    }
    const s = await setup()
    const clerk = await mintIdToken(claims(s.firmId, "clerk"))
    for (const op of [confirmMerge, disputeLink, rejectLink]) {
      expectKind(await apiErrorOf(op(call(clerk.token, s.firmId, s.cnicRow))), "permission-denied", "role_not_permitted")
    }
  })
})
