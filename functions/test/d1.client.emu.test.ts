import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { adminDb } from "../src/admin"
import { parseKeys, parseName } from "../src/d1/validate"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { apiErrorOf, expectKind, viaApi } from "./api"

const registerClient = viaApi<{ clientId: string; clientCode: string; entityId: string; possibleDuplicates: Array<{ clientId: string; clientCode: string; key: string }> }>("registerClient")
const getClient = viaApi<Record<string, unknown>>("getClient")
const listClients = viaApi<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>("listClients")

const claims = (firmId: string, role: string, clearanceLevel = "privileged-restricted") => ({ firmId, role, clearanceLevel })

async function newFirm(prefixes = true): Promise<string> {
  const firmId = uniq("firm")
  await adminDb()
    .collection("firms")
    .doc(firmId)
    .set({ name: "F", plan: "internal", ...(prefixes ? { clientPrefix: "SKD", matterPrefix: "NHS" } : {}) })
  return firmId
}

let mobileSeq = 0
const body = (firmId: string, extra: Record<string, unknown> = {}) => ({
  firmId,
  name: "Muhammad Ali",
  type: "individual",
  primaryMobile: `0300${String(1000000 + ++mobileSeq)}`,
  classification: "internal",
  ...extra,
})

describe("parseName and parseKeys (no emulator needed)", () => {
  it("parseName trims and bounds to 1-200 characters", () => {
    expect(parseName("  Ali Khan ")).toBe("Ali Khan")
    for (const bad of ["", "   ", "x".repeat(201), 5, null, undefined]) {
      expect(() => parseName(bad)).toThrow(expect.objectContaining({ status: 400, code: "invalid_subjects" }))
    }
  })

  it("parseKeys normalises supplied keys, omits absent ones and refuses invalid ones", () => {
    expect(parseKeys({ cnic: "42101-1234567-1", phone: "0300 1234567", ntn: " 123-4 " })).toEqual({
      cnic: "4210112345671",
      phone: "+923001234567",
      ntn: "1234",
    })
    expect(parseKeys({ cnic: "", secp: "  " })).toEqual({})
    expect(() => parseKeys({ cnic: "421011234567" })).toThrow(expect.objectContaining({ code: "invalid_subjects" }))
    expect(() => parseKeys({ phone: "12345" })).toThrow(expect.objectContaining({ code: "invalid_subjects" }))
    expect(() => parseKeys({ cnic: 4210112345671 })).toThrow(expect.objectContaining({ code: "invalid_subjects" }))
  })
})

describe.skipIf(!EMULATORS)("registerClient", () => {
  it("allocates SKD-YYYY-0001 then -0002; clerk may register; one allow audit row per call", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const clerk = await mintIdToken(claims(firmId, "clerk"))
    const year = new Date().getUTCFullYear() // Karachi year differs only in the first 5 hours of 1 January
    const first = await registerClient({ token: partner.token, data: body(firmId) } as never)
    const second = await registerClient({ token: clerk.token, data: body(firmId) } as never)
    expect(first.clientCode).toMatch(new RegExp(`^SKD-(${year}|${year + 1})-0001$`))
    expect(second.clientCode).toMatch(/^SKD-\d{4}-0002$/)
    expect(first.possibleDuplicates).toEqual([])

    const client = (await adminDb().collection("clients").doc(first.clientId).get()).data()
    expect(client).toMatchObject({ firmId, entityId: first.entityId, canonicalName: "Muhammad Ali", classification: "internal", createdBy: partner.uid })
    const entity = (await adminDb().collection("entities").doc(first.entityId).get()).data()
    expect(entity).toMatchObject({ firmId, canonicalName: "Muhammad Ali", classification: "internal" })

    const rows = await adminDb().collection("audit_log").where("actorId", "==", partner.uid).where("action", "==", "client.register").get()
    const opRows = rows.docs.map((d) => d.data()).filter((r) => r.target === `clients/${first.clientId}`)
    expect(opRows.map((r) => r.decision)).toEqual(["allow"])
  })

  it("client role → 403 client_denied; intern → 403 role_not_permitted; nothing written", async () => {
    const firmId = await newFirm()
    const client = await mintIdToken(claims(firmId, "client"))
    const intern = await mintIdToken(claims(firmId, "intern"))
    expectKind(await apiErrorOf(registerClient({ token: client.token, data: body(firmId) } as never)), "permission-denied", "client_denied")
    expectKind(await apiErrorOf(registerClient({ token: intern.token, data: body(firmId) } as never)), "permission-denied", "role_not_permitted")
    expect((await adminDb().collection("clients").where("firmId", "==", firmId).get()).size).toBe(0)
  })

  it("409 numbering_not_configured without prefixes", async () => {
    const firmId = await newFirm(false)
    const partner = await mintIdToken(claims(firmId, "partner"))
    expectKind(await apiErrorOf(registerClient({ token: partner.token, data: body(firmId) } as never)), "failed-precondition", "numbering_not_configured")
  })

  it("stores a dashed CNIC as 13 digits and the phone as E.164; refuses a 12-digit CNIC", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const ok = await registerClient({ token: partner.token, data: body(firmId, { cnic: "42101-1234567-1", primaryMobile: "0300-1234567" }) } as never)
    const client = (await adminDb().collection("clients").doc(ok.clientId).get()).data()
    expect(client).toMatchObject({ cnic: "4210112345671", primaryMobile: "+923001234567" })
    const entity = (await adminDb().collection("entities").doc(ok.entityId).get()).data()
    expect(entity).toMatchObject({ cnic: "4210112345671", phone: "+923001234567" })
    const err = await apiErrorOf(registerClient({ token: partner.token, data: body(firmId, { cnic: "421011234567" }) } as never))
    expectKind(err, "invalid-argument", "invalid_subjects")
    const mobile = await apiErrorOf(registerClient({ token: partner.token, data: body(firmId, { primaryMobile: "021-1234567" }) } as never))
    expectKind(mobile, "invalid-argument", "invalid_subjects")
  })

  it("validates the L7.2 fields: company needs companyName; type, name, classification are required", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const call = (extra: Record<string, unknown>) => apiErrorOf(registerClient({ token: partner.token, data: body(firmId, extra) } as never))
    expectKind(await call({ type: "company" }), "invalid-argument", "invalid_subjects")
    expectKind(await call({ type: "firm" }), "invalid-argument", "invalid_subjects")
    expectKind(await call({ name: "  " }), "invalid-argument", "invalid_subjects")
    expectKind(await call({ classification: undefined }), "invalid-argument", "invalid_subjects")
    expectKind(await call({ email: "not-an-email" }), "invalid-argument", "invalid_subjects")
    const company = await registerClient({ token: partner.token, data: body(firmId, { type: "company", companyName: "Acme Ltd", ntn: "1234567-8", secpNumber: "0012345" }) } as never)
    const row = (await adminDb().collection("clients").doc(company.clientId).get()).data()
    expect(row).toMatchObject({ type: "company", companyName: "Acme Ltd", ntn: "12345678", secpNumber: "0012345" })
  })

  it("classification above the caller's clearance → 403 exceeds_own_clearance", async () => {
    const firmId = await newFirm()
    const associate = await mintIdToken(claims(firmId, "associate", "confidential"))
    const err = await apiErrorOf(registerClient({ token: associate.token, data: body(firmId, { classification: "privileged" }) } as never))
    expectKind(err, "permission-denied", "exceeds_own_clearance")
    await registerClient({ token: associate.token, data: body(firmId, { classification: "confidential" }) } as never)
  })

  it("a second client with the same CNIC reports one possible duplicate and writes one candidate link", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const first = await registerClient({ token: partner.token, data: body(firmId, { cnic: "42101-1234567-1" }) } as never)
    const second = await registerClient({ token: partner.token, data: body(firmId, { cnic: "4210112345671 " }) } as never)
    expect(second.possibleDuplicates).toEqual([{ clientId: first.clientId, clientCode: first.clientCode, key: "cnic" }])
    const links = await adminDb().collection("entity_links").where("firmId", "==", firmId).get()
    expect(links.size).toBe(1)
    const [a, b] = [first.entityId, second.entityId].sort()
    expect(links.docs[0].id).toBe(`${firmId}_${a}_${b}_cnic`)
    expect(links.docs[0].data()).toMatchObject({ firmId, leftId: a, rightId: b, key: "cnic", state: "candidate", disputed: false })
  })

  it("a link takes the higher classification of the two entities; an internal caller gets no duplicate report for a privileged match but the link is written", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const clerk = await mintIdToken(claims(firmId, "clerk", "internal"))
    const priv = await registerClient({ token: partner.token, data: body(firmId, { cnic: "4210199999991", classification: "privileged" }) } as never)
    const res = await registerClient({ token: clerk.token, data: body(firmId, { cnic: "42101-9999999-1", classification: "internal" }) } as never)
    expect(res.possibleDuplicates).toEqual([])
    const links = await adminDb().collection("entity_links").where("firmId", "==", firmId).get()
    expect(links.size).toBe(1)
    expect(links.docs[0].data()).toMatchObject({ key: "cnic", state: "candidate", classification: "privileged" })
    // the reverse order: a privileged newcomer matching an internal entity is also privileged
    const firm2 = await newFirm()
    const p2 = await mintIdToken(claims(firm2, "partner"))
    await registerClient({ token: p2.token, data: body(firm2, { cnic: "4210188888881", classification: "internal" }) } as never)
    await registerClient({ token: p2.token, data: body(firm2, { cnic: "4210188888881", classification: "privileged" }) } as never)
    const l2 = await adminDb().collection("entity_links").where("firmId", "==", firm2).get()
    expect(l2.docs[0].data().classification).toBe("privileged")
    expect(priv.clientId).toBeTruthy()
  })

  it("an entity sharing several keys gets one link per key; another firm's entity never matches", async () => {
    const firmId = await newFirm()
    const other = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const outsider = await mintIdToken(claims(other, "partner"))
    const shared = { cnic: "4210112345671", primaryMobile: "03001112222" }
    await registerClient({ token: outsider.token, data: body(other, shared) } as never)
    const first = await registerClient({ token: partner.token, data: body(firmId, shared) } as never)
    expect(first.possibleDuplicates).toEqual([])
    const second = await registerClient({ token: partner.token, data: body(firmId, shared) } as never)
    expect(second.possibleDuplicates.map((d) => d.key).sort()).toEqual(["cnic", "phone"])
    expect((await adminDb().collection("entity_links").where("firmId", "==", firmId).get()).size).toBe(2)
  })

  it("idempotent replay returns the same clientId and creates one client", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const key = randomUUID()
    const call = () => registerClient({ token: partner.token, data: body(firmId, { primaryMobile: "03005550000" }), headers: { "idempotency-key": key } } as never)
    const first = await call()
    const replay = await call()
    expect(replay.clientId).toBe(first.clientId)
    expect((await adminDb().collection("clients").where("firmId", "==", firmId).get()).size).toBe(1)
  })
})

describe.skipIf(!EMULATORS)("getClient", () => {
  it("returns the client; other firm → 404 not_found; above clearance → 404; missing id → 400", async () => {
    const firmId = await newFirm()
    const otherFirm = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const stranger = await mintIdToken(claims(otherFirm, "partner"))
    const intern = await mintIdToken(claims(firmId, "intern", "internal"))
    const visible = await registerClient({ token: partner.token, data: body(firmId, { cnic: "4210112345671" }) } as never)
    const secret = await registerClient({ token: partner.token, data: body(firmId, { classification: "privileged" }) } as never)

    const got = await getClient({ token: intern.token, data: { firmId, clientId: visible.clientId } } as never)
    expect(got).toMatchObject({ clientId: visible.clientId, clientCode: visible.clientCode, cnic: "4210112345671", classification: "internal" })
    expect(typeof got.createdAt).toBe("string")

    expectKind(await apiErrorOf(getClient({ token: intern.token, data: { firmId, clientId: secret.clientId } } as never)), "not-found", "not_found")
    expectKind(await apiErrorOf(getClient({ token: stranger.token, data: { firmId: otherFirm, clientId: visible.clientId } } as never)), "not-found", "not_found")
    expectKind(await apiErrorOf(getClient({ token: partner.token, data: { firmId, clientId: "nope" } } as never)), "not-found", "not_found")
    expectKind(await apiErrorOf(getClient({ token: partner.token, data: { firmId } } as never)), "invalid-argument", "invalid_query")
    const clientRole = await mintIdToken(claims(firmId, "client"))
    expectKind(await apiErrorOf(getClient({ token: clientRole.token, data: { firmId, clientId: visible.clientId } } as never)), "permission-denied", "client_denied")
  })

  it("one allow audit row for the read itself", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const c = await registerClient({ token: partner.token, data: body(firmId) } as never)
    await getClient({ token: partner.token, data: { firmId, clientId: c.clientId } } as never)
    const rows = await adminDb().collection("audit_log").where("actorId", "==", partner.uid).where("action", "==", "client.read").get()
    expect(rows.docs.map((d) => d.data()).filter((r) => r.target === `clients/${c.clientId}` && r.decision === "allow")).toHaveLength(1)
  })
})

describe.skipIf(!EMULATORS)("listClients", () => {
  it("25 clients: limit=20 gives 20 and a cursor, the next page 5 and nextCursor null; newest first, no repeats", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const ids: string[] = []
    for (let i = 0; i < 25; i++) ids.push((await registerClient({ token: partner.token, data: body(firmId, { name: `Client ${i}` }) } as never)).clientId)
    const page1 = await listClients({ token: partner.token, data: { firmId, limit: "20" } } as never)
    expect(page1.items).toHaveLength(20)
    expect(page1.nextCursor).toEqual(expect.any(String))
    const page2 = await listClients({ token: partner.token, data: { firmId, limit: "20", cursor: page1.nextCursor! } } as never)
    expect(page2.items).toHaveLength(5)
    expect(page2.nextCursor).toBeNull()
    const got = [...page1.items, ...page2.items].map((i) => i.clientId)
    expect(got).toEqual([...ids].reverse())
  }, 60000)

  it("omits clients above the caller's clearance and other firms' clients; exact page boundary has no cursor", async () => {
    const firmId = await newFirm()
    const other = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const outsider = await mintIdToken(claims(other, "partner"))
    const intern = await mintIdToken(claims(firmId, "intern", "internal"))
    const a = await registerClient({ token: partner.token, data: body(firmId) } as never)
    await registerClient({ token: partner.token, data: body(firmId, { classification: "privileged" }) } as never)
    const c = await registerClient({ token: partner.token, data: body(firmId) } as never)
    await registerClient({ token: outsider.token, data: body(other) } as never)
    const page = await listClients({ token: intern.token, data: { firmId, limit: "2" } } as never)
    expect(page.items.map((i) => i.clientId)).toEqual([c.clientId, a.clientId])
    expect(page.nextCursor).toBeNull()
    const err = await apiErrorOf(listClients({ token: intern.token, data: { firmId, cursor: "!!" } } as never))
    expectKind(err, "invalid-argument", "invalid_cursor")
    const lim = await apiErrorOf(listClients({ token: intern.token, data: { firmId, limit: "0" } } as never))
    expectKind(lim, "invalid-argument", "invalid_limit")
  })

  it("a crafted cursor (nanos out of 0..999999999, negative nanos, unsafe id) → 400 invalid_cursor, as listMatters (final review M5)", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const crafted = (sortKey: string, id: string) => Buffer.from(JSON.stringify({ sortKey, id }), "utf8").toString("base64url")
    for (const cursor of [crafted("1700000000.1000000000", "abc"), crafted("1700000000.-1", "abc"), crafted("1700000000.5", "a/b"), crafted("1700000000.5", "")]) {
      expectKind(await apiErrorOf(listClients({ token: partner.token, data: { firmId, cursor } } as never)), "invalid-argument", "invalid_cursor")
    }
    const ok = await listClients({ token: partner.token, data: { firmId, cursor: crafted("1700000000.999999999", "abc") } } as never)
    expect(ok.items).toEqual([])
  })
})
