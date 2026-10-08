import { describe, expect, it } from "vitest"
import { Timestamp } from "firebase-admin/firestore"
import { adminDb } from "../src/admin"
import { LINK_AUTO_CONFIRM_MS } from "../src/d1/entity/linkState"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { apiErrorOf, expectKind, viaApi } from "./api"

/**
 * Phase 2b-A Task 3 (spec P2-31, P2-32, P2-34): the read routes of the L17.2 entity review —
 * listReviewQueue, getEntity, listAliases — over the emulators through the HTTP router, on a
 * fake clock (`now`); links are aged by rewriting `createdAt` with the Admin SDK.
 */

const NOW = Date.parse("2026-10-08T00:00:00Z")
const DAY = 24 * 60 * 60 * 1000
const clock = { now: () => NOW }

type Summary = { entityId: string; canonicalName: string; clientId: string | null; clientCode: string | null; keys: Record<string, string> }
type QueueItem = {
  pairId: string
  linkIds: string[]
  keys: string[]
  effectiveState: string
  createdAt: string
  autoConfirmAt: string | null
  classification: string
  dispute?: { by: string; at: string; note: string }
  left: Summary
  right: Summary
}
type LinkView = { pairId: string; linkIds: string[]; otherEntityId: string; otherCanonicalName: string; keys: string[]; effectiveState: string; autoConfirmAt: string | null; mergeEventId: string | null }
type EntityView = Summary & { classification: string; createdAt: string; links: LinkView[] }
type Alias = { kind: string; value: string; source: string; entityId: string }

const registerClient = viaApi<{ clientId: string; clientCode: string; entityId: string }>("registerClient")
const listReviewQueue = viaApi<{ items: QueueItem[]; nextCursor: string | null }>("listReviewQueue", clock)
const getEntity = viaApi<EntityView>("getEntity", clock)
const listAliases = viaApi<{ items: Alias[]; nextCursor: null }>("listAliases", clock)

const claims = (firmId: string, role: string, clearanceLevel = "privileged-restricted") => ({ firmId, role, clearanceLevel })

async function newFirm(extra: Record<string, unknown> = {}): Promise<string> {
  const firmId = uniq("firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS", ...extra })
  return firmId
}

let seq = 0
const mobile = () => `0300${String(2000000 + ++seq)}`
let cnicSeq = 0
const cnic = () => `42101${String(1000000 + ++cnicSeq)}1`

type Reg = { clientId: string; clientCode: string; entityId: string }
async function register(token: string, firmId: string, extra: Record<string, unknown>): Promise<Reg> {
  return registerClient({ token, data: { firmId, name: "Muhammad Ali", type: "individual", primaryMobile: mobile(), classification: "internal", ...extra } } as never)
}

const pairOf = (x: string, y: string) => [x, y].sort().join("_")

/** The link rows of one pair. */
async function pairRows(firmId: string, x: string, y: string) {
  const [a, b] = [x, y].sort()
  const snap = await adminDb().collection("entity_links").where("firmId", "==", firmId).where("leftId", "==", a).where("rightId", "==", b).get()
  return snap.docs
}

/** Sets createdAt of every row of the pair to NOW - ageMs (plus extra fields). */
async function setPair(firmId: string, x: string, y: string, ageMs: number, extra: Record<string, unknown> = {}): Promise<string[]> {
  const docs = await pairRows(firmId, x, y)
  expect(docs.length).toBeGreaterThan(0)
  for (const d of docs) await d.ref.update({ createdAt: Timestamp.fromMillis(NOW - ageMs), ...extra })
  return docs.map((d) => d.id).sort()
}

/** The call's own allow rows on `target` (the permission decision row names the firm, not the target). */
async function allowRows(uid: string, target: string) {
  const rows = await adminDb().collection("audit_log").where("actorId", "==", uid).where("action", "==", "entity.review").get()
  return rows.docs.map((d) => d.data()).filter((r) => r.decision === "allow" && r.target === target)
}

describe.skipIf(!EMULATORS)("listReviewQueue (P2-31)", () => {
  it("three clients with one CNIC → 3 pairs, oldest first, candidate, autoConfirmAt = createdAt + 30 d; one allow audit row", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const associate = await mintIdToken(claims(firmId, "associate", "internal"))
    const key = cnic()
    const a = await register(partner.token, firmId, { name: "Muhammad Ali", cnic: key })
    const b = await register(partner.token, firmId, { name: "Mohammad Ali", cnic: key })
    const c = await register(partner.token, firmId, { name: "M. Ali", cnic: key })
    await setPair(firmId, b.entityId, c.entityId, 10 * DAY)
    await setPair(firmId, a.entityId, c.entityId, 5 * DAY)
    await setPair(firmId, a.entityId, b.entityId, 1 * DAY)

    const page = await listReviewQueue({ token: associate.token, data: { firmId } } as never)
    expect(page.nextCursor).toBeNull()
    expect(page.items.map((i) => i.pairId)).toEqual([pairOf(b.entityId, c.entityId), pairOf(a.entityId, c.entityId), pairOf(a.entityId, b.entityId)])
    for (const [i, age] of [10, 5, 1].entries()) {
      const item = page.items[i]
      expect(item.effectiveState).toBe("candidate")
      expect(item.keys).toEqual(["cnic"])
      expect(item.linkIds).toHaveLength(1)
      expect(item.classification).toBe("internal")
      expect(item.createdAt).toBe(new Date(NOW - age * DAY).toISOString())
      expect(item.autoConfirmAt).toBe(new Date(NOW - age * DAY + LINK_AUTO_CONFIRM_MS).toISOString())
    }
    const first = page.items[0]
    const [left, right] = [b, c].sort((x, y) => (x.entityId < y.entityId ? -1 : 1))
    expect(first.left).toMatchObject({ entityId: left.entityId, clientId: left.clientId, clientCode: left.clientCode, keys: { cnic: key } })
    expect(first.right).toMatchObject({ entityId: right.entityId, clientId: right.clientId, clientCode: right.clientCode })
    expect(typeof first.left.canonicalName).toBe("string")
    expect(await allowRows(associate.uid, `firms/${firmId}/entity_links`)).toHaveLength(1)
  })

  it("a pair aged exactly 30 d is auto-confirmed and absent; one aged 30 d − 1 ms is present (Review Focus 2)", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const k1 = cnic()
    const k2 = cnic()
    const a = await register(partner.token, firmId, { cnic: k1 })
    const b = await register(partner.token, firmId, { cnic: k1 })
    const c = await register(partner.token, firmId, { cnic: k2 })
    const d = await register(partner.token, firmId, { cnic: k2 })
    await setPair(firmId, a.entityId, b.entityId, LINK_AUTO_CONFIRM_MS)
    await setPair(firmId, c.entityId, d.entityId, LINK_AUTO_CONFIRM_MS - 1)
    const page = await listReviewQueue({ token: partner.token, data: { firmId } } as never)
    expect(page.items.map((i) => i.pairId)).toEqual([pairOf(c.entityId, d.entityId)])
    expect(page.items[0].autoConfirmAt).toBe(new Date(NOW + 1).toISOString())
  })

  it("limit=1 over two pairs of CNIC + phone rows: each page finishes its pair (pair completion)", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const [k1, k2, m1, m2] = [cnic(), cnic(), mobile(), mobile()]
    const a = await register(partner.token, firmId, { cnic: k1, primaryMobile: m1 })
    const b = await register(partner.token, firmId, { cnic: k1, primaryMobile: m1 })
    const c = await register(partner.token, firmId, { cnic: k2, primaryMobile: m2 })
    const d = await register(partner.token, firmId, { cnic: k2, primaryMobile: m2 })
    const ab = await setPair(firmId, a.entityId, b.entityId, 3 * DAY)
    const cd = await setPair(firmId, c.entityId, d.entityId, 2 * DAY)
    expect([ab.length, cd.length]).toEqual([2, 2])

    const p1 = await listReviewQueue({ token: partner.token, data: { firmId, limit: "1" } } as never)
    expect(p1.items).toHaveLength(1)
    expect(p1.items[0].pairId).toBe(pairOf(a.entityId, b.entityId))
    expect(p1.items[0].linkIds).toEqual(ab)
    expect(p1.items[0].keys).toEqual(["cnic", "phone"])
    expect(typeof p1.nextCursor).toBe("string")

    const p2 = await listReviewQueue({ token: partner.token, data: { firmId, limit: "1", cursor: p1.nextCursor } } as never)
    expect(p2.items).toHaveLength(1)
    expect(p2.items[0].pairId).toBe(pairOf(c.entityId, d.entityId))
    expect(p2.items[0].linkIds).toEqual(cd)
    expect(p2.nextCursor).toBeNull()
  })

  it("view=disputed lists only the disputed pair (autoConfirmAt null, dispute shown); pending omits it", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const k1 = cnic()
    const k2 = cnic()
    const a = await register(partner.token, firmId, { cnic: k1 })
    const b = await register(partner.token, firmId, { cnic: k1 })
    const c = await register(partner.token, firmId, { cnic: k2 })
    const d = await register(partner.token, firmId, { cnic: k2 })
    const dispute = { by: partner.uid, role: "partner", at: Timestamp.fromMillis(NOW - DAY), note: "These are two different people, checked." }
    await setPair(firmId, a.entityId, b.entityId, 40 * DAY, { disputed: true, dispute })
    await setPair(firmId, c.entityId, d.entityId, 2 * DAY)

    const disputed = await listReviewQueue({ token: partner.token, data: { firmId, view: "disputed" } } as never)
    expect(disputed.items.map((i) => i.pairId)).toEqual([pairOf(a.entityId, b.entityId)])
    expect(disputed.items[0]).toMatchObject({
      effectiveState: "disputed",
      autoConfirmAt: null,
      dispute: { by: partner.uid, at: new Date(NOW - DAY).toISOString(), note: dispute.note },
    })
    const pending = await listReviewQueue({ token: partner.token, data: { firmId, view: "pending" } } as never)
    expect(pending.items.map((i) => i.pairId)).toEqual([pairOf(c.entityId, d.entityId)])
  })

  it("view=x → 400 invalid_query; limit=0 → 400 invalid_limit; a malformed cursor → 400 invalid_cursor", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    expectKind(await apiErrorOf(listReviewQueue({ token: partner.token, data: { firmId, view: "x" } } as never)), "invalid-argument", "invalid_query")
    expectKind(await apiErrorOf(listReviewQueue({ token: partner.token, data: { firmId, limit: "0" } } as never)), "invalid-argument", "invalid_limit")
    expectKind(await apiErrorOf(listReviewQueue({ token: partner.token, data: { firmId, cursor: "!!" } } as never)), "invalid-argument", "invalid_cursor")
    const badNanos = Buffer.from(JSON.stringify({ sortKey: "1.2000000000", id: "x" })).toString("base64url")
    expectKind(await apiErrorOf(listReviewQueue({ token: partner.token, data: { firmId, cursor: badNanos } } as never)), "invalid-argument", "invalid_cursor")
    const outOfRange = Buffer.from(JSON.stringify({ sortKey: "99999999999999.0", id: "x" })).toString("base64url")
    expectKind(await apiErrorOf(listReviewQueue({ token: partner.token, data: { firmId, cursor: outOfRange } } as never)), "invalid-argument", "invalid_cursor")
  })

  it("limit=1, a visible pair then a younger confidential pair, internal associate → nextCursor null (a hidden pair never signals more)", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const internal = await mintIdToken(claims(firmId, "associate", "internal"))
    const [k1, k2] = [cnic(), cnic()]
    const a = await register(partner.token, firmId, { cnic: k1 })
    const b = await register(partner.token, firmId, { cnic: k1 })
    const h1 = await register(partner.token, firmId, { cnic: k2, classification: "confidential" })
    const h2 = await register(partner.token, firmId, { cnic: k2, classification: "confidential" })
    await setPair(firmId, a.entityId, b.entityId, 3 * DAY)
    await setPair(firmId, h1.entityId, h2.entityId, 2 * DAY)
    const page = await listReviewQueue({ token: internal.token, data: { firmId, limit: "1" } } as never)
    expect(page.items.map((i) => i.pairId)).toEqual([pairOf(a.entityId, b.entityId)])
    expect(page.nextCursor).toBeNull()
  })

  it("hidden rows straddle a visible pair: the cursor never encodes a hidden pair's ids, and page 2 is the next visible pair", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const internal = await mintIdToken(claims(firmId, "associate", "internal"))
    const [kv, kh, kw, kx, mh] = [cnic(), cnic(), cnic(), cnic(), mobile()]
    const v1 = await register(partner.token, firmId, { cnic: kv })
    const v2 = await register(partner.token, firmId, { cnic: kv })
    const h1 = await register(partner.token, firmId, { cnic: kh, primaryMobile: mh, classification: "confidential" })
    const h2 = await register(partner.token, firmId, { cnic: kh, primaryMobile: mh, classification: "confidential" })
    const w1 = await register(partner.token, firmId, { cnic: kw })
    const w2 = await register(partner.token, firmId, { cnic: kw })
    const x1 = await register(partner.token, firmId, { cnic: kx })
    const x2 = await register(partner.token, firmId, { cnic: kx })
    await setPair(firmId, v1.entityId, v2.entityId, 4 * DAY)
    // The hidden pair's CNIC row sorts before W and its phone row after W (just before X).
    const hidden = await pairRows(firmId, h1.entityId, h2.entityId)
    expect(hidden.map((d) => d.data().key).sort()).toEqual(["cnic", "phone"])
    for (const d of hidden) await d.ref.update({ createdAt: Timestamp.fromMillis(NOW - (d.data().key === "cnic" ? 3 : 1.5) * DAY) })
    await setPair(firmId, w1.entityId, w2.entityId, 2 * DAY)
    await setPair(firmId, x1.entityId, x2.entityId, 1 * DAY)

    const p1 = await listReviewQueue({ token: internal.token, data: { firmId, limit: "2" } } as never)
    expect(p1.items.map((i) => i.pairId)).toEqual([pairOf(v1.entityId, v2.entityId), pairOf(w1.entityId, w2.entityId)])
    expect(typeof p1.nextCursor).toBe("string")
    const decoded = Buffer.from(p1.nextCursor!, "base64url").toString("utf8")
    expect(decoded).not.toContain(h1.entityId)
    expect(decoded).not.toContain(h2.entityId)
    const p2 = await listReviewQueue({ token: internal.token, data: { firmId, limit: "2", cursor: p1.nextCursor } } as never)
    expect(p2.items.map((i) => i.pairId)).toEqual([pairOf(x1.entityId, x2.entityId)])
    expect(p2.nextCursor).toBeNull()
  })

  it("a confidential pair is omitted for an internal associate and listed for a confidential one (Review Focus 5)", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const internal = await mintIdToken(claims(firmId, "associate", "internal"))
    const confidential = await mintIdToken(claims(firmId, "associate", "confidential"))
    const key = cnic()
    const a = await register(partner.token, firmId, { cnic: key, classification: "confidential" })
    const b = await register(partner.token, firmId, { cnic: key, classification: "confidential" })
    await setPair(firmId, a.entityId, b.entityId, DAY)
    const hidden = await listReviewQueue({ token: internal.token, data: { firmId } } as never)
    expect(hidden).toEqual({ items: [], nextCursor: null })
    const shown = await listReviewQueue({ token: confidential.token, data: { firmId } } as never)
    expect(shown.items.map((i) => [i.pairId, i.classification])).toEqual([[pairOf(a.entityId, b.entityId), "confidential"]])
  })

  it("clerk → 403 role_not_permitted; client → 403 client_denied; L17.2 off → 404 feature_disabled", async () => {
    const firmId = await newFirm()
    const clerk = await mintIdToken(claims(firmId, "clerk"))
    const client = await mintIdToken(claims(firmId, "client"))
    expectKind(await apiErrorOf(listReviewQueue({ token: clerk.token, data: { firmId } } as never)), "permission-denied", "role_not_permitted")
    expectKind(await apiErrorOf(listReviewQueue({ token: client.token, data: { firmId } } as never)), "permission-denied", "client_denied")
    const off = await newFirm({ featureFlags: { L17_2_ENABLED: false } })
    const partner = await mintIdToken(claims(off, "partner"))
    expectKind(await apiErrorOf(listReviewQueue({ token: partner.token, data: { firmId: off } } as never)), "not-found", "feature_disabled")
    expectKind(await apiErrorOf(getEntity({ token: partner.token, data: { firmId: off, entityId: "e1" } } as never)), "not-found", "feature_disabled")
    expectKind(await apiErrorOf(listAliases({ token: partner.token, data: { firmId: off, entityId: "e1" } } as never)), "not-found", "feature_disabled")
  })
})

describe.skipIf(!EMULATORS)("getEntity (P2-32)", () => {
  it("returns the entity, its client code and its two candidate links; a confirmed link shows its mergeEventId; one allow audit row", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const associate = await mintIdToken(claims(firmId, "associate", "internal"))
    const key = cnic()
    const a = await register(partner.token, firmId, { name: "Muhammad Ali", cnic: key })
    const b = await register(partner.token, firmId, { name: "Mohammad Ali", cnic: key })
    const c = await register(partner.token, firmId, { name: "M. A. Siddiqui", cnic: key })
    await setPair(firmId, a.entityId, b.entityId, DAY)
    await setPair(firmId, a.entityId, c.entityId, 2 * DAY)

    const view = await getEntity({ token: associate.token, data: { firmId, entityId: a.entityId } } as never)
    expect(view).toMatchObject({ entityId: a.entityId, canonicalName: "Muhammad Ali", clientId: a.clientId, classification: "internal", keys: { cnic: key } })
    expect(view.clientCode).toMatch(/^SKD-\d{4}-0001$/)
    expect(view.clientCode).toBe(a.clientCode)
    expect(typeof view.createdAt).toBe("string")
    const expected = [
      { pairId: pairOf(a.entityId, b.entityId), otherEntityId: b.entityId, otherCanonicalName: "Mohammad Ali" },
      { pairId: pairOf(a.entityId, c.entityId), otherEntityId: c.entityId, otherCanonicalName: "M. A. Siddiqui" },
    ].sort((x, y) => (x.pairId < y.pairId ? -1 : 1))
    expect(view.links.map((l) => ({ pairId: l.pairId, otherEntityId: l.otherEntityId, otherCanonicalName: l.otherCanonicalName }))).toEqual(expected)
    for (const l of view.links) {
      expect(l).toMatchObject({ effectiveState: "candidate", keys: ["cnic"], mergeEventId: null })
      expect(l.linkIds).toHaveLength(1)
    }
    const ab = view.links.find((l) => l.otherEntityId === b.entityId)!
    expect(ab.autoConfirmAt).toBe(new Date(NOW - DAY + LINK_AUTO_CONFIRM_MS).toISOString())
    expect(await allowRows(associate.uid, `entities/${a.entityId}`)).toHaveLength(1)

    await setPair(firmId, a.entityId, b.entityId, DAY, { state: "confirmed", confirmation: { by: partner.uid, role: "partner", at: Timestamp.fromMillis(NOW), note: "same person, CNIC copy checked", mergeEventId: "m1" } })
    const after = await getEntity({ token: associate.token, data: { firmId, entityId: a.entityId } } as never)
    expect(after.links.find((l) => l.otherEntityId === b.entityId)).toMatchObject({ effectiveState: "confirmed", mergeEventId: "m1", autoConfirmAt: null })
    expect(after.links.find((l) => l.otherEntityId === c.entityId)).toMatchObject({ effectiveState: "candidate", mergeEventId: null })
  })

  it("an entity above the caller's clearance, a missing one and another firm's → 404 not_found; a confidential link is omitted for an internal reader", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const associate = await mintIdToken(claims(firmId, "associate", "internal"))
    const key = cnic()
    const a = await register(partner.token, firmId, { cnic: key })
    const secret = await register(partner.token, firmId, { cnic: key, classification: "confidential" })
    expectKind(await apiErrorOf(getEntity({ token: associate.token, data: { firmId, entityId: secret.entityId } } as never)), "not-found", "not_found")
    expectKind(await apiErrorOf(getEntity({ token: associate.token, data: { firmId, entityId: "no-such-entity" } } as never)), "not-found", "not_found")
    expectKind(await apiErrorOf(getEntity({ token: associate.token, data: { firmId } } as never)), "invalid-argument", "invalid_query")
    const view = await getEntity({ token: associate.token, data: { firmId, entityId: a.entityId } } as never)
    expect(view.links).toEqual([])
    const full = await getEntity({ token: partner.token, data: { firmId, entityId: a.entityId } } as never)
    expect(full.links.map((l) => l.otherEntityId)).toEqual([secret.entityId])

    const other = await newFirm()
    const otherPartner = await mintIdToken(claims(other, "partner"))
    expectKind(await apiErrorOf(getEntity({ token: otherPartner.token, data: { firmId: other, entityId: a.entityId } } as never)), "not-found", "not_found")
    expectKind(await apiErrorOf(listAliases({ token: otherPartner.token, data: { firmId: other, entityId: a.entityId } } as never)), "not-found", "not_found")
    expectKind(await apiErrorOf(listAliases({ token: associate.token, data: { firmId, entityId: secret.entityId } } as never)), "not-found", "not_found")
  })

  it("a pair whose other entity's client is above clearance is hidden from getEntity and listAliases, as in the queue and readPair (final review minor 1)", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const associate = await mintIdToken(claims(firmId, "associate", "internal"))
    const key = cnic()
    const a = await register(partner.token, firmId, { name: "Muhammad Ali", cnic: key })
    const b = await register(partner.token, firmId, { name: "Mohammad Ali Khan", cnic: key })
    await setPair(firmId, a.entityId, b.entityId, LINK_AUTO_CONFIRM_MS)
    // Entity B and the link rows stay internal; only B's client is raised.
    await adminDb().collection("clients").doc(b.clientId).update({ classification: "confidential" })

    const queue = await listReviewQueue({ token: associate.token, data: { firmId } } as never)
    expect(queue.items).toEqual([])
    const hiddenView = await getEntity({ token: associate.token, data: { firmId, entityId: a.entityId } } as never)
    expect(hiddenView.links).toEqual([])
    const hiddenAliases = await listAliases({ token: associate.token, data: { firmId, entityId: a.entityId } } as never)
    expect(hiddenAliases.items.map((i) => i.value)).not.toContain("Mohammad Ali Khan")

    const fullView = await getEntity({ token: partner.token, data: { firmId, entityId: a.entityId } } as never)
    expect(fullView.links.map((l) => l.otherEntityId)).toEqual([b.entityId])
    const fullAliases = await listAliases({ token: partner.token, data: { firmId, entityId: a.entityId } } as never)
    expect(fullAliases.items.map((i) => i.value)).toContain("Mohammad Ali Khan")
  })
})

describe.skipIf(!EMULATORS)("listAliases (P2-32)", () => {
  it("entity, client, alias and confirmed-link variants; candidate links and above-clearance aliases excluded; deduplicated; one allow audit row", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const associate = await mintIdToken(claims(firmId, "associate", "internal"))
    const key = cnic()
    const alt = "0321 7654321"
    const a = await register(partner.token, firmId, { name: "Muhammad Ali", cnic: key, alternateMobile: alt })
    const b = await register(partner.token, firmId, { name: "Mohammad Ali Khan", cnic: key })
    const c = await register(partner.token, firmId, { name: "Ahmed Siddiqui", cnic: key })
    await setPair(firmId, a.entityId, b.entityId, DAY, { state: "confirmed", confirmation: { by: partner.uid, role: "partner", at: Timestamp.fromMillis(NOW), note: "same person, CNIC copy checked", mergeEventId: "m1" } })
    await setPair(firmId, a.entityId, c.entityId, DAY)
    const aliases = adminDb().collection("entity_aliases")
    await aliases.doc(uniq("al")).set({ firmId, entityId: a.entityId, kind: "name", value: "M. Ali", classification: "internal" })
    await aliases.doc(uniq("al")).set({ firmId, entityId: a.entityId, kind: "name", value: "Privileged Alias", classification: "privileged" })
    await aliases.doc(uniq("al")).set({ firmId, entityId: a.entityId, kind: "name", value: "Muhammad Ali", classification: "internal" })
    await aliases.doc(uniq("al")).set({ firmId: "another-firm", entityId: a.entityId, kind: "name", value: "Foreign Alias", classification: "internal" })

    const out = await listAliases({ token: associate.token, data: { firmId, entityId: a.entityId } } as never)
    expect(out.nextCursor).toBeNull()
    const items = out.items
    expect(items[0]).toEqual({ kind: "name", value: "Muhammad Ali", source: "entity", entityId: a.entityId })
    expect(items).toContainEqual({ kind: "cnic", value: key, source: "entity", entityId: a.entityId })
    expect(items).toContainEqual({ kind: "phone", value: "+923217654321", source: "client", entityId: a.entityId })
    expect(items).toContainEqual({ kind: "name", value: "M. Ali", source: "alias", entityId: a.entityId })
    expect(items).toContainEqual({ kind: "name", value: "Mohammad Ali Khan", source: "confirmed_link", entityId: b.entityId })
    const values = items.map((i) => i.value)
    expect(values).not.toContain("Ahmed Siddiqui")
    expect(values).not.toContain("Privileged Alias")
    expect(values).not.toContain("Foreign Alias")
    expect(values.filter((v) => v === "Muhammad Ali")).toHaveLength(1)
    expect(values.filter((v) => v === key)).toHaveLength(1)
    const seen = new Set(items.map((i) => `${i.kind}\u0000${i.value}`))
    expect(seen.size).toBe(items.length)
    expect(await allowRows(associate.uid, `entities/${a.entityId}`)).toHaveLength(1)

    // Once A–C auto-confirms (30 d, undisputed) its name is a variant too.
    await setPair(firmId, a.entityId, c.entityId, LINK_AUTO_CONFIRM_MS)
    const later = await listAliases({ token: associate.token, data: { firmId, entityId: a.entityId } } as never)
    expect(later.items).toContainEqual({ kind: "name", value: "Ahmed Siddiqui", source: "confirmed_link", entityId: c.entityId })
  })
})
