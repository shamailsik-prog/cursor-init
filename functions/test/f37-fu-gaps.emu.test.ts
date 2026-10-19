import { afterAll, afterEach, describe, expect, it } from "vitest"
import { FieldValue } from "firebase-admin/firestore"
import { adminDb } from "../src/admin"
import { nameIndexChunkRef, NAME_INDEX_SCHEMA, readIndexedNames, reconcileNameIndex, reconcileTestSeam } from "../src/d1/conflict/nameIndex"
import { readRegistryState, registryVersionRef } from "../src/d1/registryVersion"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { apiErrorOf, expectKind, viaApi } from "./api"
import { deleteFirmData } from "./firmCleanup"

/**
 * Audit F37 re-audit FA-D1C-006: the reconciliation and loader paths that the shipped suite left unpinned (mutants
 * M18, M19, N08, N09, N10 survived it). Each test fails if its path is broken: the race check of the reconciliation's
 * mark, the born-fresh probe, the reset's version guard, the empty chunk 0 of a name-less index, and the chunk-id check
 * that keeps a firm's heal off another firm whose id it prefixes. Every document a test creates is deleted afterwards.
 */

type Check = { checkId: string; result: string; hits: Array<Record<string, unknown>> }
const registerClient = viaApi<{ clientId: string; entityId: string }>("registerClient")
const runCheck = viaApi<Check>("runConflictCheck")

const created = { firms: [] as string[], uids: [] as string[] }
afterAll(async () => {
  if (EMULATORS) await deleteFirmData(created.firms, created.uids)
}, 600_000)
afterEach(() => {
  delete reconcileTestSeam.afterScan
  delete reconcileTestSeam.beforeReset
})

let mobileSeq = 0
const nextMobile = () => `0305${String(7000000 + ++mobileSeq)}`

async function newFirm(firmId = uniq("f37gap")) {
  created.firms.push(firmId)
  await adminDb().collection("firms").doc(firmId).set({ name: "F37 gap firm", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
  const partner = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
  created.uids.push(partner.uid)
  return { firmId, token: partner.token }
}

async function register(f: { firmId: string; token: string }, name: string): Promise<string> {
  const c = await registerClient({ token: f.token, data: { firmId: f.firmId, name, type: "individual", primaryMobile: nextMobile(), classification: "internal" } } as never)
  return c.clientId
}

const screen = (f: { firmId: string; token: string }, clientId: string, opposing: string) =>
  runCheck({ token: f.token, data: { firmId: f.firmId, client: { clientId }, opposingParties: [{ name: opposing }] } } as never)
const hits = (c: Check, name: string) => c.hits.some((h) => h.matchedName === name && h.outcome !== "NONE")
const isCurrent = async (firmId: string) => {
  const s = await readRegistryState(firmId)
  return s.nameIndex.valid && s.nameIndex.schema === NAME_INDEX_SCHEMA && s.nameIndex.version === s.version
}

describe.skipIf(!EMULATORS)("F37 re-audit FA-D1C-006: the reconciliation's and loader's unpinned paths", () => {
  it("M18: a name written and a bare bump landing between the scan and the mark make the round start over; the name ends up indexed", async () => {
    const f = await newFirm()
    await register(f, "Tariq Zarvani")
    // A stale index (a write that skipped the mirror), so the reconciliation must mark it.
    await registryVersionRef(f.firmId).set({ version: FieldValue.increment(1) }, { merge: true })
    reconcileTestSeam.afterScan = async (round) => {
      if (round !== 1) return
      await adminDb().collection("clients").add({ firmId: f.firmId, canonicalName: "Haris Qalbani", type: "individual", classification: "internal" })
      await registryVersionRef(f.firmId).set({ version: FieldValue.increment(1) }, { merge: true })
    }
    const result = await reconcileNameIndex(f.firmId)
    expect(result).toMatchObject({ marked: true, rounds: 2 })
    expect((await readIndexedNames(f.firmId)).names.has("Haris Qalbani")).toBe(true)
    expect(await isCurrent(f.firmId)).toBe(true)
  }, 120_000)

  it("M19: a firm with a client written out of band and no counter is not born with a current index at its first registration", async () => {
    const f = await newFirm()
    await adminDb().collection("clients").add({ firmId: f.firmId, canonicalName: "Haris Qalbani", type: "individual", classification: "internal" })
    const subject = await register(f, "Tariq Zarvani")
    expect(await isCurrent(f.firmId)).toBe(false)
    expectKind(await apiErrorOf(screen(f, subject, "Haris Qalbani")), "unavailable", "screening_unavailable")
  }, 120_000)

  it("N08: a heal that lands between a run's damage check and its reset is not wiped by the reset", async () => {
    const f = await newFirm()
    const subject = await register(f, "Tariq Zarvani")
    await register(f, "Haris Qalbani")
    await nameIndexChunkRef(f.firmId, 0).update({ chunk: 7 })
    let healedVersion = -1
    reconcileTestSeam.beforeReset = async () => {
      delete reconcileTestSeam.beforeReset
      expect(await reconcileNameIndex(f.firmId)).toMatchObject({ rebuilt: true, marked: true })
      healedVersion = (await readRegistryState(f.firmId)).version
    }
    const result = await reconcileNameIndex(f.firmId)
    // The outer run saw the version move, skipped its reset, and found the healed index current: it wrote nothing.
    expect(result).toMatchObject({ rebuilt: false, marked: false, rounds: 2 })
    expect((await readRegistryState(f.firmId)).version).toBe(healedVersion)
    expect(await isCurrent(f.firmId)).toBe(true)
    expect(hits(await screen(f, subject, "Haris Qalbani"), "Haris Qalbani")).toBe(true)
  }, 120_000)

  it("N09: a firm with no name, once reconciled, screens on its (empty) current index instead of refusing", async () => {
    const f = await newFirm()
    // A counter written by a registry write that adds no name (closeMatter-like): the index is not built yet.
    await registryVersionRef(f.firmId).set({ firmId: f.firmId, kind: "registry", classification: "internal", version: FieldValue.increment(1), nameIndex: { version: FieldValue.increment(1) } }, { merge: true })
    expect(await reconcileNameIndex(f.firmId)).toMatchObject({ names: 0, added: 0, marked: true })
    expect((await nameIndexChunkRef(f.firmId, 0).get()).data()).toMatchObject({ firmId: f.firmId, chunk: 0, names: [] })
    const out = await runCheck({ token: f.token, data: { firmId: f.firmId, client: { name: "Haris Qalbani" }, opposingParties: [{ name: "Zzz Qqq" }] } } as never)
    expect(out.result).toBe("CLEAR")
  }, 120_000)

  it("N10: healing a firm whose id prefixes another firm's id leaves the other firm's chunks and screens alone", async () => {
    const base = uniq("f37pfx")
    const a = await newFirm(base)
    const b = await newFirm(`${base}_7`)
    const aSubject = await register(a, "Tariq Zarvani")
    await register(a, "Haris Qalbani")
    const bSubject = await register(b, "Tariq Zarvani")
    await register(b, "Haris Qalbani")
    const bChunks = async () => (await adminDb().collection("conflict_name_index").where("firmId", "==", b.firmId).get()).docs.map((d) => d.id).sort()
    const before = await bChunks()
    expect(before).toEqual([`${b.firmId}_0`])
    // A's screen ignores B's chunk, whose id starts with A's id.
    expect(hits(await screen(a, aSubject, "Haris Qalbani"), "Haris Qalbani")).toBe(true)
    await nameIndexChunkRef(a.firmId, 0).update({ names: "broken" })
    expect(await reconcileNameIndex(a.firmId)).toMatchObject({ rebuilt: true, marked: true })
    expect(await bChunks()).toEqual(before)
    expect(hits(await screen(b, bSubject, "Haris Qalbani"), "Haris Qalbani")).toBe(true)
    expect(hits(await screen(a, aSubject, "Haris Qalbani"), "Haris Qalbani")).toBe(true)
  }, 120_000)
})
