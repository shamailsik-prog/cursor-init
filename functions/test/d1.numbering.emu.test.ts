import { describe, expect, it } from "vitest"
import { adminDb } from "../src/admin"
import { allocateNumber, formatClientCode, formatMatterNo, karachiDay, karachiYear, readPrefixes } from "../src/d1/numbering"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { apiErrorOf, expectKind, viaApi } from "./api"

const setFirmNumbering = viaApi("setFirmNumbering")

const claims = (firmId: string, role: string, clearanceLevel = "privileged-restricted") => ({ firmId, role, clearanceLevel })
const firmRef = (firmId: string) => adminDb().collection("firms").doc(firmId)

async function newFirm(): Promise<string> {
  const firmId = uniq("firm")
  await firmRef(firmId).set({ name: "F", plan: "internal" })
  return firmId
}

describe("numbering formats and Karachi dates (no emulator needed)", () => {
  it("karachiYear rolls over at midnight Asia/Karachi", () => {
    expect(karachiYear(new Date("2026-12-31T19:30:00Z"))).toBe(2027)
    expect(karachiYear(new Date("2026-12-31T18:30:00Z"))).toBe(2026)
  })

  it("karachiDay is YYYYMMDD in Asia/Karachi", () => {
    expect(karachiDay(new Date("2026-12-31T19:30:00Z"))).toBe("20270101")
    expect(karachiDay(new Date("2026-03-05T10:00:00Z"))).toBe("20260305")
  })

  it("formats client codes and matter numbers, zero-padded to 4 and unpadded beyond", () => {
    expect(formatClientCode("SKD", 2026, 1)).toBe("SKD-2026-0001")
    expect(formatMatterNo("NHS", 2026, 7)).toBe("NHS/2026/0007")
    expect(formatMatterNo("NHS", 2026, 12345)).toBe("NHS/2026/12345")
  })
})

describe.skipIf(!EMULATORS)("allocateNumber", () => {
  it("10 parallel allocations return 1..10 with no repeat", async () => {
    const firmId = uniq("firm")
    const now = new Date("2026-06-01T10:00:00Z")
    const got = await Promise.all(
      Array.from({ length: 10 }, () => adminDb().runTransaction((tx) => allocateNumber(tx, firmId, "matter", now)))
    )
    expect([...got].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const counter = (await adminDb().collection("counters").doc(`${firmId}_matter_2026`).get()).data()
    expect(counter).toMatchObject({ firmId, kind: "matter", year: 2026, next: 11 })
  }, 30000)

  it("keeps separate sequences per kind and per Karachi year", async () => {
    const firmId = uniq("firm")
    const alloc = (kind: "client" | "matter", iso: string) =>
      adminDb().runTransaction((tx) => allocateNumber(tx, firmId, kind, new Date(iso)))
    expect(await alloc("client", "2026-06-01T10:00:00Z")).toBe(1)
    expect(await alloc("matter", "2026-06-01T10:00:00Z")).toBe(1)
    expect(await alloc("client", "2026-06-01T10:00:00Z")).toBe(2)
    expect(await alloc("client", "2026-12-31T19:30:00Z")).toBe(1)
  })

  it("an existing counter with a malformed next → 500 counter_corrupt, never a reset to 1 (final review M4)", async () => {
    const now = new Date("2026-06-01T10:00:00Z")
    for (const next of ["7", 0, -1, 2.5, null]) {
      const firmId = uniq("firm")
      const ref = adminDb().collection("counters").doc(`${firmId}_matter_2026`)
      await ref.set({ firmId, kind: "matter", year: 2026, next })
      await expect(adminDb().runTransaction((tx) => allocateNumber(tx, firmId, "matter", now))).rejects.toMatchObject({
        status: 500,
        code: "counter_corrupt",
      })
      expect((await ref.get()).data()?.next).toEqual(next)
    }
    const missing = uniq("firm")
    await adminDb().collection("counters").doc(`${missing}_matter_2026`).set({ firmId: missing, kind: "matter", year: 2026 })
    await expect(adminDb().runTransaction((tx) => allocateNumber(tx, missing, "matter", now))).rejects.toMatchObject({ code: "counter_corrupt" })
  })
})

describe.skipIf(!EMULATORS)("setFirmNumbering and readPrefixes", () => {
  it("partner sets both prefixes, other firm fields untouched, one allow audit row for the op", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const res = await setFirmNumbering({ token: partner.token, data: { firmId, clientPrefix: "SKD", matterPrefix: "NHS" } } as never)
    expect(res).toEqual({ firmId, clientPrefix: "SKD", matterPrefix: "NHS" })
    const doc = (await firmRef(firmId).get()).data()
    expect(doc).toMatchObject({ name: "F", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
    expect(await adminDb().runTransaction((tx) => readPrefixes(tx, firmId))).toEqual({ clientPrefix: "SKD", matterPrefix: "NHS" })
    const rows = await adminDb().collection("audit_log").where("actorId", "==", partner.uid).where("action", "==", "firm.set_numbering").get()
    expect(rows.docs.map((d) => d.data().decision)).toContain("allow")
  })

  it("associate → 403 role_not_permitted and nothing is written", async () => {
    const firmId = await newFirm()
    const associate = await mintIdToken(claims(firmId, "associate"))
    const err = await apiErrorOf(setFirmNumbering({ token: associate.token, data: { firmId, clientPrefix: "SKD", matterPrefix: "NHS" } } as never))
    expectKind(err, "permission-denied", "role_not_permitted")
    expect((await firmRef(firmId).get()).data()).not.toHaveProperty("clientPrefix")
  })

  it.each([
    ["lowercase", "nhs", "NHS"],
    ["too long", "TOOLONGX", "NHS"],
    ["too short", "S", "NHS"],
    ["bad matter prefix", "SKD", "N-S"],
    ["non-string", 5, "NHS"],
  ])("invalid prefix (%s) → 400 invalid_prefix", async (_name, clientPrefix, matterPrefix) => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId, "partner"))
    const err = await apiErrorOf(setFirmNumbering({ token: partner.token, data: { firmId, clientPrefix, matterPrefix } } as never))
    expectKind(err, "invalid-argument", "invalid_prefix")
  })

  it("readPrefixes on a firm with no prefixes → 409 numbering_not_configured", async () => {
    const firmId = await newFirm()
    await expect(adminDb().runTransaction((tx) => readPrefixes(tx, firmId))).rejects.toMatchObject({
      status: 409,
      code: "numbering_not_configured",
    })
  })
})
