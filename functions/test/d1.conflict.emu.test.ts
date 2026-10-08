import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { FieldValue, Timestamp } from "firebase-admin/firestore"
import { adminDb } from "../src/admin"
import { discloseFor, type StoredCheck } from "../src/d1/conflict/disclosure"
import { secondsToKarachiMidnight } from "../src/d1/dailyLimit"
import { checkClassification, unseenHits } from "../src/d1/conflict/engine"
import { RateLimitedError } from "../src/http/errors"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { apiErrorOf, expectKind, viaApi } from "./api"

/**
 * Module 6 conflict check (spec P2-3..P2-6, P2-13, P2-15, P2-17..P2-20). Matters and
 * matter_parties are seeded with the Admin SDK in the plan's data shape (ledger ruling R1:
 * openMatter arrives in Task 9). Test text that names the rule writes PBC Rule 85 [REQUIRES VERIFICATION].
 */

type Hit = Record<string, unknown> & { outcome: string; type: string; identityBasis: string; matterNo: unknown; matterId: unknown }
type CheckResponse = {
  checkId: string
  result: string
  identityBasis: string
  decision: string
  hitCount: number
  hits: Hit[]
}

const runCheck = viaApi<CheckResponse>("runConflictCheck")
const getResult = viaApi<CheckResponse>("getConflictResult")
const resolveReviewItem = viaApi<CheckResponse>("resolveReviewItem")
const registerClient = viaApi<{ clientId: string; entityId: string }>("registerClient")

const claims = (firmId: string, role: string, clearanceLevel = "privileged-restricted") => ({ firmId, role, clearanceLevel })
const DAY_MS = 24 * 60 * 60 * 1000
const CNIC_X = "4210112345671"

async function newFirm(extra: Record<string, unknown> = {}): Promise<string> {
  const firmId = uniq("firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS", ...extra })
  return firmId
}

let mobileSeq = 0
const nextMobile = () => `0300${String(2000000 + ++mobileSeq)}`

/** A client registered through the real route (entity + candidate links on shared keys). */
async function register(token: string, firmId: string, extra: Record<string, unknown> = {}) {
  return registerClient({
    token,
    data: { firmId, name: "Muhammad Ali", type: "individual", primaryMobile: nextMobile(), classification: "internal", ...extra },
  } as never)
}

/** A matter (Task 9 shape) for `clientId`, with optional members. */
async function seedMatter(
  firmId: string,
  clientId: string,
  opts: { matterNo?: string; status?: string; classification?: string; members?: string[]; title?: string } = {}
): Promise<string> {
  const ref = adminDb().collection("matters").doc()
  await ref.set({
    firmId,
    clientId,
    matterNo: opts.matterNo ?? "NHS/2026/0001",
    title: opts.title ?? "Secret Title Of The Matter",
    stage: "pre_filing",
    status: opts.status ?? "live",
    conflictCheckId: "seeded",
    classification: opts.classification ?? "confidential",
    createdAt: Timestamp.now(),
  })
  for (const uid of opts.members ?? []) {
    await adminDb().collection("matter_members").doc(`${ref.id}_${uid}`).set({ firmId, matterId: ref.id, userId: uid })
  }
  return ref.id
}

async function ageLinks(firmId: string, days: number, patch: Record<string, unknown> = {}) {
  const links = await adminDb().collection("entity_links").where("firmId", "==", firmId).get()
  for (const d of links.docs) await d.ref.update({ createdAt: Timestamp.fromMillis(Date.now() - days * DAY_MS), ...patch })
  return links.docs.map((d) => d.id)
}

const opposing = (name: string, keys?: Record<string, string>) => ({ name, ...(keys ? { keys } : {}) })

describe("discloseFor (no emulator needed)", () => {
  const check: StoredCheck = {
    checkId: "c1",
    firmId: "f",
    requestedBy: "u1",
    subjects: [{ role: "opposing", name: "X", keys: {} }],
    hits: [
      {
        subjectIndex: 0, hitRole: "client", type: "direct_adverse", basis: "name", score: 1, identityBasis: "candidate_only",
        outcome: "POSSIBLE_CANDIDATE_REVIEW", matchedName: "X", matterId: "m1", matterNo: "NHS/2026/0001",
        matterClassification: "confidential", reliedOnLinkIds: [],
      },
      {
        subjectIndex: 0, hitRole: "client", type: "direct_adverse", basis: "name", score: 1, identityBasis: "candidate_only",
        outcome: "POSSIBLE_CANDIDATE_REVIEW", matchedName: "X", matterId: "m2", matterNo: "NHS/2026/0002",
        matterClassification: "privileged", reliedOnLinkIds: [],
      },
    ],
    result: "POSSIBLE_CANDIDATE_REVIEW",
    identityBasis: "candidate_only",
    classification: "privileged",
    decision: "pending",
    boundMatterId: null,
    stale: false,
  }
  it("a non-partner sees matter details only for matters they are a member of", () => {
    const out = discloseFor({ role: "associate", clearanceLevel: "privileged-restricted" }, check, new Set(["m2"]))
    expect(out.hits.map((h) => [h.matterId, h.matterNo])).toEqual([["restricted", "restricted"], ["m2", "NHS/2026/0002"]])
    expect(out.hitCount).toBe(2)
  })
  it("a non-member's matter classification is restricted too; a member below the matter's classification is restricted", () => {
    const out = discloseFor({ role: "associate", clearanceLevel: "confidential" }, check, new Set(["m1", "m2"]))
    expect(out.hits.map((h) => h.matterNo)).toEqual(["NHS/2026/0001", "restricted"])
    expect(out.hits[1].matterClassification).toBe("restricted")
  })
  it("a partner sees every hit within their clearance, restricted above it", () => {
    const out = discloseFor({ role: "partner", clearanceLevel: "confidential" }, check, new Set())
    expect(out.hits.map((h) => h.matterNo)).toEqual(["NHS/2026/0001", "restricted"])
    const full = discloseFor({ role: "partner", clearanceLevel: "privileged-restricted" }, check, new Set())
    expect(full.hits.map((h) => h.matterNo)).toEqual(["NHS/2026/0001", "NHS/2026/0002"])
  })
  it("never names a rule number", () => {
    expect(JSON.stringify(discloseFor({ role: "partner", clearanceLevel: "privileged" }, check, new Set()))).not.toMatch(/Rule\s*\d/i)
  })
  it("a hit with no matter masks its classification when the reader is cleared below it (final review M2)", () => {
    const noMatter: StoredCheck = {
      ...check,
      hits: [{ ...check.hits[0], matterId: null, matterNo: null, matterClassification: "privileged" }],
    }
    const low = discloseFor({ role: "associate", clearanceLevel: "confidential" }, noMatter, new Set())
    expect(low.hits[0]).toMatchObject({ matterId: null, matterNo: null, matterClassification: "restricted" })
    const high = discloseFor({ role: "associate", clearanceLevel: "privileged" }, noMatter, new Set())
    expect(high.hits[0]).toMatchObject({ matterId: null, matterNo: null, matterClassification: "privileged" })
  })
  it("never discloses a hit's internal candidate id", () => {
    const withId: StoredCheck = { ...check, hits: check.hits.map((h) => ({ ...h, candidateId: "client:secret-client-id" })) }
    const out = discloseFor({ role: "partner", clearanceLevel: "privileged-restricted" }, withId, new Set())
    expect(JSON.stringify(out)).not.toContain("secret-client-id")
  })
  it("includes the waiver for a reader cleared for the check, never for one below it (final review M3)", () => {
    const waiver = { partnerId: "p1", note: "n".repeat(60), clientConsent: true as const, consentReference: "REF-1", at: "2026-10-07T00:00:00.000Z" }
    const waived: StoredCheck = { ...check, result: "FLAG", decision: "cleared", waiver }
    expect(discloseFor({ role: "partner", clearanceLevel: "privileged" }, waived, new Set()).waiver).toEqual(waiver)
    expect(discloseFor({ role: "partner", clearanceLevel: "confidential" }, waived, new Set())).not.toHaveProperty("waiver")
    expect(discloseFor({ role: "partner", clearanceLevel: "privileged" }, check, new Set()).waiver).toBeNull()
  })
})

describe("checkClassification (no emulator needed)", () => {
  it("the check's label covers every stored hit, NONE included, because stored hits keep matter ids readable by partners cleared to the check's label", () => {
    const hit = (over: Partial<StoredCheck["hits"][number]>): StoredCheck["hits"][number] => ({
      subjectIndex: 1, hitRole: "client", type: "direct_adverse", basis: "name", score: 1, identityBasis: "candidate_only",
      outcome: "POSSIBLE_CANDIDATE_REVIEW", matchedName: "X", matterId: "m1", matterNo: "N", matterClassification: "internal",
      reliedOnLinkIds: [], candidateId: "client:c1", ...over,
    })
    expect(checkClassification([hit({ outcome: "NONE", matterClassification: "privileged-restricted" }), hit({})])).toBe("privileged-restricted")
  })
})

describe("unseenHits: the re-screen comparison at open (no emulator needed)", () => {
  const h = (over: Partial<StoredCheck["hits"][number]>): StoredCheck["hits"][number] => ({
    subjectIndex: 1, hitRole: "client", type: "direct_adverse", basis: "name", score: 1, identityBasis: "candidate_only",
    outcome: "POSSIBLE_CANDIDATE_REVIEW", matchedName: "X", matterId: "m1", matterNo: "N", matterClassification: "confidential",
    reliedOnLinkIds: [], candidateId: "client:c1", ...over,
  })
  it("a fresh non-NONE hit on a new candidate, subject or type is unseen; NONE fresh hits never are", () => {
    expect(unseenHits([h({})], [h({})])).toEqual([])
    expect(unseenHits([h({ candidateId: "client:c2" })], [h({})])).toHaveLength(1)
    expect(unseenHits([h({ subjectIndex: 2 })], [h({})])).toHaveLength(1)
    expect(unseenHits([h({ type: "former_client" })], [h({ type: "direct_adverse" })])).toHaveLength(1)
    expect(unseenHits([h({ outcome: "NONE" })], [])).toEqual([])
  })
  it("a stored hit resolved by review counts as seen; an unreviewed stored NONE does not; a stored hit without an id matches nothing", () => {
    const review = { resolution: "different_person" as const, by: "u", note: "n", at: "t" }
    expect(unseenHits([h({})], [h({ outcome: "NONE", review })])).toEqual([])
    expect(unseenHits([h({})], [h({ outcome: "NONE" })])).toHaveLength(1)
    expect(unseenHits([h({})], [h({ candidateId: undefined })])).toHaveLength(1)
  })
  it("a fresh FLAG on the same candidate is unseen when the stored hit was review or resolved NONE", () => {
    const review = { resolution: "different_person" as const, by: "u", note: "n", at: "t" }
    expect(unseenHits([h({ outcome: "FLAG" })], [h({ outcome: "POSSIBLE_CANDIDATE_REVIEW" })])).toHaveLength(1)
    expect(unseenHits([h({ outcome: "FLAG" })], [h({ outcome: "NONE", review })])).toHaveLength(1)
    expect(unseenHits([h({ outcome: "FLAG" })], [h({ outcome: "FLAG" })])).toEqual([])
  })
})

describe("secondsToKarachiMidnight (no emulator needed)", () => {
  it("counts whole seconds to 19:00 UTC, at least 1", () => {
    expect(secondsToKarachiMidnight(new Date("2026-10-07T18:00:00Z"))).toBe(3600)
    expect(secondsToKarachiMidnight(new Date("2026-10-07T18:59:59.500Z"))).toBe(1)
    expect(secondsToKarachiMidnight(new Date("2026-10-07T19:00:00Z"))).toBe(24 * 3600)
    expect(secondsToKarachiMidnight(new Date("2026-10-07T00:00:00Z"))).toBe(19 * 3600)
  })
  it("RateLimitedError keeps rate_limited as its default code and takes daily_limit", () => {
    expect(new RateLimitedError(5).code).toBe("rate_limited")
    const err = new RateLimitedError(7, "daily_limit")
    expect([err.status, err.code, err.retryAfter]).toEqual([429, "daily_limit", 7])
  })
})

describe.skipIf(!EMULATORS)("runConflictCheck", () => {
  it("no registry data → CLEAR, decision cleared; check, decided trail row, conflict.decided event and one allow audit row", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const out = await runCheck({ token: partner.token, data: { firmId, client: { name: "Zainab Bibi" }, opposingParties: [opposing("Kamran Akmal")] } } as never)
    expect(out).toMatchObject({ result: "CLEAR", decision: "cleared", identityBasis: "confirmed_identity", hitCount: 0, hits: [] })

    const check = (await adminDb().collection("conflict_checks").doc(out.checkId).get()).data()
    expect(check).toMatchObject({
      firmId,
      requestedBy: partner.uid,
      result: "CLEAR",
      decision: "cleared",
      classification: "confidential",
      boundMatterId: null,
      stale: false,
      subjects: [
        { role: "client", name: "Zainab Bibi", keys: {} },
        { role: "opposing", name: "Kamran Akmal", keys: {} },
      ],
    })
    expect(check?.createdAt).toBeInstanceOf(Timestamp)

    const trail = await adminDb().collection("conflict_events").where("checkId", "==", out.checkId).get()
    expect(trail.docs.map((d) => d.data())).toEqual([
      expect.objectContaining({ firmId, checkId: out.checkId, kind: "decided", actorId: partner.uid, classification: "confidential" }),
    ])
    const events = await adminDb().collection("events").where("firmId", "==", firmId).get()
    expect(events.docs.map((d) => d.data())).toEqual([
      expect.objectContaining({
        name: "conflict.decided",
        firmId,
        payload: { checkId: out.checkId, result: "CLEAR", identityBasis: "confirmed_identity" },
        classification: "confidential",
        idempotencyKey: `${out.checkId}:decided`,
      }),
    ])
    expect(events.docs[0].data().occurredAt).toBeInstanceOf(Timestamp)

    const rows = await adminDb().collection("audit_log").where("actorId", "==", partner.uid).where("action", "==", "conflict.run").get()
    const opRows = rows.docs.map((d) => d.data()).filter((r) => r.target === `conflict_checks/${out.checkId}`)
    expect(opRows.map((r) => r.decision)).toEqual(["allow"])
  })

  it("opposing party named by name+keys has no entity: an exact-CNIC match to a client, even with an old confirmed link between OTHER entities, is POSSIBLE_CANDIDATE_REVIEW candidate_only; a reviewer's same_person makes it FLAG confirmed_identity", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const a = await register(partner.token, firmId, { cnic: CNIC_X })
    await register(partner.token, firmId, { name: "Muhammad Ali Khan", cnic: CNIC_X })
    await seedMatter(firmId, a.clientId)
    await ageLinks(firmId, 31)

    const out = await runCheck({
      token: partner.token,
      data: { firmId, client: { name: "Bashir Ahmed" }, opposingParties: [opposing("M. Ali", { cnic: "42101-1234567-1" })] },
    } as never)
    expect(out.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    expect(out.identityBasis).toBe("candidate_only")
    const direct = out.hits.find((h) => h.type === "direct_adverse")
    expect(direct).toMatchObject({ outcome: "POSSIBLE_CANDIDATE_REVIEW", identityBasis: "candidate_only", basis: "key", matterNo: "NHS/2026/0001", reliedOnLinkIds: [] })
    const stored = (await adminDb().collection("conflict_checks").doc(out.checkId).get()).data()
    expect(stored?.decision).toBe("pending")

    const hitIndex = out.hits.findIndex((h) => h.type === "direct_adverse")
    const resolved = await resolveReviewItem({
      token: partner.token,
      data: { firmId, checkId: out.checkId, hitIndex, resolution: "same_person", note: "Same CNIC, same person: confirmed on the file." },
    } as never)
    expect(resolved.hits[hitIndex]).toMatchObject({ outcome: "FLAG", identityBasis: "confirmed_identity" })
    expect(resolved.result).toBe("FLAG")
  })

  it("the same with the link 2 days old → POSSIBLE_CANDIDATE_REVIEW candidate_only", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const a = await register(partner.token, firmId, { cnic: CNIC_X })
    await register(partner.token, firmId, { name: "Muhammad Ali Khan", cnic: CNIC_X })
    await seedMatter(firmId, a.clientId)
    await ageLinks(firmId, 2)
    const out = await runCheck({
      token: partner.token,
      data: { firmId, client: { name: "Bashir Ahmed" }, opposingParties: [opposing("M. Ali", { cnic: CNIC_X })] },
    } as never)
    expect(out.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    expect(out.identityBasis).toBe("candidate_only")
    expect(out.hits.every((h) => h.outcome !== "FLAG")).toBe(true)
  })

  it("a client subject (has an entity): a disputed 31-day-old link to the matched client is not relied on; a human-confirmed 1-day-old link is", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const a = await register(partner.token, firmId, { cnic: CNIC_X })
    const b = await register(partner.token, firmId, { name: "Muhammad Ali Khan", cnic: CNIC_X })
    await seedMatter(firmId, b.clientId)
    const data = { firmId, client: { clientId: a.clientId }, opposingParties: [opposing("Zzz Qqq")] }
    const keyHit = (o: CheckResponse) => o.hits.find((h) => h.basis === "key" && h.matterNo === "NHS/2026/0001")!
    const linkIds = await ageLinks(firmId, 31, { disputed: true })
    expect(linkIds).toHaveLength(1)
    const disputed = keyHit(await runCheck({ token: partner.token, data } as never))
    expect(disputed).toMatchObject({ identityBasis: "candidate_only", reliedOnLinkIds: linkIds })
    await ageLinks(firmId, 1, { state: "confirmed", disputed: false })
    const confirmed = keyHit(await runCheck({ token: partner.token, data } as never))
    expect(confirmed).toMatchObject({ identityBasis: "confirmed_identity", reliedOnLinkIds: linkIds })
  })

  it("only the link on the matched key counts: for a client subject, a confirmed phone link does not confirm a CNIC match", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const a = await register(partner.token, firmId, { cnic: CNIC_X, primaryMobile: "0300 5555555" })
    const b = await register(partner.token, firmId, { name: "Muhammad Ali Khan", cnic: CNIC_X, primaryMobile: "0300 5555555" })
    await seedMatter(firmId, b.clientId)
    const links = await adminDb().collection("entity_links").where("firmId", "==", firmId).get()
    expect(links.docs.map((d) => d.data().key).sort()).toEqual(["cnic", "phone"])
    for (const d of links.docs) {
      await d.ref.update({ createdAt: Timestamp.fromMillis(Date.now() - (d.data().key === "phone" ? 31 : 2) * DAY_MS) })
    }
    // Same two entities, one match key at a time: the subject client's stored keys decide which key matches.
    const phoneLink = links.docs.find((d) => d.data().key === "phone")!.id
    const cnicLink = links.docs.find((d) => d.data().key === "cnic")!.id
    const matchOn = async (keep: "cnic" | "primaryMobile") => {
      const drop = keep === "cnic" ? "primaryMobile" : "cnic"
      const ref = adminDb().collection("clients").doc(a.clientId)
      const original = (await ref.get()).data()?.[drop]
      await ref.update({ [drop]: FieldValue.delete() })
      const out = await runCheck({ token: partner.token, data: { firmId, client: { clientId: a.clientId }, opposingParties: [opposing("Zzz Qqq")] } } as never)
      await ref.update({ [drop]: original })
      return out.hits.find((h) => h.basis === "key" && h.matterNo === "NHS/2026/0001")!
    }
    // CNIC matches: only the 2-day-old CNIC link counts; the 31-day-old (confirmed) phone link is not on the matched key.
    expect(await matchOn("cnic")).toMatchObject({ identityBasis: "candidate_only", reliedOnLinkIds: [cnicLink] })
    // Phone matches: the phone link is the only one relied on (the identity stays a candidate while the CNIC link between the pair is unresolved).
    expect(await matchOn("primaryMobile")).toMatchObject({ reliedOnLinkIds: [phoneLink] })
  })

  describe("linked path (spec P2-41): subject client A by clientId, candidate an opposing matter_parties row carrying entity B", () => {
    /** Clients A and B share CNIC_X (one candidate cnic link); an opposing party row on a seeded matter carries entity B. */
    async function linkedPair(partyKeys: Record<string, string>, extraA: Record<string, unknown> = {}, extraB: Record<string, unknown> = {}) {
      const firmId = await newFirm()
      const partner = await mintIdToken(claims(firmId, "partner"))
      const a = await register(partner.token, firmId, { cnic: CNIC_X, ...extraA })
      const b = await register(partner.token, firmId, { name: "Muhammad Ali Khan", cnic: CNIC_X, ...extraB })
      const matterId = await seedMatter(firmId, "someone-else", { matterNo: "NHS/2026/0009" })
      await adminDb().collection("matter_parties").add({
        firmId, matterId, role: "opposing", name: "Zarnab Traders", names: ["zarnab traders"], keys: partyKeys, entityId: b.entityId,
        matterClassification: "confidential", matterStatus: "live", classification: "confidential",
      })
      const named = async () => {
        const out = await runCheck({ token: partner.token, data: { firmId, client: { clientId: a.clientId }, opposingParties: [opposing("Zzz Qqq")] } } as never)
        return { out, party: out.hits.find((h) => h.hitRole === "opposing" && h.matterNo === "NHS/2026/0009")! }
      }
      // The original cases' subject: an unnamed opposing party with the shared CNIC (no entity, so no link counts).
      const unnamed = () =>
        runCheck({ token: partner.token, data: { firmId, client: { name: "Bashir Ahmed" }, opposingParties: [opposing("M. Ali", { cnic: CNIC_X })] } } as never)
      return { firmId, a, b, named, unnamed }
    }

    it("(a) a 31-day-old undisputed CNIC link → FLAG adverse_history confirmed_identity relying on it; 2 days old → POSSIBLE_CANDIDATE_REVIEW; the unnamed subject stays review", async () => {
      const p = await linkedPair({ cnic: CNIC_X })
      const linkIds = await ageLinks(p.firmId, 31)
      expect(linkIds).toHaveLength(1)
      const old = await p.named()
      expect(old.out.result).toBe("FLAG")
      expect(old.party).toMatchObject({ type: "adverse_history", basis: "key", outcome: "FLAG", identityBasis: "confirmed_identity", reliedOnLinkIds: linkIds })
      expect((await p.unnamed()).result).toBe("POSSIBLE_CANDIDATE_REVIEW")

      await ageLinks(p.firmId, 2)
      const young = await p.named()
      expect(young.out.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
      expect(young.party).toMatchObject({ type: "adverse_history", outcome: "POSSIBLE_CANDIDATE_REVIEW", identityBasis: "candidate_only", reliedOnLinkIds: linkIds })
      expect((await p.unnamed()).result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    })

    it("(b) a disputed 31-day-old link → POSSIBLE_CANDIDATE_REVIEW; a human-confirmed 1-day-old link → FLAG; the unnamed subject stays review", async () => {
      const p = await linkedPair({ cnic: CNIC_X })
      const linkIds = await ageLinks(p.firmId, 31, { disputed: true })
      const disputed = await p.named()
      expect(disputed.out.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
      expect(disputed.party).toMatchObject({ outcome: "POSSIBLE_CANDIDATE_REVIEW", identityBasis: "candidate_only", reliedOnLinkIds: linkIds })
      expect((await p.unnamed()).result).toBe("POSSIBLE_CANDIDATE_REVIEW")

      await ageLinks(p.firmId, 1, { state: "confirmed" })
      const confirmed = await p.named()
      expect(confirmed.out.result).toBe("FLAG")
      expect(confirmed.party).toMatchObject({ type: "adverse_history", outcome: "FLAG", identityBasis: "confirmed_identity", reliedOnLinkIds: linkIds })
      expect((await p.unnamed()).result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    })

    it("(c) only the matched key's link counts: phone link 31 d, CNIC link 2 d; party keys { phone } → FLAG on the phone link, { cnic } → POSSIBLE_CANDIDATE_REVIEW", async () => {
      const phoneOnly = await linkedPair({ phone: "+923005555555" }, { primaryMobile: "0300 5555555" }, { primaryMobile: "0300 5555555" })
      const age = async (firmId: string) => {
        const links = await adminDb().collection("entity_links").where("firmId", "==", firmId).get()
        expect(links.docs.map((d) => d.data().key).sort()).toEqual(["cnic", "phone"])
        for (const d of links.docs) await d.ref.update({ createdAt: Timestamp.fromMillis(Date.now() - (d.data().key === "phone" ? 31 : 2) * DAY_MS) })
        return { phone: links.docs.find((d) => d.data().key === "phone")!.id, cnic: links.docs.find((d) => d.data().key === "cnic")!.id }
      }
      const ids = await age(phoneOnly.firmId)
      expect((await phoneOnly.named()).party).toMatchObject({ outcome: "FLAG", identityBasis: "confirmed_identity", reliedOnLinkIds: [ids.phone] })
      expect((await phoneOnly.unnamed()).result).toBe("POSSIBLE_CANDIDATE_REVIEW")

      const cnicOnly = await linkedPair({ cnic: CNIC_X }, { primaryMobile: "0300 5555555" }, { primaryMobile: "0300 5555555" })
      const ids2 = await age(cnicOnly.firmId)
      const cnicHit = await cnicOnly.named()
      expect(cnicHit.out.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
      expect(cnicHit.party).toMatchObject({ outcome: "POSSIBLE_CANDIDATE_REVIEW", identityBasis: "candidate_only", reliedOnLinkIds: [ids2.cnic] })
      expect((await cnicOnly.unnamed()).result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    })
  })

  it("a client subject named by clientId whose own entity sits on an earlier matter as the opposing party → FLAG adverse_history", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const a = await register(partner.token, firmId, { name: "Shahid Afridi" })
    const matterId = await seedMatter(firmId, "someone-else", { matterNo: "NHS/2026/0009" })
    await adminDb().collection("matter_parties").add({
      firmId, matterId, role: "opposing", name: "S. Afridi Trading", names: ["s afridi trading"], keys: {}, entityId: a.entityId,
      matterClassification: "confidential", matterStatus: "live", classification: "confidential",
    })
    const out = await runCheck({ token: partner.token, data: { firmId, client: { clientId: a.clientId }, opposingParties: [opposing("Kamran Akmal")] } } as never)
    expect(out.result).toBe("FLAG")
    expect(out.hits.find((h) => h.hitRole === "opposing")).toMatchObject({ type: "adverse_history", basis: "key", identityBasis: "confirmed_identity", matterNo: "NHS/2026/0009" })
  })

  it("with L17_2_ENABLED off for the firm, a confirmed key link still yields only POSSIBLE_CANDIDATE_REVIEW (P2-18)", async () => {
    const firmId = await newFirm({ featureFlags: { L17_2_ENABLED: false } })
    const partner = await mintIdToken(claims(firmId, "partner"))
    const a = await register(partner.token, firmId, { cnic: CNIC_X })
    await register(partner.token, firmId, { name: "Muhammad Ali Khan", cnic: CNIC_X })
    await seedMatter(firmId, a.clientId)
    await ageLinks(firmId, 31, { state: "confirmed" })
    const out = await runCheck({
      token: partner.token,
      data: { firmId, client: { name: "Bashir Ahmed" }, opposingParties: [opposing("M. Ali", { cnic: CNIC_X })] },
    } as never)
    expect(out.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
  })

  it("an opposing key match with no link row is still a key hit, reviewed as a candidate identity", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const a = await register(partner.token, firmId, { name: "Shahid Afridi", cnic: CNIC_X })
    await seedMatter(firmId, a.clientId)
    const out = await runCheck({
      token: partner.token,
      data: { firmId, client: { name: "Bashir Ahmed" }, opposingParties: [opposing("Totally Different", { cnic: CNIC_X })] },
    } as never)
    expect(out.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    expect(out.hits[0]).toMatchObject({ basis: "key", type: "direct_adverse", outcome: "POSSIBLE_CANDIDATE_REVIEW" })
  })

  it("forensic test 3: two 'Muhammad Ali' clients, same CNIC, different phones; a check naming one → POSSIBLE_CANDIDATE_REVIEW, never CLEAR", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const one = await register(partner.token, firmId, { cnic: "42101-1234567-1", primaryMobile: "0300 1111111" })
    await register(partner.token, firmId, { cnic: "4210112345671", primaryMobile: "0300 2222222" })
    const links = await adminDb().collection("entity_links").where("firmId", "==", firmId).get()
    expect(links.docs.map((d) => d.data().state)).toEqual(["candidate"])

    const asClient = await runCheck({
      token: partner.token,
      data: { firmId, client: { clientId: one.clientId }, opposingParties: [opposing("Kamran Akmal")] },
    } as never)
    expect(asClient.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    expect(asClient.identityBasis).toBe("candidate_only")
    const review = asClient.hits.filter((h) => h.outcome === "POSSIBLE_CANDIDATE_REVIEW")
    expect(review.length).toBeGreaterThan(0)
    for (const h of review) expect(h).toMatchObject({ identityBasis: "candidate_only", unresolvedLinkIds: [links.docs[0].id] })

    const stored = (await adminDb().collection("conflict_checks").doc(asClient.checkId).get()).data()
    expect(stored?.subjects[0]).toEqual({ role: "client", name: "Muhammad Ali", keys: { cnic: CNIC_X, phone: "+923001111111" }, clientId: one.clientId })
    expect(stored?.hits.some((h: { unresolvedLinkIds?: string[] }) => h.unresolvedLinkIds?.includes(links.docs[0].id))).toBe(true)

    const asOpposing = await runCheck({
      token: partner.token,
      data: { firmId, client: { name: "Bashir Ahmed" }, opposingParties: [opposing("Muhammad Ali")] },
    } as never)
    expect(asOpposing.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    expect(asOpposing.identityBasis).toBe("candidate_only")
  })

  it("Urdu-script opposing party محمد علی against client 'Muhammad Ali' → POSSIBLE_CANDIDATE_REVIEW (Review Focus 1)", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const a = await register(partner.token, firmId)
    await seedMatter(firmId, a.clientId)
    const out = await runCheck({
      token: partner.token,
      data: { firmId, client: { name: "Bashir Ahmed" }, opposingParties: [opposing("محمد علی")] },
    } as never)
    expect(out.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    expect(out.hits).toEqual([expect.objectContaining({ basis: "name", type: "direct_adverse", matchedName: "Muhammad Ali" })])
  })

  it("a firm transliteration_map row lets an unseeded Urdu word hit its Roman spelling", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    await register(partner.token, firmId, { name: "Qzwx Rtyp" })
    await adminDb().collection("transliteration_map").add({ firmId, script: "قزوکس", roman: ["qzwx"], classification: "internal" })
    await adminDb().collection("transliteration_map").add({ firmId, script: "رتیپ", roman: ["rtyp"], classification: "internal" })
    const out = await runCheck({
      token: partner.token,
      data: { firmId, client: { name: "Bashir Ahmed" }, opposingParties: [opposing("قزوکس رتیپ")] },
    } as never)
    expect(out.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    expect(out.hits[0]).toMatchObject({ matchedName: "Qzwx Rtyp", score: 1 })
  })

  it("a prospective client hitting an opposing matter_parties row → adverse_history; client-role party rows are not candidates", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const matterId = await seedMatter(firmId, "some-client", { matterNo: "NHS/2026/0007" })
    const party = (role: string, name: string) => ({
      firmId, matterId, role, name, names: [name.toLowerCase()], keys: {}, matterClassification: "confidential", matterStatus: "live", classification: "confidential",
    })
    await adminDb().collection("matter_parties").add(party("opposing", "Kamran Akmal"))
    await adminDb().collection("matter_parties").add(party("client", "Imran Nazir"))
    const out = await runCheck({
      token: partner.token,
      data: { firmId, client: { name: "Kamran Akmal" }, opposingParties: [opposing("Imran Nazir")] },
    } as never)
    expect(out.hits).toEqual([expect.objectContaining({ subjectIndex: 0, hitRole: "opposing", type: "adverse_history", matterNo: "NHS/2026/0007" })])
    expect(out.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
  })

  it("an opposing hit on a client whose matters are all closed is former_client", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const a = await register(partner.token, firmId)
    await seedMatter(firmId, a.clientId, { status: "closed" })
    const out = await runCheck({ token: partner.token, data: { firmId, client: { name: "Bashir Ahmed" }, opposingParties: [opposing("Muhammad Ali")] } } as never)
    expect(out.hits.map((h) => h.type)).toEqual(["former_client"])
  })

  it("a non-member associate sees matterNo 'restricted' and no title; a partner sees NHS/2026/0001 (Review Focus 4)", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const associate = await mintIdToken(claims(firmId, "associate", "privileged-restricted"))
    const member = await mintIdToken(claims(firmId, "associate", "privileged-restricted"))
    const a = await register(partner.token, firmId)
    const matterId = await seedMatter(firmId, a.clientId, { members: [member.uid] })

    const data = { firmId, client: { name: "Bashir Ahmed" }, opposingParties: [opposing("Muhammad Ali")] }
    const mine = await runCheck({ token: associate.token, data } as never)
    expect(mine.hits).toHaveLength(1)
    expect(mine.hits[0]).toMatchObject({ matterNo: "restricted", matterId: "restricted", type: "direct_adverse" })
    const text = JSON.stringify(mine)
    expect(text).not.toContain("NHS/2026/0001")
    expect(text).not.toContain(matterId)
    expect(text).not.toContain("Secret Title")

    const again = await getResult({ token: associate.token, data: { firmId, checkId: mine.checkId } } as never)
    expect(again.hits[0]).toMatchObject({ matterNo: "restricted" })
    expect(JSON.stringify(again)).not.toContain(matterId)

    const asPartner = await getResult({ token: partner.token, data: { firmId, checkId: mine.checkId } } as never)
    expect(asPartner.hits[0]).toMatchObject({ matterNo: "NHS/2026/0001", matterId })

    const own = await runCheck({ token: member.token, data } as never)
    expect(own.hits[0]).toMatchObject({ matterNo: "NHS/2026/0001", matterId })
  })

  it("the check's classification is the highest hit matter classification, at least confidential (P2-13)", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const a = await register(partner.token, firmId)
    await seedMatter(firmId, a.clientId, { classification: "privileged" })
    const out = await runCheck({ token: partner.token, data: { firmId, client: { name: "Bashir Ahmed" }, opposingParties: [opposing("Muhammad Ali")] } } as never)
    const stored = (await adminDb().collection("conflict_checks").doc(out.checkId).get()).data()
    expect(stored?.classification).toBe("privileged")
    const events = await adminDb().collection("events").where("payload.checkId", "==", out.checkId).get()
    expect(events.docs[0].data().classification).toBe("privileged")
  })

  it("a client hit takes the higher of the matter's and the client record's classification (final review I2c)", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const a = await register(partner.token, firmId, { classification: "privileged" })
    await seedMatter(firmId, a.clientId, { classification: "confidential" })
    const out = await runCheck({ token: partner.token, data: { firmId, client: { name: "Bashir Ahmed" }, opposingParties: [opposing("Muhammad Ali")] } } as never)
    expect(out.hits).toEqual([expect.objectContaining({ type: "direct_adverse", matterClassification: "privileged" })])
    const stored = (await adminDb().collection("conflict_checks").doc(out.checkId).get()).data()
    expect(stored?.classification).toBe("privileged")
    expect(stored?.hits[0].matterClassification).toBe("privileged")
  })

  it("0 or 21 opposing parties, a bad key, a missing client or an unknown clientId → 400 invalid_subjects; nothing written", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const call = (body: Record<string, unknown>) => apiErrorOf(runCheck({ token: partner.token, data: { firmId, ...body } } as never))
    const many = Array.from({ length: 21 }, (_, i) => opposing(`Party ${i}`))
    for (const body of [
      { client: { name: "A B" }, opposingParties: [] },
      { client: { name: "A B" }, opposingParties: many },
      { client: { name: "A B" } },
      { client: { name: "A B" }, opposingParties: "Kamran" },
      { opposingParties: [opposing("Kamran")] },
      { client: { name: "  " }, opposingParties: [opposing("Kamran")] },
      { client: { name: "A B" }, opposingParties: [opposing("Kamran", { cnic: "421011234567" })] },
      { client: { clientId: "no-such-client" }, opposingParties: [opposing("Kamran")] },
      { client: { clientId: "x", name: "A B" }, opposingParties: [opposing("Kamran")] },
    ]) {
      expectKind(await call(body), "invalid-argument", "invalid_subjects")
    }
    const twenty = await runCheck({ token: partner.token, data: { firmId, client: { name: "A B" }, opposingParties: many.slice(0, 20) } } as never)
    expect(twenty.result).toBe("CLEAR")
    expect((await adminDb().collection("conflict_checks").where("firmId", "==", firmId).get()).size).toBe(1)
  })

  it("a clientId in another firm is invalid_subjects (never screened as ours)", async () => {
    const firmA = await newFirm()
    const firmB = await newFirm()
    const partnerA = await mintIdToken(claims(firmA, "partner"))
    const partnerB = await mintIdToken(claims(firmB, "partner"))
    const a = await register(partnerA.token, firmA)
    const err = await apiErrorOf(runCheck({ token: partnerB.token, data: { firmId: firmB, client: { clientId: a.clientId }, opposingParties: [opposing("K")] } } as never))
    expectKind(err, "invalid-argument", "invalid_subjects")
  })

  it("client role → 403 client_denied; clerk → 403 role_not_permitted", async () => {
    const firmId = await newFirm()
    const client = await mintIdToken(claims(firmId, "client"))
    const clerk = await mintIdToken(claims(firmId, "clerk"))
    const data = { firmId, client: { name: "A B" }, opposingParties: [opposing("Kamran")] }
    expectKind(await apiErrorOf(runCheck({ token: client.token, data } as never)), "permission-denied", "client_denied")
    expectKind(await apiErrorOf(runCheck({ token: clerk.token, data } as never)), "permission-denied", "role_not_permitted")
    expect((await adminDb().collection("conflict_checks").where("firmId", "==", firmId).get()).size).toBe(0)
  })

  it("the response and the stored check never contain a rule number", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const a = await register(partner.token, firmId, { cnic: CNIC_X })
    await seedMatter(firmId, a.clientId)
    const out = await runCheck({ token: partner.token, data: { firmId, client: { name: "Bashir" }, opposingParties: [opposing("Muhammad Ali", { cnic: CNIC_X })] } } as never)
    const stored = (await adminDb().collection("conflict_checks").doc(out.checkId).get()).data()
    for (const text of [JSON.stringify(out), JSON.stringify(stored)]) {
      expect(text).not.toContain("Rule 85")
      expect(text).not.toMatch(/Rule\s*\d/i)
    }
  })
})

describe.skipIf(!EMULATORS)("getConflictResult", () => {
  it("the requester and a same-firm partner read it; another associate, a cross-firm partner and an unknown id → 404 not_found", async () => {
    const firmId = await newFirm()
    const other = await newFirm()
    const associate = await mintIdToken(claims(firmId, "associate"))
    const colleague = await mintIdToken(claims(firmId, "associate"))
    const partner = await mintIdToken(claims(firmId, "partner"))
    const foreign = await mintIdToken(claims(other, "partner"))
    const out = await runCheck({ token: associate.token, data: { firmId, client: { name: "A B" }, opposingParties: [opposing("Kamran")] } } as never)

    expect(await getResult({ token: associate.token, data: { firmId, checkId: out.checkId } } as never)).toMatchObject({ checkId: out.checkId, result: "CLEAR" })
    expect(await getResult({ token: partner.token, data: { firmId, checkId: out.checkId } } as never)).toMatchObject({ checkId: out.checkId })
    expectKind(await apiErrorOf(getResult({ token: colleague.token, data: { firmId, checkId: out.checkId } } as never)), "not-found", "not_found")
    expectKind(await apiErrorOf(getResult({ token: foreign.token, data: { firmId: other, checkId: out.checkId } } as never)), "not-found", "not_found")
    expectKind(await apiErrorOf(getResult({ token: partner.token, data: { firmId, checkId: "nope" } } as never)), "not-found", "not_found")
    expectKind(await apiErrorOf(getResult({ token: partner.token, data: { firmId } } as never)), "invalid-argument", "invalid_query")
  })
})

describe.skipIf(!EMULATORS)("daily conflict limit (Review Focus 5)", () => {
  const FIXED = Date.parse("2026-10-07T18:00:00Z") // 23:00 in Karachi

  it("two real calls increment the firm's Karachi-day counter", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const run = viaApi<CheckResponse>("runConflictCheck", { now: () => FIXED })
    const data = { firmId, client: { name: "A B" }, opposingParties: [opposing("Kamran")] }
    await run({ token: partner.token, data } as never)
    await run({ token: partner.token, data } as never)
    const counter = (await adminDb().collection("counters").doc(`${firmId}_conflictday_20261007`).get()).data()
    expect(counter).toMatchObject({ firmId, count: 2 })
    expect(counter?.expiresAt).toBeInstanceOf(Timestamp)
  })

  it("the 101st check of the day → 429 daily_limit, Retry-After to 19:00 UTC; the same key runs after Karachi midnight", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    await adminDb().collection("counters").doc(`${firmId}_conflictday_20261007`).set({ firmId, count: 100, classification: "internal" })
    const key = randomUUID()
    const data = { firmId, client: { name: "A B" }, opposingParties: [opposing("Kamran")] }

    const refused = await apiErrorOf(viaApi("runConflictCheck", { now: () => FIXED })({ token: partner.token, data, headers: { "idempotency-key": key } } as never))
    expect([refused.status, refused.code, refused.retryAfter]).toEqual([429, "daily_limit", 3600])
    expect((await adminDb().collection("conflict_checks").where("firmId", "==", firmId).get()).size).toBe(0)
    expect((await adminDb().collection("counters").doc(`${firmId}_conflictday_20261007`).get()).data()?.count).toBe(100)
    const denies = await adminDb().collection("audit_log").where("actorId", "==", partner.uid).where("action", "==", "conflict.run").get()
    expect(denies.docs.map((d) => d.data()).filter((r) => r.decision === "deny").map((r) => r.reason)).toEqual(["daily_limit"])

    const nextDay = viaApi<CheckResponse>("runConflictCheck", { now: () => Date.parse("2026-10-07T19:00:00Z") })
    const ok = await nextDay({ token: partner.token, data, headers: { "idempotency-key": key } } as never)
    expect(ok.result).toBe("CLEAR")
    expect((ok as unknown as { reused?: boolean }).reused).toBeUndefined()
    expect((await adminDb().collection("counters").doc(`${firmId}_conflictday_20261008`).get()).data()?.count).toBe(1)
  })
})
