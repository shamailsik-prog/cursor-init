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

/** N clients, each with one live matter and one opposing party on it, written in batches of 450 rows. */
async function seedRegistry(firmId: string, n: number): Promise<void> {
  const db = adminDb()
  const rand = prng(0xf37 + n)
  let batch = db.batch()
  let staged = 0
  const flush = async (force = false) => {
    if (staged >= 450 || (force && staged > 0)) {
      await batch.commit()
      batch = db.batch()
      staged = 0
    }
  }
  for (let i = 0; i < n; i++) {
    const clientRef = db.collection("clients").doc()
    const matterRef = db.collection("matters").doc()
    batch.set(clientRef, {
      firmId,
      clientCode: `SKD-2099-${String(i + 1).padStart(5, "0")}`,
      entityId: `ent-${clientRef.id}`,
      canonicalName: fillerName(rand),
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
      name: fillerName(rand),
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
}

/** The production reconciliation, when this tree has the projection (F37); null on a tree without it. */
async function reconciler(): Promise<((firmId: string, nowMs: number) => Promise<unknown>) | null> {
  try {
    const mod = (await import("../src/d1/conflict/nameIndex")) as { reconcileNameIndex?: (firmId: string, nowMs: number) => Promise<unknown> }
    return mod.reconcileNameIndex ?? null
  } catch {
    return null
  }
}

type Measure = { n: number; registryRows: number; check: ReadCount; open: ReadCount }

async function measure(n: number): Promise<Measure> {
  const firmId = uniq("f37firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F37 synthetic firm", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
  await seedRegistry(firmId, n)
  const reconcile = await reconciler()
  if (reconcile) await reconcile(firmId, Date.now())
  const partner = await mintIdToken(claims(firmId, "partner"))
  const client = await registerClient({
    token: partner.token,
    data: { firmId, name: "Tariq Zarvani", type: "individual", primaryMobile: "03019990001", classification: "internal" },
  } as never)
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
