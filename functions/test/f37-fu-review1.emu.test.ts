import { afterAll, describe, expect, it } from "vitest"
import { FieldValue, type DocumentData } from "firebase-admin/firestore"
import { adminDb } from "../src/admin"
import { nameIndexChunkRef, reconcileNameIndex } from "../src/d1/conflict/nameIndex"
import { NAME_REINDEX_JOB_TYPE } from "../src/d1/conflict/reindexJob"
import { readRegistryState, registryVersionRef } from "../src/d1/registryVersion"
import { runJobTask } from "../src/p2/worker"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { ApiError, apiErrorOf, expectKind, viaApi } from "./api"
import { deleteFirmData } from "./firmCleanup"
import { FakeClock, readJob, testDeps } from "./jobs"

/**
 * F37 follow-up, PR #89 review round 1, through the real routes on the emulator:
 *
 * - Codex P2 (thread 4307586920): a registry trigger event delivered again, or a second out-of-band write in the same
 *   PKT minute, after that minute's reindex has run, must not leave the firm refusing every screen with no rebuild
 *   queued. The triggers are delivered here in process, as the platform delivers them (event id and time included).
 * - Bugbot (thread 4307596183): another firm whose id is this firm's id plus `_{digits}` must not crowd this firm's
 *   chunks out of the screen's read (a valid index refused, or a chunk beyond the pointer left unread: CLEAR).
 * - Bugbot (thread 4307596177): a malformed `nameIndexGen` must heal at the next reindex, not keep the firm at 503.
 *
 * Synthetic data only; every document a test creates is deleted afterwards.
 */

type Check = { checkId: string; result: string; hits: Array<Record<string, unknown>> }
const registerClient = viaApi<{ clientId: string; entityId: string }>("registerClient")
const runCheck = viaApi<Check>("runConflictCheck")

const SUBJECT = "Tariq Zarvani"
const CONFLICT = "Haris Qalbani"
const SECOND = "Waqas Kharal"

let mobileSeq = 0
const nextMobile = () => `0307${String(3000000 + ++mobileSeq)}`

const created = { firms: [] as string[], uids: [] as string[] }
afterAll(async () => {
  if (EMULATORS) await deleteFirmData(created.firms, created.uids)
}, 600_000)

type Firm = { firmId: string; token: string; clientId: string; clients: Record<string, string> }

async function registeredFirm(names: readonly string[] = []): Promise<Firm> {
  const firmId = uniq("f37r1")
  created.firms.push(firmId)
  await adminDb().collection("firms").doc(firmId).set({ name: "F37 review firm", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
  const partner = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
  created.uids.push(partner.uid)
  const clients: Record<string, string> = {}
  for (const name of [SUBJECT, ...names]) {
    const c = await registerClient({ token: partner.token, data: { firmId, name, type: "individual", primaryMobile: nextMobile(), classification: "internal" } } as never)
    clients[name] = c.clientId
  }
  return { firmId, token: partner.token, clientId: clients[SUBJECT], clients }
}

/** The subject client against an opposing party `name`: a hit when `name` is one of the firm's clients. */
const screen = (f: Firm, name = CONFLICT) =>
  runCheck({ token: f.token, data: { firmId: f.firmId, client: { clientId: f.clientId }, opposingParties: [{ name }] } } as never)
const hits = (c: Check, name = CONFLICT) => c.hits.some((h) => h.matchedName === name && h.outcome !== "NONE")
/** What the screen answers: `HIT`, `CLEAR` (no hit on `name`) or the refusal. */
async function outcome(f: Firm, name = CONFLICT): Promise<string> {
  try {
    return hits(await screen(f, name), name) ? "HIT" : "CLEAR"
  } catch (err) {
    if (err instanceof ApiError) return `${err.status} ${err.code}`
    throw err
  }
}

const reindexJobs = async (firmId: string) =>
  (await adminDb().collection("jobs").where("firmId", "==", firmId).get()).docs.filter((d) => d.data().jobType === NAME_REINDEX_JOB_TYPE)
/** The firm's reindex jobs that have yet to run to the end (queued, running, or failed and due a retry). */
const pendingReindexJobs = async (firmId: string) => (await reindexJobs(firmId)).filter((d) => ["queued", "running", "failed"].includes(d.data().status))

/** Runs every pending reindex job of the firm through the real P2 worker; returns their outcomes. */
async function runPendingReindexJobs(firmId: string): Promise<string[]> {
  const out: string[] = []
  for (const job of await pendingReindexJobs(firmId)) {
    out.push(await runJobTask({ jobId: job.id, seq: (await readJob(job.id)).dispatchSeq }, testDeps(new FakeClock(Date.now() + 60_000))))
  }
  return out
}

const isCurrent = async (firmId: string) => {
  const s = await readRegistryState(firmId)
  return s.nameIndex.valid && s.nameIndex.schema !== null && s.nameIndex.version === s.version
}

type RowHandler = (collection: string, docId: string, before: DocumentData | undefined, after: DocumentData | undefined, nowMs: number, eventId: string) => Promise<unknown>

/** The client/party trigger handler (it takes the event's id after its time; a tree without dedupe ignores it). */
async function rowHandler(): Promise<RowHandler> {
  const path = "../src/d1/conflict/registryTriggers"
  const m = (await import(/* @vite-ignore */ path)) as { registryRowWritten?: RowHandler }
  expect(typeof m.registryRowWritten).toBe("function")
  return m.registryRowWritten as RowHandler
}

/** A moment 5 s into the current PKT minute: two deliveries at T and T + 2 s share the minute's reindex key. */
const minuteStart = () => Math.floor(Date.now() / 60_000) * 60_000 + 5_000

/** Renames a client out of band; returns the event's before and after data. */
async function renameOutOfBand(f: Firm, from: string, to: string) {
  const ref = adminDb().collection("clients").doc(f.clients[from])
  const before = (await ref.get()).data()
  await ref.update({ canonicalName: to })
  return { id: ref.id, before, after: (await ref.get()).data() }
}

describe.skipIf(!EMULATORS)("PR #89 review (Codex P2, thread 4307586920): every break has a rebuild queued after it", () => {
  it("A1: the same event delivered again after its reindex ran does not break the index again", async () => {
    const f = await registeredFirm(["Zubair Hashmi"])
    const deliver = await rowHandler()
    const T = minuteStart()
    const ev = await renameOutOfBand(f, "Zubair Hashmi", CONFLICT)
    const eventId = `evt-a1-${f.firmId}`
    await deliver("clients", ev.id, ev.before, ev.after, T, eventId)
    expect(await isCurrent(f.firmId)).toBe(false)
    expect(await pendingReindexJobs(f.firmId)).toHaveLength(1)
    expect(await runPendingReindexJobs(f.firmId)).toEqual(["done"])
    expect(await outcome(f)).toBe("HIT")

    // The platform delivers the same event again (at-least-once), in the same minute.
    await deliver("clients", ev.id, ev.before, ev.after, T + 2_000, eventId)
    const current = await isCurrent(f.firmId)
    const pending = (await pendingReindexJobs(f.firmId)).length
    console.log(`F37-FU-R1 A1 after the duplicate: current=${current} pending=${pending}`)
    expect(current).toBe(true)
    expect(await outcome(f)).toBe("HIT")
  }, 180_000)

  it("A2: a second out-of-band write in the same minute, after that minute's reindex ran, gets its own rebuild", async () => {
    const f = await registeredFirm(["Zubair Hashmi", "Omer Daryani"])
    const deliver = await rowHandler()
    const T = minuteStart()
    const first = await renameOutOfBand(f, "Zubair Hashmi", CONFLICT)
    await deliver("clients", first.id, first.before, first.after, T, `evt-a2a-${f.firmId}`)
    expect(await runPendingReindexJobs(f.firmId)).toEqual(["done"])
    expect(await outcome(f)).toBe("HIT")

    const second = await renameOutOfBand(f, "Omer Daryani", SECOND)
    await deliver("clients", second.id, second.before, second.after, T + 2_000, `evt-a2b-${f.firmId}`)
    const pending = (await pendingReindexJobs(f.firmId)).length
    console.log(`F37-FU-R1 A2 after the second break: current=${await isCurrent(f.firmId)} pending=${pending}`)
    expect(pending).toBeGreaterThanOrEqual(1)
    expect(await outcome(f, SECOND)).toBe("503 screening_unavailable")
    expect(await runPendingReindexJobs(f.firmId)).toContain("done")
    expect(await outcome(f, SECOND)).toBe("HIT")
  }, 180_000)

  it("A3: a run that finds the index already current (repaired before it ran) still lets a later break in the minute queue a rebuild", async () => {
    const f = await registeredFirm(["Zubair Hashmi", "Omer Daryani"])
    const deliver = await rowHandler()
    const T = minuteStart()
    const first = await renameOutOfBand(f, "Zubair Hashmi", CONFLICT)
    await deliver("clients", first.id, first.before, first.after, T, `evt-a3a-${f.firmId}`)
    // An operator repairs the index by hand before the queued run: the name appended, the mirror moved to the version.
    await nameIndexChunkRef(f.firmId, 0).update({ names: FieldValue.arrayUnion(CONFLICT) })
    const s = await readRegistryState(f.firmId)
    await registryVersionRef(f.firmId).update({ "nameIndex.version": s.version })
    expect(await isCurrent(f.firmId)).toBe(true)
    expect(await runPendingReindexJobs(f.firmId)).toEqual(["done"])

    const second = await renameOutOfBand(f, "Omer Daryani", SECOND)
    await deliver("clients", second.id, second.before, second.after, T + 2_000, `evt-a3b-${f.firmId}`)
    const pending = (await pendingReindexJobs(f.firmId)).length
    console.log(`F37-FU-R1 A3 after the second break: current=${await isCurrent(f.firmId)} pending=${pending}`)
    expect(pending).toBeGreaterThanOrEqual(1)
    expect(await runPendingReindexJobs(f.firmId)).toContain("done")
    expect(await outcome(f, SECOND)).toBe("HIT")
  }, 180_000)
})

/** Writes `count` chunk documents of the firm `${firmId}_1` (ids `${firmId}_1_{n}`), which sort inside `${firmId}_`'s id range. */
async function crowd(firmId: string, count: number): Promise<string> {
  const other = `${firmId}_1`
  created.firms.push(other)
  const db = adminDb()
  for (let i = 0; i < count; i += 400) {
    const batch = db.batch()
    for (let n = i; n < Math.min(count, i + 400); n++) {
      batch.set(nameIndexChunkRef(other, n), { firmId: other, chunk: n, kind: "conflict_name_index", classification: "privileged-restricted", names: [] })
    }
    await batch.commit()
  }
  return other
}

/** Lays the firm's indexed names out over chunks (`layout[n]` in chunk n), the state pointing at the last one. */
async function layOut(f: Firm, layout: string[][]): Promise<void> {
  const db = adminDb()
  const base = (await nameIndexChunkRef(f.firmId, 0).get()).data() ?? {}
  const batch = db.batch()
  layout.forEach((names, n) => batch.set(nameIndexChunkRef(f.firmId, n), { ...base, firmId: f.firmId, chunk: n, names }))
  const last = layout.length - 1
  batch.update(registryVersionRef(f.firmId), { "nameIndex.chunk": last, "nameIndex.bytes": layout[last].reduce((s, x) => s + Buffer.byteLength(x, "utf8") + 1, 0) })
  await batch.commit()
}

describe.skipIf(!EMULATORS)("PR #89 review (Bugbot, thread 4307596183): another firm's ids never crowd this firm's chunks out of the read", () => {
  it("B1: a valid three-chunk index, with 401 chunks of the firm `{firmId}_1` sorting between its chunk 1 and chunk 2, still screens", async () => {
    const f = await registeredFirm(["Zubair Hashmi", CONFLICT])
    await layOut(f, [[SUBJECT], ["Zubair Hashmi"], [CONFLICT]])
    expect(await outcome(f)).toBe("HIT")
    await crowd(f.firmId, 401)
    const got = await outcome(f)
    console.log(`F37-FU-R1 B1 valid index, crowded: ${got}`)
    expect(got).toBe("HIT")
  }, 300_000)

  it("B2: a chunk beyond the pointer holding the only copy of the conflict, crowded out the same way, is still read (503, not CLEAR)", async () => {
    const f = await registeredFirm([CONFLICT])
    const chunk0 = (await nameIndexChunkRef(f.firmId, 0).get()).data() ?? {}
    await nameIndexChunkRef(f.firmId, 0).update({ names: FieldValue.arrayRemove(CONFLICT) })
    await nameIndexChunkRef(f.firmId, 3).set({ ...chunk0, chunk: 3, names: [CONFLICT] })
    expect(await outcome(f)).toBe("503 screening_unavailable")
    await crowd(f.firmId, 401)
    const got = await outcome(f)
    console.log(`F37-FU-R1 B2 beyond-pointer chunk, crowded: ${got}`)
    expect(got).toBe("503 screening_unavailable")
    expect(await reconcileNameIndex(f.firmId)).toMatchObject({ rebuilt: true, marked: true })
    expect(await outcome(f)).toBe("HIT")
  }, 300_000)
})

describe.skipIf(!EMULATORS)("PR #89 review (Bugbot, thread 4307596177): a malformed nameIndexGen heals at the next reindex", () => {
  for (const [label, bad] of [["a string", "x"], ["a fraction", 1.5], ["a map", { gen: 3 }]] as const) {
    it(`C: nameIndexGen set to ${label} refuses screens until the reindex, which writes a valid generation`, async () => {
      const f = await registeredFirm([CONFLICT])
      expect(await outcome(f)).toBe("HIT")
      await registryVersionRef(f.firmId).update({ nameIndexGen: bad })
      expectKind(await apiErrorOf(screen(f)), "unavailable", "screening_unavailable")
      const run = await reconcileNameIndex(f.firmId).then(
        (r) => JSON.stringify(r),
        (err: unknown) => `threw ${String(err)}`
      )
      const after = (await registryVersionRef(f.firmId).get()).data()?.nameIndexGen
      const got = await outcome(f)
      console.log(`F37-FU-R1 C ${label}: reindex ${run}; nameIndexGen now ${JSON.stringify(after)}; screen ${got}`)
      expect(Number.isInteger(after) && (after as number) > 0).toBe(true)
      expect(got).toBe("HIT")
    }, 180_000)
  }

  it("C2: the generation written over a malformed one is above every generation already stamped, so a row restored with an old stamp is not trusted", async () => {
    const f = await registeredFirm()
    const deliver = await rowHandler()
    const damageAndRebuild = async () => {
      await nameIndexChunkRef(f.firmId, 0).update({ chunk: 7 })
      expect(await reconcileNameIndex(f.firmId)).toMatchObject({ rebuilt: true, marked: true })
    }
    await damageAndRebuild()
    // A client registered after that reset carries its generation; deleted out of band, then a reset drops its name.
    const c = await registerClient({ token: f.token, data: { firmId: f.firmId, name: CONFLICT, type: "individual", primaryMobile: nextMobile(), classification: "internal" } } as never)
    const ref = adminDb().collection("clients").doc(c.clientId)
    const saved = (await ref.get()).data() as DocumentData
    await ref.delete()
    await deliver("clients", ref.id, saved, undefined, Date.now(), `evt-c2a-${f.firmId}`)
    await damageAndRebuild()
    expect(await outcome(f)).toBe("CLEAR")
    // The generation is corrupted, and the reindex heals it.
    await registryVersionRef(f.firmId).update({ nameIndexGen: "x" })
    await reconcileNameIndex(f.firmId)
    const gen = (await registryVersionRef(f.firmId).get()).data()?.nameIndexGen
    console.log(`F37-FU-R1 C2 stamp gen ${JSON.stringify(saved.nameIndexed?.gen)}, healed gen ${JSON.stringify(gen)}`)
    // The row comes back from a backup with its old stamp: it must break the index, not be trusted.
    await ref.set(saved)
    await deliver("clients", ref.id, undefined, saved, Date.now(), `evt-c2b-${f.firmId}`)
    const got = await outcome(f)
    console.log(`F37-FU-R1 C2 after the restore: ${got}`)
    expect(got).toBe("503 screening_unavailable")
    await reconcileNameIndex(f.firmId)
    expect(await outcome(f)).toBe("HIT")
  }, 180_000)

  it("C3: a break landing on a malformed generation also writes one above every stamp, so a row restored with an old stamp is not trusted", async () => {
    const f = await registeredFirm(["Zubair Hashmi"])
    const deliver = await rowHandler()
    const damageAndRebuild = async () => {
      await nameIndexChunkRef(f.firmId, 0).update({ chunk: 7 })
      expect(await reconcileNameIndex(f.firmId)).toMatchObject({ rebuilt: true, marked: true })
    }
    await damageAndRebuild()
    const c = await registerClient({ token: f.token, data: { firmId: f.firmId, name: CONFLICT, type: "individual", primaryMobile: nextMobile(), classification: "internal" } } as never)
    const ref = adminDb().collection("clients").doc(c.clientId)
    const saved = (await ref.get()).data() as DocumentData
    const stamped = saved.nameIndexed?.gen as number
    await ref.delete()
    await deliver("clients", ref.id, saved, undefined, Date.now(), `evt-c3a-${f.firmId}`)
    await damageAndRebuild()
    // The generation is corrupted, and an out-of-band rename breaks the index before any reset rewrites it.
    await registryVersionRef(f.firmId).update({ nameIndexGen: "x" })
    const ev = await renameOutOfBand(f, "Zubair Hashmi", "Omer Daryani")
    await deliver("clients", ev.id, ev.before, ev.after, Date.now(), `evt-c3b-${f.firmId}`)
    const gen = (await registryVersionRef(f.firmId).get()).data()?.nameIndexGen
    console.log(`F37-FU-R1 C3 stamp gen ${stamped}, gen after the break ${JSON.stringify(gen)}`)
    expect(Number.isInteger(gen) && (gen as number) > stamped).toBe(true)
    await reconcileNameIndex(f.firmId)
    await ref.set(saved)
    await deliver("clients", ref.id, undefined, saved, Date.now(), `evt-c3c-${f.firmId}`)
    expect(await outcome(f)).toBe("503 screening_unavailable")
    await reconcileNameIndex(f.firmId)
    expect(await outcome(f)).toBe("HIT")
  }, 180_000)
})
