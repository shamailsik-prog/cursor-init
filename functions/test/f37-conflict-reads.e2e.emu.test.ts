import { describe, expect, it } from "vitest"
import { Timestamp } from "firebase-admin/firestore"
import { adminDb } from "../src/admin"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { viaApi } from "./api"
import { countReads, type ReadCount } from "./readCounter"

/**
 * Audit F37 (HIGH): conflict screening read the firm's whole registry on every check and again at every
 * matter opening. This suite drives the real flow (P5 auth, the HTTP router): registerClient →
 * runConflictCheck → openMatter, against a firm whose registry already holds N synthetic clients, each
 * with one live matter and one opposing party (3N registry rows), and counts the Firestore document reads
 * of each call with the counting wrapper in ./readCounter.ts (a test-time patch of the Admin client that
 * counts what Firestore bills).
 *
 * The registry rows are seeded with the Admin SDK (a firm migrating onto the projection); the production
 * reconciliation (`reconcileNameIndex`, what the daily `d1.conflict.reindex` run and the deploy backfill
 * execute) then builds the name index. On a tree without the projection the import fails and the
 * screen falls back to its old full read, which is the RED baseline.
 *
 * Synthetic data only: random syllable names that match neither subject.
 */

type Check = { checkId: string; result: string; decision: string; hits: unknown[] }

const registerClient = viaApi<{ clientId: string; entityId: string }>("registerClient")
const runCheck = viaApi<Check>("runConflictCheck")
const openMatter = viaApi<{ matterId: string; matterNo: string }>("openMatter")

const claims = (firmId: string, role: string) => ({ firmId, role, clearanceLevel: "privileged-restricted" })

/** mulberry32: a small deterministic PRNG, so every run seeds the same registry. */
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

const CONS = "bdfgjklmnprstvz"
const VOWS = "aeiou"
/** A 6-letter syllable token (CVCVCV); never a token of either subject. */
function token(rand: () => number): string {
  let s = ""
  for (let i = 0; i < 3; i++) s += CONS[Math.floor(rand() * CONS.length)] + VOWS[Math.floor(rand() * VOWS.length)]
  return s
}
const titled = (t: string) => t[0].toUpperCase() + t.slice(1)
const fillerName = (rand: () => number) => `${titled(token(rand))} ${titled(token(rand))}`

/** N clients, each with one live matter and one opposing party on it, written in batches of 450 rows. Returns the names written. */
async function seedRegistry(firmId: string, n: number): Promise<Set<string>> {
  const db = adminDb()
  const rand = prng(0xf37 + n)
  const names = new Set<string>()
  let batch = db.batch()
  let staged = 0
  const flush = async (force = false) => {
    if (staged >= 450 || (force && staged > 0)) {
      await batch.commit()
      batch = db.batch()
      staged = 0
    }
  }
  const note = (name: string) => {
    names.add(name)
    return name
  }
  for (let i = 0; i < n; i++) {
    const clientRef = db.collection("clients").doc()
    const matterRef = db.collection("matters").doc()
    batch.set(clientRef, {
      firmId,
      clientCode: `SKD-2099-${String(i + 1).padStart(5, "0")}`,
      entityId: `ent-${clientRef.id}`,
      canonicalName: note(fillerName(rand)),
      type: "individual",
      primaryMobile: `+92399${String(1000000 + i).padStart(7, "0")}`,
      classification: "internal",
      createdBy: "seed",
      createdAt: Timestamp.now(),
    })
    batch.set(matterRef, {
      firmId,
      clientId: clientRef.id,
      matterNo: `NHS/2099/${String(i + 1).padStart(5, "0")}`,
      title: "Synthetic matter",
      stage: "pre_filing",
      status: "live",
      conflictCheckId: "seeded",
      classification: "confidential",
      createdAt: Timestamp.now(),
    })
    batch.set(db.collection("matter_parties").doc(), {
      firmId,
      matterId: matterRef.id,
      role: "opposing",
      name: note(fillerName(rand)),
      keys: {},
      matterClassification: "confidential",
      matterStatus: "live",
      classification: "confidential",
      createdAt: Timestamp.now(),
    })
    staged += 3
    await flush()
  }
  await flush(true)
  return names
}

type NameIndexModule = {
  reconcileNameIndex(firmId: string): Promise<unknown>
  readIndexedNames(firmId: string): Promise<{ names: Set<string> }>
}

/** The production reconciliation and index reader, when this tree has the projection (F37); null on a tree without it. */
async function projection(): Promise<{ index: NameIndexModule } | null> {
  try {
    const index = (await import("../src/d1/conflict/nameIndex")) as unknown as NameIndexModule
    return typeof index.reconcileNameIndex === "function" ? { index } : null
  } catch {
    return null
  }
}

type Measure = { n: number; registryRows: number; check: ReadCount; open: ReadCount }

/** Builds the name index the way production does (the reconciliation) and checks it holds every seeded name; a no-op without the projection. */
async function reconcile(firmId: string, seeded: Set<string>): Promise<void> {
  const p = await projection()
  if (!p) return
  await p.index.reconcileNameIndex(firmId)
  // The index really holds the registry: every seeded name, so the screen's flat reads are not an empty index's.
  const indexed = (await p.index.readIndexedNames(firmId)).names
  expect([...seeded].filter((name) => !indexed.has(name))).toEqual([])
}

/** A firm with N filler clients (3N registry rows), its name index built, and a partner who registers the subject client. */
async function seedFirm(n: number) {
  const firmId = uniq("f37firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F37 synthetic firm", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
  const seeded = await seedRegistry(firmId, n)
  await reconcile(firmId, seeded)
  const partner = await mintIdToken(claims(firmId, "partner"))
  const client = await registerClient({
    token: partner.token,
    data: { firmId, name: "Tariq Zarvani", type: "individual", primaryMobile: "03019990001", classification: "internal" },
  } as never)
  seeded.add("Tariq Zarvani")
  return { firmId, partner, client, seeded }
}

async function measure(n: number): Promise<Measure> {
  const { firmId, partner, client, seeded } = await seedFirm(n)
  const p = await projection()
  if (p) {
    const indexed = (await p.index.readIndexedNames(firmId)).names
    expect(indexed.size).toBe(seeded.size)
  }
  const check = await countReads(() =>
    runCheck({ token: partner.token, data: { firmId, client: { clientId: client.clientId }, opposingParties: [{ name: "Haris Qalbani" }] } } as never)
  )
  // The filler matches neither subject, so the check is CLEAR and the screen's candidate set is the same at every N.
  expect(check.result).toMatchObject({ result: "CLEAR", decision: "cleared" })
  const open = await countReads(() =>
    openMatter({ token: partner.token, data: { firmId, conflictCheckId: check.result.checkId, title: "Recovery suit", classification: "confidential" } } as never)
  )
  expect(open.result.matterNo).toMatch(/^NHS\/\d{4}\/0001$/)
  return { n, registryRows: 3 * n, check: check.reads, open: open.reads }
}

/** Reads one openMatter may make, whatever the registry size: the screen's keys and candidates, the gate, the transaction and the audit. */
const OPEN_READ_BUDGET = 150

describe.skipIf(!EMULATORS)("F37: conflict screening reads are bounded by the candidates, not the registry", () => {
  it("openMatter (and the check before it) reads the same small number of documents at N = 500 and N = 2,000 firm clients", async () => {
    const small = await measure(500)
    const large = await measure(2000)
    // The evidence log records these lines.
    for (const m of [small, large]) {
      console.log(`F37 reads N=${m.n} (registry rows ${m.registryRows}): runConflictCheck ${m.check.total} ${JSON.stringify(m.check.byCollection)}`)
      console.log(`F37 reads N=${m.n} (registry rows ${m.registryRows}): openMatter ${m.open.total} ${JSON.stringify(m.open.byCollection)}`)
    }
    expect(large.open.total).toBeLessThanOrEqual(OPEN_READ_BUDGET)
    expect(large.check.total).toBeLessThanOrEqual(OPEN_READ_BUDGET)
    // Flat in N: quadrupling the registry adds no reads beyond noise in the fixed overhead.
    expect(large.open.total - small.open.total).toBeLessThanOrEqual(2)
    expect(large.check.total - small.check.total).toBeLessThanOrEqual(2)
  }, 600_000)
})

/**
 * K distinct names the 0.80 token-set rule matches to the opposing subject ("Haris Qalbani"): the subject's tokens plus
 * one more (a subset scores 1.0). Distinct names put more than 30 values in the name tier's `in` list too (F37
 * re-audit FA-D1C-006, mutant M05). None shares a key or an entity with the subject.
 */
function candidateNames(k: number): string[] {
  const rand = prng(0xca7)
  const out = new Set<string>()
  while (out.size < k) out.add(`Haris Qalbani ${titled(token(rand))}`)
  return [...out]
}

/** K clients the screen must hit (each with one live matter), written out of band; returns each name's matter id. */
async function seedCandidates(firmId: string, k: number): Promise<Map<string, string>> {
  const db = adminDb()
  const batch = db.batch()
  const matterOf = new Map<string, string>()
  candidateNames(k).forEach((name, i) => {
    const clientRef = db.collection("clients").doc()
    const matterRef = db.collection("matters").doc()
    matterOf.set(name, matterRef.id)
    batch.set(clientRef, {
      firmId,
      clientCode: `SKD-2099-${String(90000 + i)}`,
      entityId: `ent-${clientRef.id}`,
      canonicalName: name,
      type: "individual",
      primaryMobile: `+92398${String(1000000 + i).padStart(7, "0")}`,
      classification: "internal",
      createdBy: "seed",
      createdAt: Timestamp.now(),
    })
    batch.set(matterRef, {
      firmId,
      clientId: clientRef.id,
      matterNo: `NHS/2099/${String(90000 + i)}`,
      title: "Synthetic matter",
      stage: "pre_filing",
      status: "live",
      conflictCheckId: "seeded",
      classification: "confidential",
      createdAt: Timestamp.now(),
    })
  })
  await batch.commit()
  return matterOf
}

/** True candidates per firm: more than one `in` list (30) for the name tier, the matters and the links. */
const K = 40

type CandidateMeasure = { n: number; without: ReadCount; withK: ReadCount; hits: number }

async function measureCandidates(n: number): Promise<CandidateMeasure> {
  const { firmId, partner, client, seeded } = await seedFirm(n)
  const screen = () =>
    countReads(() =>
      runCheck({ token: partner.token, data: { firmId, client: { clientId: client.clientId }, opposingParties: [{ name: "Haris Qalbani" }] } } as never)
    )
  const without = await screen()
  // CLEAR, though not hit-free: the registered client subject meets its own record (a NONE hit).
  expect(without.result).toMatchObject({ result: "CLEAR", decision: "cleared" })
  const matterOf = await seedCandidates(firmId, K)
  expect(candidateHits(without.result, matterOf)).toBe(0)
  for (const name of matterOf.keys()) seeded.add(name)
  await reconcile(firmId, seeded)
  const withK = await screen()
  return { n, without: without.reads, withK: withK.reads, hits: candidateHits(withK.result, matterOf) }
}

/**
 * The check's hits on the seeded candidates: a hit counts only when its name is a seeded candidate's and its matter id
 * is that candidate's own matter (the partner, cleared above the matters' label, is shown it), so a candidate fetched
 * without its matter, or not fetched at all, is missing from the count.
 */
const candidateHits = (check: Check, matterOf: ReadonlyMap<string, string>): number =>
  new Set(
    (check.hits as Array<{ matchedName?: unknown; matterId?: unknown }>)
      .filter((h) => typeof h.matchedName === "string" && matterOf.get(h.matchedName) === h.matterId)
      .map((h) => String(h.matchedName))
  ).size

describe.skipIf(!EMULATORS)("F37: a screen's reads grow with its true candidates, not with the registry", () => {
  it(`K = ${K} clients matching the opposing party: every one is a hit, and the reads they add are bounded by K at N = 500 and N = 2,000`, async () => {
    const small = await measureCandidates(500)
    const large = await measureCandidates(2000)
    for (const m of [small, large]) {
      console.log(
        `F37 reads N=${m.n} K=0: runConflictCheck ${m.without.total}; K=${K}: runConflictCheck ${m.withK.total} hits ${m.hits} ${JSON.stringify(m.withK.byCollection)}`
      )
    }
    for (const m of [small, large]) {
      // Recall through the real flow: every true candidate is found (one hit each).
      expect(m.hits).toBe(K)
      // The added reads are per candidate: its client and its matter (the screen), and the caller's membership of
      // that matter (disclosure of the hit), 3 per candidate, plus at most one query per 30 values for the name tier,
      // the matters and each side of the links; never a read per registry row.
      expect(m.withK.total - m.without.total).toBeGreaterThanOrEqual(K)
      expect(m.withK.total - m.without.total).toBeLessThanOrEqual(3 * K + 3 * Math.ceil(K / 30) + 2)
    }
    // Flat in N with candidates present: quadrupling the registry adds no reads beyond noise in the fixed overhead.
    expect(large.withK.total - small.withK.total).toBeLessThanOrEqual(2)
    expect(large.withK.total).toBeLessThanOrEqual(OPEN_READ_BUDGET)
  }, 600_000)
})
