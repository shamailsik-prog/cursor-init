import { describe, expect, it } from "vitest"
import { FieldValue, Timestamp } from "firebase-admin/firestore"
import { adminDb } from "../src/admin"
import { OPEN_SCREEN_ROUNDS, openMatterTestSeam } from "../src/d1/matter/ops"
import { karachiYear } from "../src/d1/numbering"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { apiErrorOf, expectKind, viaApi } from "./api"

/**
 * Opening matters on a cleared Module 6 conflict check, the stage flow and closure (spec P2-6,
 * P2-11..P2-14; Review Focus 3). Clients and checks go through the real routes; a check's state is
 * patched with the Admin SDK only to reach the refusal paths (bound, stale, aged, waived).
 */

type Matter = Record<string, unknown> & { matterId: string; matterNo: string; stage: string; status: string }
type Check = { checkId: string; result: string; decision: string; hits: Array<Record<string, unknown>> }

const registerClient = viaApi<{ clientId: string; entityId: string }>("registerClient")
const runCheck = viaApi<Check>("runConflictCheck")
const openMatter = viaApi<Matter>("openMatter")
const getMatter = viaApi<Matter>("getMatter")
const listMatters = viaApi<{ items: Matter[]; nextCursor: string | null }>("listMatters")
const advanceStage = viaApi<Matter>("advanceStage")
const closeMatter = viaApi<Matter>("closeMatter")

const claims = (firmId: string, role: string, clearanceLevel = "privileged-restricted") => ({ firmId, role, clearanceLevel })
const DAY_MS = 24 * 60 * 60 * 1000
const CNIC_X = "4210112345671"
const YEAR = karachiYear(new Date())
const REASON20 = "Client withdrew inst." // 21 characters

async function newFirm(): Promise<string> {
  const firmId = uniq("firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
  return firmId
}

let mobileSeq = 0
const nextMobile = () => `0301${String(3000000 + ++mobileSeq)}`

async function register(token: string, firmId: string, extra: Record<string, unknown> = {}) {
  return registerClient({
    token,
    data: { firmId, name: "Shahid Afridi", type: "individual", primaryMobile: nextMobile(), classification: "internal", ...extra },
  } as never)
}

/** A CLEAR check for a registered client against one distinct opposing party. */
async function clearCheck(token: string, firmId: string, clientId: string, opposing: Record<string, unknown> = { name: "Kamran Akmal" }) {
  const check = await runCheck({ token, data: { firmId, client: { clientId }, opposingParties: [opposing] } } as never)
  expect(check).toMatchObject({ result: "CLEAR", decision: "cleared" })
  return check.checkId
}

const open = (token: string, firmId: string, conflictCheckId: string, extra: Record<string, unknown> = {}) =>
  openMatter({ token, data: { firmId, conflictCheckId, title: "Recovery suit", classification: "confidential", ...extra } } as never)

/** A firm with prefixes, a partner, a registered client and a CLEAR check for it. */
async function setup() {
  const firmId = await newFirm()
  const partner = await mintIdToken(claims(firmId, "partner"))
  const client = await register(partner.token, firmId)
  const checkId = await clearCheck(partner.token, firmId, client.clientId)
  return { firmId, partner, client, checkId }
}

const checkRef = (id: string) => adminDb().collection("conflict_checks").doc(id)

describe.skipIf(!EMULATORS)("openMatter", () => {
  it("on a CLEAR check → NHS/YYYY/0001; matter, members, parties, opened event, binding, bound trail row, matter.created, one allow audit row", async () => {
    const { firmId, partner, client, checkId } = await setup()
    const associate = await mintIdToken(claims(firmId, "associate"))
    const out = await open(partner.token, firmId, checkId, { courtId: "LHC", memberUserIds: [associate.uid] })
    expect(out).toMatchObject({
      matterNo: `NHS/${YEAR}/0001`,
      stage: "pre_filing",
      status: "engagement_unconfirmed",
      clientId: client.clientId,
      conflictCheckId: checkId,
      title: "Recovery suit",
      courtId: "LHC",
      classification: "confidential",
    })
    const matterId = out.matterId
    const matter = (await adminDb().collection("matters").doc(matterId).get()).data()
    expect(matter).toMatchObject({ firmId, matterNo: `NHS/${YEAR}/0001`, stage: "pre_filing", status: "engagement_unconfirmed", classification: "confidential" })
    expect(matter?.createdAt).toBeInstanceOf(Timestamp)

    for (const uid of [partner.uid, associate.uid]) {
      const m = (await adminDb().collection("matter_members").doc(`${matterId}_${uid}`).get()).data()
      expect(m).toMatchObject({ firmId, matterId, userId: uid, classification: "confidential" })
    }

    const parties = (await adminDb().collection("matter_parties").where("matterId", "==", matterId).get()).docs.map((d) => d.data())
    expect(parties).toHaveLength(2)
    const clientParty = parties.find((p) => p.role === "client")
    const opposingParty = parties.find((p) => p.role === "opposing")
    expect(clientParty).toMatchObject({ firmId, name: "Shahid Afridi", entityId: client.entityId, matterStatus: "live", classification: "confidential", matterClassification: "confidential" })
    expect(clientParty?.names).toEqual(["shahid afridi"])
    expect(clientParty?.keys.phone).toMatch(/^\+923\d{9}$/)
    expect(opposingParty).toMatchObject({ firmId, name: "Kamran Akmal", names: ["kamran akmal"], keys: {}, matterStatus: "live" })

    const events = (await adminDb().collection("matter_events").where("matterId", "==", matterId).get()).docs.map((d) => d.data())
    expect(events).toEqual([expect.objectContaining({ firmId, kind: "opened", actorId: partner.uid, classification: "confidential" })])

    const check = (await checkRef(checkId).get()).data()
    expect(check?.boundMatterId).toBe(matterId)
    const trail = (await adminDb().collection("conflict_events").where("checkId", "==", checkId).get()).docs.map((d) => d.data())
    expect(trail.map((t) => t.kind).sort()).toEqual(["bound", "decided"])
    expect(trail.find((t) => t.kind === "bound")).toMatchObject({ firmId, actorId: partner.uid, detail: { matterId } })

    const created = (await adminDb().collection("events").doc(`${matterId}_created`).get()).data()
    expect(created).toMatchObject({
      name: "matter.created",
      firmId,
      payload: { matterId, clientId: client.clientId, courtId: "LHC", caseNumber: null, relevant_law_dates: [] },
      classification: "confidential",
      idempotencyKey: `${matterId}:created`,
    })
    expect(created?.occurredAt).toBeInstanceOf(Timestamp)

    const audit = (await adminDb().collection("audit_log").where("actorId", "==", partner.uid).where("action", "==", "matter.open").get()).docs
      .map((d) => d.data())
      .filter((r) => r.target === `matters/${matterId}`)
    expect(audit.map((r) => r.decision)).toEqual(["allow"])
  })

  it("the next matter in the firm is 0002", async () => {
    const { firmId, partner, client, checkId } = await setup()
    await open(partner.token, firmId, checkId)
    const second = await clearCheck(partner.token, firmId, client.clientId, { name: "Babar Azam" })
    expect((await open(partner.token, firmId, second)).matterNo).toBe(`NHS/${YEAR}/0002`)
  })

  it("matter_parties keys are normalised: a later check naming a new client with the opposing party's CNIC hits that party by key", async () => {
    const { firmId, partner, client } = await setup()
    const checkId = await clearCheck(partner.token, firmId, client.clientId, { name: "Kamran Akmal", keys: { cnic: "42101-1234567-1 ", phone: "0300 1112223" } })
    const { matterId } = await open(partner.token, firmId, checkId)
    const party = (await adminDb().collection("matter_parties").where("matterId", "==", matterId).where("role", "==", "opposing").get()).docs[0].data()
    expect(party.keys).toEqual({ cnic: CNIC_X, phone: "+923001112223" })

    const later = await runCheck({ token: partner.token, data: { firmId, client: { name: "Zzz Qqq", keys: { cnic: CNIC_X } }, opposingParties: [{ name: "Yyy Www" }] } } as never)
    expect(later.hits).toEqual(expect.arrayContaining([expect.objectContaining({ subjectIndex: 0, hitRole: "opposing", basis: "key", matchedName: "Kamran Akmal", matterId })]))
    expect(later.result).not.toBe("CLEAR")
  })

  it("an uncleared, bound, stale or 31-day-old check → 409 check_not_cleared / check_already_bound / check_stale / check_expired; another firm's → 404 check_not_found", async () => {
    const { firmId, partner, client } = await setup()
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ result: "POSSIBLE_CANDIDATE_REVIEW", decision: "pending" }, "check_not_cleared"],
      [{ result: "FLAG", decision: "pending" }, "check_not_cleared"],
      [{ result: "FLAG", decision: "cleared" }, "check_not_cleared"], // a FLAG is cleared only by a waiver
      [{ boundMatterId: "some-matter" }, "check_already_bound"],
      [{ stale: true }, "check_stale"],
      [{ createdAt: Timestamp.fromMillis(Date.now() - 31 * DAY_MS) }, "check_expired"],
    ]
    for (const [patch, code] of cases) {
      const checkId = await clearCheck(partner.token, firmId, client.clientId)
      await checkRef(checkId).update(patch)
      const err = await apiErrorOf(open(partner.token, firmId, checkId))
      expect([code, err.status, err.code]).toEqual([code, 409, code])
    }
    const otherFirm = await newFirm()
    const outsider = await mintIdToken(claims(otherFirm, "partner"))
    const checkId = await clearCheck(partner.token, firmId, client.clientId)
    expectKind(await apiErrorOf(open(outsider.token, otherFirm, checkId)), "not-found", "check_not_found")
    expectKind(await apiErrorOf(open(partner.token, firmId, "no-such-check")), "not-found", "check_not_found")
    expect((await checkRef(checkId).get()).data()?.boundMatterId).toBeNull()
  })

  it("a 29-day-old check opens: validity is measured from the stored createdAt", async () => {
    const { firmId, partner, checkId } = await setup()
    await checkRef(checkId).update({ createdAt: Timestamp.fromMillis(Date.now() - 29 * DAY_MS) })
    expect((await open(partner.token, firmId, checkId)).matterNo).toBe(`NHS/${YEAR}/0001`)
  })

  it("a FLAG check with a partner waiver (decision cleared, result stays FLAG) opens", async () => {
    const { firmId, partner, client } = await setup()
    const checkId = await clearCheck(partner.token, firmId, client.clientId)
    await checkRef(checkId).update({
      result: "FLAG",
      decision: "cleared",
      waiver: { partnerId: partner.uid, note: "n".repeat(60), clientConsent: true, consentReference: "REF-1", at: new Date().toISOString() },
    })
    expect((await open(partner.token, firmId, checkId)).conflictCheckId).toBe(checkId)
  })

  it("a check whose client was named, not a registered clientId → 409 subjects_mismatch", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const check = await runCheck({ token: partner.token, data: { firmId, client: { name: "Zainab Bibi" }, opposingParties: [{ name: "Kamran Akmal" }] } } as never)
    expect(check.decision).toBe("cleared")
    expectKind(await apiErrorOf(open(partner.token, firmId, check.checkId)), "failed-precondition", "subjects_mismatch")
  })

  it("two parallel opens on one check → one 200 and one 409 check_already_bound (Review Focus 3)", async () => {
    const { firmId, partner, checkId } = await setup()
    const results = await Promise.allSettled([open(partner.token, firmId, checkId), open(partner.token, firmId, checkId)])
    const ok = results.filter((r) => r.status === "fulfilled")
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
    expect(ok).toHaveLength(1)
    expect(failed.map((f) => [f.reason.status, f.reason.code])).toEqual([[409, "check_already_bound"]])
    const matters = await adminDb().collection("matters").where("firmId", "==", firmId).get()
    expect(matters.size).toBe(1)
  }, 60_000)

  it("10 parallel opens on 10 checks → 10 distinct numbers 0001..0010 (Review Focus 3)", async () => {
    const { firmId, partner, client } = await setup()
    // conflict.run is a p1 route (10 per user per minute): the checks are split across two requesters.
    const second = await mintIdToken(claims(firmId, "associate"))
    const checks: string[] = []
    for (let i = 0; i < 10; i++) {
      const by = i < 5 ? partner.token : second.token
      checks.push(await clearCheck(by, firmId, client.clientId, { name: `Opponent Number ${String.fromCharCode(65 + i)}${String.fromCharCode(75 + i)}` }))
    }
    const out = await Promise.all(checks.map((c) => open(partner.token, firmId, c)))
    const numbers = out.map((m) => m.matterNo).sort()
    expect(numbers).toEqual(Array.from({ length: 10 }, (_, i) => `NHS/${YEAR}/${String(i + 1).padStart(4, "0")}`))
  }, 120_000)

  it("memberUserIds: a client-role, accounts-role, other-firm or unknown uid → 400 invalid_member; more than 20 → 400", async () => {
    const { firmId, partner, client } = await setup()
    const clientUser = await mintIdToken(claims(firmId, "client", "internal"))
    const accounts = await mintIdToken(claims(firmId, "accounts", "internal"))
    const outsider = await mintIdToken(claims(await newFirm(), "associate"))
    for (const uid of [clientUser.uid, accounts.uid, outsider.uid, "no-such-user"]) {
      const checkId = await clearCheck(partner.token, firmId, client.clientId)
      expectKind(await apiErrorOf(open(partner.token, firmId, checkId, { memberUserIds: [uid] })), "invalid-argument", "invalid_member")
      expect((await checkRef(checkId).get()).data()?.boundMatterId).toBeNull()
    }
    const checkId = await clearCheck(partner.token, firmId, client.clientId)
    const many = Array.from({ length: 21 }, (_, i) => `u${i}`)
    expectKind(await apiErrorOf(open(partner.token, firmId, checkId, { memberUserIds: many })), "invalid-argument", "invalid_member")
  })

  it("classification above the caller's clearance → 403 exceeds_own_clearance; a clerk → 403 role_not_permitted", async () => {
    const { firmId, client } = await setup()
    const associate = await mintIdToken(claims(firmId, "associate", "confidential"))
    const checkId = await clearCheck(associate.token, firmId, client.clientId)
    expectKind(await apiErrorOf(open(associate.token, firmId, checkId, { classification: "privileged" })), "permission-denied", "exceeds_own_clearance")
    const clerk = await mintIdToken(claims(firmId, "clerk"))
    expectKind(await apiErrorOf(open(clerk.token, firmId, checkId)), "permission-denied", "role_not_permitted")
    expect((await open(associate.token, firmId, checkId)).classification).toBe("confidential")
  })

  it("a caller cleared below the check's classification → 403 exceeds_own_clearance before any state code; the check stays unbound, no matter", async () => {
    const { firmId, partner, checkId } = await setup()
    await checkRef(checkId).update({ classification: "privileged" })
    const low = await mintIdToken(claims(firmId, "associate", "internal"))
    expectKind(await apiErrorOf(open(low.token, firmId, checkId, { classification: "internal" })), "permission-denied", "exceeds_own_clearance")
    expect((await checkRef(checkId).get()).data()?.boundMatterId).toBeNull()
    expect((await adminDb().collection("matters").where("firmId", "==", firmId).get()).size).toBe(0)
    await checkRef(checkId).update({ boundMatterId: "some-matter" })
    expectKind(await apiErrorOf(open(low.token, firmId, checkId, { classification: "internal" })), "permission-denied", "exceeds_own_clearance")
    await checkRef(checkId).update({ boundMatterId: null, classification: "unknown-label" })
    expectKind(await apiErrorOf(open(partner.token, firmId, checkId)), "permission-denied", "exceeds_own_clearance")
  })

  it("binding raises the check's classification to the matter's when higher; the bound trail row carries it (final review I2a)", async () => {
    const { firmId, partner, checkId } = await setup()
    expect((await checkRef(checkId).get()).data()?.classification).toBe("confidential")
    const { matterId } = await open(partner.token, firmId, checkId, { classification: "privileged" })
    expect((await checkRef(checkId).get()).data()?.classification).toBe("privileged")
    const bound = (await adminDb().collection("conflict_events").where("checkId", "==", checkId).where("kind", "==", "bound").get()).docs
    expect(bound.map((d) => d.data())).toEqual([expect.objectContaining({ classification: "privileged", detail: { matterId } })])

    const lower = await clearCheck(partner.token, firmId, (await register(partner.token, firmId, { name: "Babar Azam" })).clientId, { name: "Yasir Shah" })
    await open(partner.token, firmId, lower, { classification: "internal" })
    expect((await checkRef(lower).get()).data()?.classification).toBe("confidential")
  })

  it("every matter_parties row is classified at the highest of the matter, the client record and the check (final review I2b)", async () => {
    const { firmId, partner, checkId } = await setup()
    const { matterId } = await open(partner.token, firmId, checkId, { classification: "internal" })
    const rows = (await adminDb().collection("matter_parties").where("matterId", "==", matterId).get()).docs.map((d) => d.data())
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r).toMatchObject({ classification: "confidential", matterClassification: "internal" })

    const secret = await register(partner.token, firmId, { name: "Babar Azam", classification: "privileged" })
    const second = await clearCheck(partner.token, firmId, secret.clientId, { name: "Yasir Shah" })
    await checkRef(second).update({ classification: "confidential" }) // only the client record is privileged
    const other = await open(partner.token, firmId, second, { classification: "confidential" })
    const rows2 = (await adminDb().collection("matter_parties").where("matterId", "==", other.matterId).get()).docs.map((d) => d.data())
    expect(rows2).toHaveLength(2)
    for (const r of rows2) expect(r).toMatchObject({ classification: "privileged", matterClassification: "confidential" })
  })

  it("re-screen at open: a CLEAR check whose opposing party has since become a client with a live matter → 409 check_stale, check marked stale (final review I5)", async () => {
    const { firmId, partner, checkId } = await setup() // Shahid Afridi vs Kamran Akmal, CLEAR
    const q = await register(partner.token, firmId, { name: "Kamran Akmal" })
    await open(partner.token, firmId, await clearCheck(partner.token, firmId, q.clientId, { name: "Babar Azam" }))

    const counters = async () => (await adminDb().collection("counters").where("firmId", "==", firmId).get()).docs.map((d) => [d.id, d.data().count ?? d.data().next ?? d.data().version])
    const checksBefore = (await adminDb().collection("conflict_checks").where("firmId", "==", firmId).get()).size
    const countersBefore = await counters()

    expectKind(await apiErrorOf(open(partner.token, firmId, checkId)), "failed-precondition", "check_stale")
    const stored = (await checkRef(checkId).get()).data()
    expect(stored).toMatchObject({ stale: true, boundMatterId: null })
    expect((await adminDb().collection("matters").where("firmId", "==", firmId).get()).size).toBe(1)
    // The re-screen neither writes a check nor spends the daily limit (nor a matter number).
    expect((await adminDb().collection("conflict_checks").where("firmId", "==", firmId).get()).size).toBe(checksBefore)
    expect(await counters()).toEqual(countersBefore)
    expectKind(await apiErrorOf(open(partner.token, firmId, checkId)), "failed-precondition", "check_stale")
  })

  it("re-screen at open: a hit already on the check (resolved by review) does not make it stale", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const q = await register(partner.token, firmId, { name: "Kamran Akmal" })
    await open(partner.token, firmId, await clearCheck(partner.token, firmId, q.clientId, { name: "Babar Azam" }))
    const p = await register(partner.token, firmId)
    const check = await runCheck({ token: partner.token, data: { firmId, client: { clientId: p.clientId }, opposingParties: [{ name: "Kamran Akmal" }] } } as never)
    expect(check.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    const hitIndex = check.hits.findIndex((h) => h.outcome === "POSSIBLE_CANDIDATE_REVIEW")
    const resolved = await viaApi<Check>("resolveReviewItem")({
      token: partner.token,
      data: { firmId, checkId: check.checkId, hitIndex, resolution: "different_person", note: "Different people: CNIC differs on file." },
    } as never)
    expect(resolved).toMatchObject({ result: "CLEAR", decision: "cleared" })
    expect((await open(partner.token, firmId, check.checkId)).conflictCheckId).toBe(check.checkId)
  })

  it("a missing or over-long title → 400 invalid_query", async () => {
    const { firmId, partner, checkId } = await setup()
    expectKind(await apiErrorOf(open(partner.token, firmId, checkId, { title: "   " })), "invalid-argument", "invalid_query")
    expectKind(await apiErrorOf(open(partner.token, firmId, checkId, { title: "t".repeat(301) })), "invalid-argument", "invalid_query")
  })
})

/**
 * Bugbot PR #8: openMatter's re-screen runs before its transaction, so it is made consistent with
 * the transaction by the firm's registry version (`counters/{firmId}_registry`), which every
 * registry writer bumps in its own transaction. `openMatterTestSeam.afterPreScreen` runs between a
 * round's pre-screen and its transaction, so a concurrent write lands there deterministically.
 */
describe.skipIf(!EMULATORS)("openMatter re-screen vs the registry version", () => {
  const versionRef = (firmId: string) => adminDb().collection("counters").doc(`${firmId}_registry`)
  const version = async (firmId: string) => (await versionRef(firmId).get()).data()?.version ?? 0
  const openRows = async (uid: string) =>
    (await adminDb().collection("audit_log").where("actorId", "==", uid).where("action", "==", "matter.open").get()).docs
      .map((d) => d.data())
      .filter((r) => String(r.target).startsWith("matters/"))

  async function withSeam<T>(hook: (round: number) => Promise<void>, body: () => Promise<T>): Promise<T> {
    openMatterTestSeam.afterPreScreen = hook
    try {
      return await body()
    } finally {
      delete openMatterTestSeam.afterPreScreen
    }
  }

  it("openMatter and closeMatter bump the version once each; advanceStage (stage only, not read by the screen) leaves it", async () => {
    const { firmId, partner, checkId } = await setup()
    const before = await version(firmId)
    const { matterId } = await open(partner.token, firmId, checkId)
    expect(await version(firmId)).toBe(before + 1)
    await advanceStage({ token: partner.token, data: { firmId, matterId, to: "filed" } } as never)
    expect(await version(firmId)).toBe(before + 1)
    await closeMatter({ token: partner.token, data: { firmId, matterId, reason: REASON20 } } as never)
    expect(await version(firmId)).toBe(before + 2)
  })

  it("an unchanged version: the matter opens in one round", async () => {
    const { firmId, partner, checkId } = await setup()
    const rounds: number[] = []
    const out = await withSeam(async (r) => void rounds.push(r), () => open(partner.token, firmId, checkId))
    expect(out.conflictCheckId).toBe(checkId)
    expect(rounds).toEqual([1])
    expect((await openRows(partner.uid)).map((r) => [r.decision, r.reason])).toEqual([["allow", "ok"]])
  })

  it("a registry write between pre-screen and transaction: the round writes nothing, the next round re-screens and opens; one allow row", async () => {
    const { firmId, partner, checkId } = await setup()
    const rounds: number[] = []
    const out = await withSeam(
      async (r) => {
        rounds.push(r)
        if (r === 1) await register(partner.token, firmId, { name: "Unrelated Person" })
      },
      () => open(partner.token, firmId, checkId)
    )
    expect(out.matterNo).toBe(`NHS/${YEAR}/0001`)
    expect(rounds).toEqual([1, 2])
    expect((await openRows(partner.uid)).map((r) => [r.decision, r.reason])).toEqual([["allow", "ok"]])
    expect((await adminDb().collection("matters").where("firmId", "==", firmId).get()).size).toBe(1)
  })

  it(`a version that moves every round → 409 registry_contended after ${OPEN_SCREEN_ROUNDS} rounds; nothing written, one deny row`, async () => {
    const { firmId, partner, checkId } = await setup()
    const rounds: number[] = []
    const err = await withSeam(
      async (r) => {
        rounds.push(r)
        await versionRef(firmId).set({ firmId, version: FieldValue.increment(1) }, { merge: true })
      },
      () => apiErrorOf(open(partner.token, firmId, checkId))
    )
    expectKind(err, "failed-precondition", "registry_contended")
    expect(rounds).toEqual(Array.from({ length: OPEN_SCREEN_ROUNDS }, (_, i) => i + 1))
    expect((await checkRef(checkId).get()).data()).toMatchObject({ boundMatterId: null })
    expect((await checkRef(checkId).get()).data()?.stale).not.toBe(true)
    expect((await adminDb().collection("matters").where("firmId", "==", firmId).get()).size).toBe(0)
    expect((await adminDb().collection("counters").doc(`${firmId}_matter_${YEAR}`).get()).exists).toBe(false)
    expect((await openRows(partner.uid)).map((r) => [r.decision, r.reason])).toEqual([["deny", "registry_contended"]])
  })
})

describe.skipIf(!EMULATORS)("stage flow and closure", () => {
  it("pre_filing → filed ok (stage_advanced row); pre_filing → hearing or a backward move → 409 invalid_stage_transition", async () => {
    const { firmId, partner, checkId } = await setup()
    const associate = await mintIdToken(claims(firmId, "associate"))
    const { matterId } = await open(partner.token, firmId, checkId, { memberUserIds: [associate.uid] })
    expectKind(await apiErrorOf(advanceStage({ token: associate.token, data: { firmId, matterId, to: "hearing" } } as never)), "failed-precondition", "invalid_stage_transition")
    const out = await advanceStage({ token: associate.token, data: { firmId, matterId, to: "filed" } } as never)
    expect(out).toMatchObject({ matterId, stage: "filed" })
    expectKind(await apiErrorOf(advanceStage({ token: associate.token, data: { firmId, matterId, to: "pre_filing" } } as never)), "failed-precondition", "invalid_stage_transition")
    expectKind(await apiErrorOf(advanceStage({ token: associate.token, data: { firmId, matterId, to: "nowhere" } } as never)), "invalid-argument", "invalid_query")
    const events = (await adminDb().collection("matter_events").where("matterId", "==", matterId).get()).docs.map((d) => d.data())
    expect(events.filter((e) => e.kind === "stage_advanced")).toEqual([
      expect.objectContaining({ firmId, from: "pre_filing", to: "filed", actorId: associate.uid, classification: "confidential" }),
    ])
  })

  it("a same-firm non-member advance → 403 not_member; another firm → 404 not_found", async () => {
    const { firmId, partner, checkId } = await setup()
    const { matterId } = await open(partner.token, firmId, checkId)
    const outsider = await mintIdToken(claims(firmId, "associate"))
    expectKind(await apiErrorOf(advanceStage({ token: outsider.token, data: { firmId, matterId, to: "filed" } } as never)), "permission-denied", "not_member")
    const otherFirm = await newFirm()
    const foreign = await mintIdToken(claims(otherFirm, "partner"))
    expectKind(await apiErrorOf(advanceStage({ token: foreign.token, data: { firmId: otherFirm, matterId, to: "filed" } } as never)), "not-found", "not_found")
    expect((await adminDb().collection("matters").doc(matterId).get()).data()?.stage).toBe("pre_filing")
  })

  it("associate close → 403; partner close at filed without a reason → 409 invalid_stage_transition; with a 20-char reason → closed, parties closed", async () => {
    const { firmId, partner, checkId } = await setup()
    const associate = await mintIdToken(claims(firmId, "associate"))
    const { matterId } = await open(partner.token, firmId, checkId, { memberUserIds: [associate.uid] })
    await advanceStage({ token: partner.token, data: { firmId, matterId, to: "filed" } } as never)
    expectKind(await apiErrorOf(closeMatter({ token: associate.token, data: { firmId, matterId, reason: REASON20 } } as never)), "permission-denied", "role_not_permitted")
    expectKind(await apiErrorOf(closeMatter({ token: partner.token, data: { firmId, matterId } } as never)), "failed-precondition", "invalid_stage_transition")
    expectKind(await apiErrorOf(closeMatter({ token: partner.token, data: { firmId, matterId, reason: "too short reason" } } as never)), "failed-precondition", "invalid_stage_transition")
    const out = await closeMatter({ token: partner.token, data: { firmId, matterId, reason: "x".repeat(20) } } as never)
    expect(out).toMatchObject({ matterId, status: "closed", stage: "filed" })
    const parties = (await adminDb().collection("matter_parties").where("matterId", "==", matterId).get()).docs.map((d) => d.data().matterStatus)
    expect(parties).toEqual(["closed", "closed"])
    const events = (await adminDb().collection("matter_events").where("matterId", "==", matterId).get()).docs.map((d) => d.data())
    expect(events.find((e) => e.kind === "closed")).toMatchObject({ firmId, actorId: partner.uid, from: "filed", reason: "x".repeat(20) })
    expectKind(await apiErrorOf(closeMatter({ token: partner.token, data: { firmId, matterId, reason: REASON20 } } as never)), "failed-precondition", "invalid_stage_transition")
    expectKind(await apiErrorOf(advanceStage({ token: partner.token, data: { firmId, matterId, to: "hearing" } } as never)), "failed-precondition", "invalid_stage_transition")
  })

  it("advanceStage emits matter.updated and closeMatter emits matter.closed (D1-2), one row each, in the matter's classification", async () => {
    const { firmId, partner, client, checkId } = await setup()
    const { matterId } = await open(partner.token, firmId, checkId, { courtId: "LHC" })
    await advanceStage({ token: partner.token, data: { firmId, matterId, to: "filed" } } as never)
    await closeMatter({ token: partner.token, data: { firmId, matterId, reason: REASON20 } } as never)
    const rows = (await adminDb().collection("events").where("firmId", "==", firmId).get()).docs
      .map((d) => d.data())
      .filter((e) => e.payload?.matterId === matterId && e.name !== "conflict.decided")
    const payload = { matterId, clientId: client.clientId, courtId: "LHC", caseNumber: null, relevant_law_dates: [] }
    expect(rows.filter((e) => e.name === "matter.updated")).toEqual([
      expect.objectContaining({ firmId, payload, classification: "confidential", idempotencyKey: `${matterId}:stage:filed`, occurredAt: expect.any(Timestamp) }),
    ])
    expect(rows.filter((e) => e.name === "matter.closed")).toEqual([
      expect.objectContaining({ firmId, payload, classification: "confidential", idempotencyKey: `${matterId}:closed`, occurredAt: expect.any(Timestamp) }),
    ])
  })

  it("a decided matter closes without a reason", async () => {
    const { firmId, partner, checkId } = await setup()
    const { matterId } = await open(partner.token, firmId, checkId)
    for (const to of ["filed", "hearing", "reserved", "decided"]) await advanceStage({ token: partner.token, data: { firmId, matterId, to } } as never)
    expect((await closeMatter({ token: partner.token, data: { firmId, matterId } } as never)).status).toBe("closed")
  })

  it("after close, a new check naming that client as the opposing party yields former_client (before: direct_adverse)", async () => {
    const { firmId, partner, checkId } = await setup()
    const { matterId } = await open(partner.token, firmId, checkId)
    const newClient = await register(partner.token, firmId, { name: "Babar Azam" })
    const data = { firmId, client: { clientId: newClient.clientId }, opposingParties: [{ name: "Shahid Afridi" }] }
    const before = await runCheck({ token: partner.token, data } as never)
    expect(before.hits.filter((h) => h.hitRole === "client" && h.subjectIndex === 1).map((h) => h.type)).toEqual(["direct_adverse"])
    await closeMatter({ token: partner.token, data: { firmId, matterId, reason: REASON20 } } as never)
    const after = await runCheck({ token: partner.token, data } as never)
    expect(after.hits.filter((h) => h.hitRole === "client" && h.subjectIndex === 1).map((h) => h.type)).toEqual(["former_client"])
  })
})

describe.skipIf(!EMULATORS)("getMatter and listMatters", () => {
  it("a member reads the matter; a same-firm non-member → 403 not_member; another firm or a missing id → 404 not_found", async () => {
    const { firmId, partner, checkId } = await setup()
    const { matterId, matterNo } = await open(partner.token, firmId, checkId)
    expect(await getMatter({ token: partner.token, data: { firmId, matterId } } as never)).toMatchObject({ matterId, matterNo, title: "Recovery suit" })
    const nonMember = await mintIdToken(claims(firmId, "partner"))
    expectKind(await apiErrorOf(getMatter({ token: nonMember.token, data: { firmId, matterId } } as never)), "permission-denied", "not_member")
    const otherFirm = await newFirm()
    const foreign = await mintIdToken(claims(otherFirm, "partner"))
    const crossFirm = await apiErrorOf(getMatter({ token: foreign.token, data: { firmId: otherFirm, matterId } } as never))
    expectKind(crossFirm, "not-found", "not_found")
    expectKind(await apiErrorOf(getMatter({ token: partner.token, data: { firmId, matterId: "no-such-matter" } } as never)), "not-found", "not_found")
  })

  it("a member below the matter's classification → 403 clearance", async () => {
    const { firmId, partner, checkId } = await setup()
    const low = await mintIdToken(claims(firmId, "associate", "internal"))
    const { matterId } = await open(partner.token, firmId, checkId, { memberUserIds: [low.uid] })
    expectKind(await apiErrorOf(getMatter({ token: low.token, data: { firmId, matterId } } as never)), "permission-denied", "clearance")
  })

  it("listMatters returns only the caller's member matters, most recent first, cursor-paginated", async () => {
    const { firmId, partner, client } = await setup()
    const associate = await mintIdToken(claims(firmId, "associate"))
    const ids: string[] = []
    for (const name of ["Opp Alpha", "Opp Bravo", "Opp Charlie"]) {
      const checkId = await clearCheck(partner.token, firmId, client.clientId, { name })
      ids.push((await open(partner.token, firmId, checkId, { memberUserIds: [associate.uid] })).matterId)
    }
    const solo = await clearCheck(partner.token, firmId, client.clientId, { name: "Opp Delta" })
    const partnerOnly = (await open(partner.token, firmId, solo)).matterId

    const page1 = await listMatters({ token: associate.token, data: { firmId, limit: "2" } } as never)
    expect(page1.items.map((m) => m.matterId)).toEqual([ids[2], ids[1]])
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await listMatters({ token: associate.token, data: { firmId, limit: "2", cursor: page1.nextCursor } } as never)
    expect(page2.items.map((m) => m.matterId)).toEqual([ids[0]])
    expect(page2.nextCursor).toBeNull()

    const all = await listMatters({ token: partner.token, data: { firmId } } as never)
    expect(all.items.map((m) => m.matterId)).toEqual([partnerOnly, ids[2], ids[1], ids[0]])
    const outsider = await mintIdToken(claims(firmId, "partner"))
    expect(await listMatters({ token: outsider.token, data: { firmId } } as never)).toEqual({ items: [], nextCursor: null })
    const clientUser = await mintIdToken(claims(firmId, "client", "internal"))
    expectKind(await apiErrorOf(listMatters({ token: clientUser.token, data: { firmId } } as never)), "permission-denied", "client_denied")
  })

  it("a cursor whose seconds are outside the Timestamp range → 400 invalid_cursor, not 500 (as listClients)", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const cursor = Buffer.from(JSON.stringify({ sortKey: "99999999999999.0", id: "abc" }), "utf8").toString("base64url")
    expectKind(await apiErrorOf(listMatters({ token: partner.token, data: { firmId, cursor } } as never)), "invalid-argument", "invalid_cursor")
  })
})
