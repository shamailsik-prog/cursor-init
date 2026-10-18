import { describe, expect, it } from "vitest"
import { FieldValue, Timestamp, type DocumentData, type DocumentReference, type WriteBatch } from "firebase-admin/firestore"
import { adminDb } from "../src/admin"
import { loadScreeningRegistry } from "../src/d1/conflict/candidates"
import { clientKeys, loadRegistry, runEngine, type EngineResult } from "../src/d1/conflict/engine"
import type { Hit, Keys, Subject } from "../src/d1/conflict/match"
import { nameIndexChunkRef, reconcileNameIndex, readIndexedNames } from "../src/d1/conflict/nameIndex"
import { nameForms } from "../src/d1/conflict/normalise"
import { WORD_SEED } from "../src/d1/conflict/translit-seed"
import { readRegistryState } from "../src/d1/registryVersion"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { viaApi } from "./api"

/**
 * Audit F37, the recall proof (spec 2026-10-18-f37 rulings 1, 2 and 12): on randomised synthetic registries the
 * candidate loader's screen (`loadScreeningRegistry` → `runEngine`) returns exactly the full scan's screen
 * (`loadRegistry` → `runEngine`, the old path kept as the oracle): the same hits in the same order, the same
 * result, identity basis and classification.
 *
 * Part 1 seeds each registry out of band and builds its name index with the production reconciliation. The
 * registries mix Roman spelling variants, typos, concatenations and honorifics; Urdu-script names from the seed
 * table, from the firm's transliteration map (some with several Roman spellings) and words only the lossy
 * fallback can read; shared and differing CNIC / NTN / SECP / phone keys; entities shared by clients and
 * parties; entity links in every state (candidate, aged, disputed, confirmed, rejected, un-merging, malformed);
 * live, closed and unconfirmed matters with known, unknown and missing labels; parties on the firm's matters, on
 * another firm's matter, on a missing or malformed matter id, or standalone; client-role party rows; rows with
 * no string name; the L17.2 flag on, off and malformed; and a shadow firm holding copies of the same names,
 * keys and entity ids, which neither path may read. Part 2 builds registries only through the real writers.
 *
 * Synthetic data only.
 */

const NOW = new Date("2099-03-01T09:00:00.000Z")
const DAY = 24 * 60 * 60 * 1000
const REGISTRIES = 300
const SUBJECT_SETS = 3

function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Rand = () => number
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
const chance = (r: Rand, p: number) => r() < p
const int = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))

const ROMAN = [
  "muhammad", "mohammad", "mohd", "ali", "aly", "hussain", "husain", "ahmed", "ahmad", "shaikh", "sheikh", "khan",
  "bhutto", "memon", "soomro", "baloch", "abdullah", "abdul", "rehman", "rahman", "fatima", "ayesha", "aisha",
  "hassan", "hasan", "umar", "omar", "usman", "bilal", "ibrahim", "yousuf", "yusuf", "aslam", "akram", "raza",
  "zahid", "tariq", "nawaz", "shah", "qureshi", "raja", "noor", "iqbal", "pervaiz", "javed", "nasir", "haris",
  "qalbani", "zarvani", "daryani", "kamran", "traders", "sons", "enterprises", "textiles",
]
const HONORIFIC = ["syed", "haji", "mr", "dr", "mian", "sb", "begum"]
const SEEDED_URDU = Object.keys(WORD_SEED)
/** Arabic-script words outside the seed table: the firm map may spell them; otherwise only the lossy fallback reads them. */
const UNSEEDED_URDU = ["قلبانی", "زروانی", "دریانی", "رحمان", "کامران", "تاجران"]
const FIRM_MAP_SPELLINGS: Record<string, string[]> = {
  "قلبانی": ["qalbani"],
  "زروانی": ["zarvani", "zarwani"],
  "دریانی": ["daryani"],
  "رحمان": ["rehman", "rahman"],
  "کامران": ["kamran"],
  "تاجران": ["traders"],
}
const LABELS = ["public", "internal", "confidential", "privileged", "privileged-restricted", "weird-label", undefined]

function syllables(r: Rand): string {
  const c = "bdfgjklmnprstvz"
  const v = "aeiou"
  let s = ""
  for (let i = 0, n = int(r, 2, 3); i < n; i++) s += pick(r, [...c]) + pick(r, [...v])
  return s
}

/** One typo in a token: an inserted, deleted or substituted letter. */
function typo(r: Rand, t: string): string {
  if (t.length < 3 || /[؀-ۿ]/.test(t)) return t
  const i = int(r, 1, t.length - 1)
  const ch = pick(r, [..."aeiouhnrmlk"])
  const op = int(r, 0, 2)
  return op === 0 ? t.slice(0, i) + ch + t.slice(i) : op === 1 ? t.slice(0, i) + t.slice(i + 1) : t.slice(0, i) + ch + t.slice(i + 1)
}

function token(r: Rand): string {
  const x = r()
  if (x < 0.62) return pick(r, ROMAN)
  if (x < 0.76) return pick(r, SEEDED_URDU)
  if (x < 0.86) return pick(r, UNSEEDED_URDU)
  return syllables(r)
}

const cap = (t: string) => (/^[a-z]/.test(t) ? t[0].toUpperCase() + t.slice(1) : t)

function freshName(r: Rand): string {
  const tokens = Array.from({ length: int(r, 1, 3) }, () => token(r))
  if (chance(r, 0.15)) tokens.unshift(pick(r, HONORIFIC))
  return tokens.map((t) => (chance(r, 0.7) ? cap(t) : t)).join(chance(r, 0.1) ? "  " : " ")
}

/** A variant of an existing name: a typo, a dropped or added token, two tokens run together, a reordering, a variant spelling. */
function variant(r: Rand, name: string): string {
  let tokens = name.split(/\s+/).filter((t) => t !== "")
  const op = int(r, 0, 5)
  if (op === 0 && tokens.length > 0) {
    const i = int(r, 0, tokens.length - 1)
    tokens[i] = typo(r, tokens[i])
  } else if (op === 1 && tokens.length > 1) tokens.splice(int(r, 0, tokens.length - 1), 1)
  else if (op === 2) tokens.push(token(r))
  else if (op === 3 && tokens.length > 1) {
    const i = int(r, 0, tokens.length - 2)
    tokens = [...tokens.slice(0, i), tokens[i] + tokens[i + 1].toLowerCase(), ...tokens.slice(i + 2)]
  } else if (op === 4) tokens.reverse()
  else if (tokens.length > 0) {
    const i = int(r, 0, tokens.length - 1)
    const swaps: Record<string, string> = { muhammad: "mohd", ahmed: "ahmad", ali: "aly", rehman: "rahman", hussain: "husain", yousuf: "yusuf" }
    tokens[i] = swaps[tokens[i].toLowerCase()] ?? typo(r, tokens[i])
  }
  return tokens.join(" ") || name
}

type Pools = { cnic: string[]; ntn: string[]; secp: string[]; phone: string[] }
function pools(r: Rand): Pools {
  const digits = (n: number) => Array.from({ length: n }, () => int(r, 0, 9)).join("")
  return {
    cnic: Array.from({ length: 4 }, () => `42101${digits(8)}`),
    ntn: Array.from({ length: 3 }, () => `NTN${digits(5)}`),
    secp: Array.from({ length: 3 }, () => `SECP${digits(4)}`),
    phone: Array.from({ length: 4 }, () => `+923${digits(9)}`),
  }
}
function randomKeys(r: Rand, p: Pools, density = 0.3): Keys {
  const keys: Keys = {}
  if (chance(r, density)) keys.cnic = pick(r, p.cnic)
  if (chance(r, density / 2)) keys.ntn = pick(r, p.ntn)
  if (chance(r, density / 3)) keys.secp = pick(r, p.secp)
  if (chance(r, density)) keys.phone = pick(r, p.phone)
  return keys
}

type Seeded = { firmId: string; clients: Array<{ id: string; data: DocumentData }>; names: string[]; pools: Pools }

/** Seeds one random registry for `firmId` (and the shadow firm's copies) in one batch. */
function seedRegistry(r: Rand, batch: WriteBatch, firmId: string, shadowFirmId: string): Seeded {
  const db = adminDb()
  const p = pools(r)
  const entities = Array.from({ length: int(r, 2, 6) }, (_, k) => `${firmId}-e${k}`)
  const names: string[] = []
  const nameFor = () => {
    const name = names.length > 0 && chance(r, 0.35) ? variant(r, pick(r, names)) : freshName(r)
    names.push(name)
    return name
  }
  const shadow = (ref: DocumentReference, data: DocumentData) => {
    batch.set(ref, data)
    // The shadow firm holds a copy with the same names, keys and entity ids: neither path may read it.
    if (chance(r, 0.3)) batch.set(db.collection(ref.parent.id).doc(), { ...data, firmId: shadowFirmId })
  }

  const flags = [undefined, { L17_2_ENABLED: true }, { L17_2_ENABLED: false }, "malformed"]
  const featureFlags = pick(r, flags)
  batch.set(db.collection("firms").doc(firmId), { name: "F37 recall firm", plan: "internal", ...(featureFlags !== undefined ? { featureFlags } : {}) })

  const clients: Seeded["clients"] = []
  const matterIds: string[] = []
  for (let i = 0, n = int(r, 3, 10); i < n; i++) {
    const ref = db.collection("clients").doc()
    const keys = randomKeys(r, p)
    const data: DocumentData = {
      firmId,
      clientCode: `SKD-2099-${i}`,
      canonicalName: chance(r, 0.04) ? 42 : nameFor(),
      ...(chance(r, 0.85) ? { entityId: chance(r, 0.6) ? pick(r, entities) : `${ref.id}-own` } : chance(r, 0.5) ? { entityId: "" } : {}),
      ...(keys.cnic ? { cnic: keys.cnic } : {}),
      ...(keys.ntn ? { ntn: keys.ntn } : {}),
      ...(keys.secp ? { secpNumber: keys.secp } : {}),
      ...(keys.phone ? { primaryMobile: keys.phone } : chance(r, 0.1) ? { primaryMobile: "" } : {}),
      ...(pick(r, LABELS) !== undefined ? { classification: pick(r, LABELS.filter((l) => l !== undefined)) } : {}),
      type: "individual",
    }
    shadow(ref, data)
    clients.push({ id: ref.id, data })
    for (let m = 0, mn = int(r, 0, 2); m < mn; m++) {
      const mref = db.collection("matters").doc()
      const label = pick(r, LABELS)
      batch.set(mref, {
        firmId,
        clientId: ref.id,
        ...(chance(r, 0.9) ? { matterNo: `NHS/2099/${i}${m}` } : {}),
        status: pick(r, ["live", "closed", "engagement_unconfirmed"]),
        ...(label !== undefined ? { classification: label } : {}),
        stage: "pre_filing",
      })
      matterIds.push(mref.id)
    }
  }
  // A matter of a client that is not in the registry, and another firm's matter.
  const orphan = db.collection("matters").doc()
  batch.set(orphan, { firmId, clientId: "no-such-client", matterNo: "NHS/2099/X", status: "live", classification: "confidential" })
  matterIds.push(orphan.id)
  const foreign = db.collection("matters").doc()
  batch.set(foreign, { firmId: shadowFirmId, clientId: "x", matterNo: "OTHER/2099/1", status: "live", classification: "public" })

  for (let i = 0, n = int(r, 2, 10); i < n; i++) {
    const keys = randomKeys(r, p)
    const matterChoice = r()
    const matterId =
      matterChoice < 0.6 && matterIds.length > 0 ? pick(r, matterIds) : matterChoice < 0.7 ? null : matterChoice < 0.8 ? foreign.id : matterChoice < 0.9 ? "missing-matter" : "bad/id"
    const label = pick(r, LABELS)
    shadow(db.collection("matter_parties").doc(), {
      firmId,
      matterId,
      role: chance(r, 0.88) ? "opposing" : "client",
      name: chance(r, 0.04) ? null : nameFor(),
      keys: chance(r, 0.05) ? { cnic: 7 } : keys,
      ...(chance(r, 0.5) ? { entityId: pick(r, entities) } : chance(r, 0.2) ? { entityId: "" } : {}),
      ...(chance(r, 0.6) ? { matterClassification: pick(r, LABELS.filter((l) => l !== undefined)) } : {}),
      ...(chance(r, 0.5) ? { matterStatus: pick(r, ["live", "closed"]) } : {}),
      ...(label !== undefined ? { classification: label } : {}),
    })
  }

  for (let i = 0, n = int(r, 0, 7); i < n; i++) {
    const [a, b] = [pick(r, entities), pick(r, entities)].sort()
    const created = r()
    shadow(db.collection("entity_links").doc(), {
      firmId,
      leftId: chance(r, 0.03) ? 9 : a,
      rightId: b,
      key: chance(r, 0.05) ? "email" : pick(r, ["cnic", "ntn", "secp", "phone"]),
      state: pick(r, ["candidate", "candidate", "candidate", "confirmed", "rejected", "bogus"]),
      ...(chance(r, 0.85) ? { disputed: chance(r, 0.25) } : {}),
      ...(created < 0.45 ? { createdAt: Timestamp.fromMillis(NOW.getTime() - 40 * DAY) } : created < 0.9 ? { createdAt: Timestamp.fromMillis(NOW.getTime() - 2 * DAY) } : {}),
      ...(chance(r, 0.08) ? { unmerge: { status: "in_progress" } } : {}),
      classification: "internal",
    })
  }

  for (const [script, roman] of Object.entries(FIRM_MAP_SPELLINGS)) {
    if (chance(r, 0.4)) batch.set(db.collection("transliteration_map").doc(), { firmId, script, roman, classification: "internal" })
  }
  return { firmId, clients, names, pools: p }
}

type SubjectSet = { subjects: Subject[]; entityIds: (string | undefined)[] }

function subjectSet(r: Rand, s: Seeded): SubjectSet {
  const named = s.clients.filter((c) => typeof c.data.canonicalName === "string")
  const nameish = () => (s.names.length > 0 && chance(r, 0.7) ? (chance(r, 0.5) ? pick(r, s.names) : variant(r, pick(r, s.names))) : freshName(r))
  let first: Subject
  let firstEntity: string | undefined
  if (named.length > 0 && chance(r, 0.5)) {
    const c = pick(r, named)
    first = { role: "client", name: c.data.canonicalName as string, keys: clientKeys(c.data), clientId: c.id }
    firstEntity = typeof c.data.entityId === "string" && c.data.entityId !== "" ? c.data.entityId : undefined
  } else {
    first = { role: "client", name: nameish(), keys: randomKeys(r, s.pools, 0.25) }
  }
  const opposing: Subject[] = Array.from({ length: int(r, 1, 4) }, () => ({ role: "opposing" as const, name: nameish(), keys: randomKeys(r, s.pools, 0.25) }))
  return { subjects: [first, ...opposing], entityIds: [firstEntity, ...opposing.map(() => undefined)] }
}

const ARABIC = /[؀-ۿ]/
const tokensOf = (name: string): Set<string> => new Set(nameForms(name).flat())

type Stats = { registries: number; sets: number; hits: number; nonNone: number; byKey: number; byName: number; nameNoSharedToken: number; urdu: number; relied: number; unresolved: number }

function tally(stats: Stats, result: EngineResult, set: SubjectSet): void {
  stats.sets += 1
  for (const h of result.hits as Hit[]) {
    stats.hits += 1
    if (h.outcome !== "NONE") stats.nonNone += 1
    if (h.basis === "key") stats.byKey += 1
    else {
      stats.byName += 1
      const subjectTokens = tokensOf(set.subjects[h.subjectIndex].name)
      if (![...tokensOf(h.matchedName)].some((t) => subjectTokens.has(t))) stats.nameNoSharedToken += 1
    }
    if (ARABIC.test(h.matchedName) || ARABIC.test(set.subjects[h.subjectIndex].name)) stats.urdu += 1
    if (h.reliedOnLinkIds.length > 0) stats.relied += 1
    if ((h.unresolvedLinkIds ?? []).length > 0) stats.unresolved += 1
  }
}

describe.skipIf(!EMULATORS)("F37 recall: the candidate loader's screen equals the full scan's (differential, randomised registries)", () => {
  it(`Part 1: ${REGISTRIES} registries seeded out of band and reconciled, ${SUBJECT_SETS} subject sets each: identical EngineResult`, async () => {
    const stats: Stats = { registries: 0, sets: 0, hits: 0, nonNone: 0, byKey: 0, byName: 0, nameNoSharedToken: 0, urdu: 0, relied: 0, unresolved: 0 }
    const mismatches: string[] = []
    const r = prng(0xf37f37)
    for (let i = 0; i < REGISTRIES; i++) {
      const firmId = uniq(`f37r${i}`)
      const batch = adminDb().batch()
      const seeded = seedRegistry(r, batch, firmId, uniq(`f37shadow${i}`))
      await batch.commit()
      await reconcileNameIndex(firmId)
      stats.registries += 1
      const oracleRegistry = await loadRegistry(firmId, NOW)
      for (let k = 0; k < SUBJECT_SETS; k++) {
        const set = subjectSet(r, seeded)
        const oracle = runEngine(oracleRegistry, set.subjects, set.entityIds)
        const load = await loadScreeningRegistry(firmId, set.subjects, set.entityIds, NOW)
        const indexed = runEngine(load.registry, set.subjects, set.entityIds)
        if (JSON.stringify(indexed) !== JSON.stringify(oracle)) mismatches.push(`registry ${i} set ${k}`)
        expect(indexed).toEqual(oracle)
        tally(stats, oracle, set)
      }
    }
    console.log(`F37 recall Part 1: ${JSON.stringify(stats)} mismatches=${mismatches.length}`)
    expect(mismatches).toEqual([])
    // The registries exercise every path the proof covers.
    expect(stats.byName).toBeGreaterThan(100)
    expect(stats.nameNoSharedToken).toBeGreaterThan(10)
    expect(stats.byKey).toBeGreaterThan(100)
    expect(stats.urdu).toBeGreaterThan(20)
    expect(stats.relied).toBeGreaterThan(5)
    expect(stats.unresolved).toBeGreaterThan(20)
  }, 1_800_000)

  it("the comparison has teeth: a name missing from a current index loses exactly the hits that name produced", async () => {
    const r = prng(0x7ee7)
    let probed = 0
    /** Whether the hit's candidate row is reachable only through the name tier: no key equal to a subject's, not the subject client's entity. */
    const nameOnly = async (h: Hit, firmId: string, set: SubjectSet): Promise<boolean> => {
      const [kind, id] = String(h.candidateId).split(":")
      const row = (await adminDb().collection(kind === "client" ? "clients" : "matter_parties").doc(id).get()).data()
      if (!row || row.firmId !== firmId) return false
      const keys: Keys = kind === "client" ? clientKeys(row) : ((row.keys ?? {}) as Keys)
      const subjectKeys = new Set(set.subjects.flatMap((s) => Object.entries(s.keys).map(([k, v]) => `${k}=${v}`)))
      if (Object.entries(keys).some(([k, v]) => typeof v === "string" && v !== "" && subjectKeys.has(`${k}=${v}`))) return false
      return !set.entityIds.some((e) => e !== undefined && e === row.entityId)
    }
    for (let i = 0; i < 80 && probed < 5; i++) {
      const firmId = uniq(`f37t${i}`)
      const batch = adminDb().batch()
      const seeded = seedRegistry(r, batch, firmId, uniq(`f37tshadow${i}`))
      await batch.commit()
      await reconcileNameIndex(firmId)
      const set = subjectSet(r, seeded)
      const oracle = runEngine(await loadRegistry(firmId, NOW), set.subjects, set.entityIds)
      let nameHit: Hit | undefined
      for (const h of oracle.hits as Hit[]) {
        if (h.basis !== "name") continue
        // Every row carrying the name must be reachable only by name, so removing the name must lose them.
        const carriers = (oracle.hits as Hit[]).filter((x) => x.matchedName === h.matchedName)
        if ((await Promise.all(carriers.map((x) => nameOnly(x, firmId, set)))).every(Boolean)) {
          nameHit = h
          break
        }
      }
      if (!nameHit) continue
      // Remove that name from the index behind the state's back (the state still reads current).
      const state = await readRegistryState(firmId)
      for (let n = 0; n <= state.nameIndex.chunk; n++) {
        await nameIndexChunkRef(firmId, n).set({ names: FieldValue.arrayRemove(nameHit.matchedName) }, { merge: true })
      }
      expect((await readIndexedNames(firmId, await readRegistryState(firmId))).has(nameHit.matchedName)).toBe(false)
      const indexed = runEngine((await loadScreeningRegistry(firmId, set.subjects, set.entityIds, NOW)).registry, set.subjects, set.entityIds)
      expect(indexed).not.toEqual(oracle)
      const lost = (oracle.hits as Hit[]).filter((h) => !(indexed.hits as Hit[]).some((x) => JSON.stringify(x) === JSON.stringify(h)))
      expect(lost.length).toBeGreaterThan(0)
      for (const h of lost) expect(h).toMatchObject({ basis: "name", matchedName: nameHit.matchedName })
      probed += 1
    }
    expect(probed).toBe(5)
  }, 600_000)
})

// ---------------------------------------------------------------------------
// Part 2: registries built only through the real writers (registerClient, runConflictCheck, openMatter), no reconciliation.
// ---------------------------------------------------------------------------

type Check = { checkId: string; result: string }
const registerClient = viaApi<{ clientId: string; entityId: string }>("registerClient")
const runCheck = viaApi<Check>("runConflictCheck")
const openMatter = viaApi<{ matterId: string }>("openMatter")

describe.skipIf(!EMULATORS)("F37 recall through the real writers (no reconciliation)", () => {
  it("6 firms built by registrations and matter openings: the index the writers kept gives the full scan's screen", async () => {
    const r = prng(0xf37a11)
    let compared = 0
    let nameHits = 0
    for (let f = 0; f < 6; f++) {
      const firmId = uniq(`f37w${f}`)
      await adminDb().collection("firms").doc(firmId).set({ name: "F37 writer firm", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
      const partner = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
      const p = pools(r)
      const names: string[] = []
      const clientIds: string[] = []
      for (let i = 0; i < 6; i++) {
        const name = names.length > 0 && chance(r, 0.4) ? variant(r, pick(r, names)) : freshName(r)
        names.push(name)
        const phone = `0300${String(1000000 + f * 100 + i)}`
        const keys = chance(r, 0.3) ? { cnic: pick(r, p.cnic) } : {}
        const c = await registerClient({ token: partner.token, data: { firmId, name, type: "individual", primaryMobile: phone, classification: "internal", ...keys } } as never)
        clientIds.push(c.clientId)
      }
      // Matters opened on CLEAR checks against fresh opposing names: their parties join the index through openMatter.
      for (let i = 0; i < 3; i++) {
        const opposingName = `${syllables(r)} ${syllables(r)}`
        const check = await runCheck({ token: partner.token, data: { firmId, client: { clientId: clientIds[i] }, opposingParties: [{ name: opposingName }] } } as never)
        if (check.result !== "CLEAR") continue
        await openMatter({ token: partner.token, data: { firmId, conflictCheckId: check.checkId, title: "Suit", classification: "confidential" } } as never)
        names.push(opposingName)
      }
      const state = await readRegistryState(firmId)
      expect(state.nameIndex).toMatchObject({ schema: 1, version: state.version })
      const registered = await adminDb().collection("clients").where("firmId", "==", firmId).get()
      const seeded: Seeded = { firmId, clients: registered.docs.map((d) => ({ id: d.id, data: d.data() })), names, pools: p }
      for (let k = 0; k < 6; k++) {
        const set = subjectSet(r, seeded)
        const oracle = runEngine(await loadRegistry(firmId, NOW), set.subjects, set.entityIds)
        const indexed = runEngine((await loadScreeningRegistry(firmId, set.subjects, set.entityIds, NOW)).registry, set.subjects, set.entityIds)
        expect(indexed).toEqual(oracle)
        compared += 1
        nameHits += (oracle.hits as Hit[]).filter((h) => h.basis === "name").length
      }
    }
    console.log(`F37 recall Part 2 (real writers): ${compared} subject sets compared, ${nameHits} name hits`)
    expect(compared).toBe(36)
    expect(nameHits).toBeGreaterThan(5)
  }, 900_000)
})
