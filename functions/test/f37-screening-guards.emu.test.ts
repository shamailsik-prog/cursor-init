import { describe, expect, it } from "vitest"
import { FieldValue, Timestamp } from "firebase-admin/firestore"
import { adminDb } from "../src/admin"
import { loadScreeningRegistry } from "../src/d1/conflict/candidates"
import { nameIndexChunkRef, readIndexedNames, reconcileNameIndex, NAME_INDEX_SCHEMA } from "../src/d1/conflict/nameIndex"
import { NAME_REINDEX_JOB_TYPE, nameReindexHandler, pktHourKey, pktMinuteKey } from "../src/d1/conflict/reindexJob"
import { openMatterTestSeam } from "../src/d1/matter/ops"
import { readRegistryState, registryVersionRef } from "../src/d1/registryVersion"
import { jobIdFor } from "../src/p2/enqueue"
import { runJobTask } from "../src/p2/worker"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { apiErrorOf, expectKind, viaApi } from "./api"
import { FakeClock, readJob, testDeps } from "./jobs"
import { registryRecorder } from "./setup/registryWriteRecorder"

/**
 * Audit F37 guards around the candidate loader (spec 2026-10-18-f37 rulings 4 to 7), through the real routes:
 * a missing, stale, other-schema or corrupt name index refuses the screen (503 screening_unavailable, nothing
 * written) and enqueues one reconciliation job, whose run (through the real P2 worker) makes the same call
 * succeed; a registry write racing a matter opening is caught; another firm's rows, keys, entities and chunks
 * are never used; and the loader reads exactly the collections it is meant to.
 */

type Check = { checkId: string; result: string; hits: Array<Record<string, unknown>> }
const registerClient = viaApi<{ clientId: string; entityId: string }>("registerClient")
const runCheck = viaApi<Check>("runConflictCheck")
const openMatter = viaApi<{ matterId: string; matterNo: string }>("openMatter")

const claims = (firmId: string) => ({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
let mobileSeq = 0
const nextMobile = () => `0302${String(4000000 + ++mobileSeq)}`

async function newFirm(): Promise<string> {
  const firmId = uniq("f37g")
  await adminDb().collection("firms").doc(firmId).set({ name: "F37 guard firm", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
  return firmId
}

async function setup() {
  const firmId = await newFirm()
  const partner = await mintIdToken(claims(firmId))
  const client = await registerClient({
    token: partner.token,
    data: { firmId, name: "Tariq Zarvani", type: "individual", primaryMobile: nextMobile(), classification: "internal" },
  } as never)
  return { firmId, partner, client }
}

const check = (token: string, firmId: string, clientId: string, opposingName = "Haris Qalbani") =>
  runCheck({ token, data: { firmId, client: { clientId }, opposingParties: [{ name: opposingName }] } } as never)
const open = (token: string, firmId: string, conflictCheckId: string) =>
  openMatter({ token, data: { firmId, conflictCheckId, title: "Recovery suit", classification: "confidential" } } as never)

const rows = async (collection: string, firmId: string) => (await adminDb().collection(collection).where("firmId", "==", firmId).get()).docs
const reindexJobs = async (firmId: string) => (await rows("jobs", firmId)).filter((d) => d.data().jobType === NAME_REINDEX_JOB_TYPE)
const denyRows = async (uid: string, action: string) =>
  (await adminDb().collection("audit_log").where("actorId", "==", uid).where("action", "==", action).get()).docs.map((d) => d.data()).filter((r) => r.decision === "deny")

/** Runs the firm's enqueued reindex job through the real worker; returns its outcome. */
async function runReindexJob(firmId: string): Promise<string> {
  const [job] = await reindexJobs(firmId)
  expect(job).toBeDefined()
  const clock = new FakeClock(Date.now() + 60_000)
  return runJobTask({ jobId: job.id, seq: (await readJob(job.id)).dispatchSeq }, testDeps(clock))
}

describe.skipIf(!EMULATORS)("F37: an index that cannot be trusted refuses the screen (fail closed) and heals through the job", () => {
  it("missing: rows written out of band in a firm with no index → 503 screening_unavailable, no check, one reindex job; after the job the check hits them", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId))
    await adminDb().collection("clients").add({ firmId, canonicalName: "Haris Qalbani", classification: "internal", type: "individual" })
    const data = { firmId, client: { name: "Bashir Ahmed" }, opposingParties: [{ name: "Haris Qalbani" }] }
    // A burst of refused calls makes one job: the idempotency key is per firm and PKT minute (F37 re-audit; the calls
    // share one clock reading, so the burst cannot straddle a minute).
    const at = Date.now()
    const runCheckAt = viaApi<Check>("runConflictCheck", { now: () => at })
    for (let i = 0; i < 3; i++) expectKind(await apiErrorOf(runCheckAt({ token: partner.token, data } as never)), "unavailable", "screening_unavailable")
    expect(await rows("conflict_checks", firmId)).toHaveLength(0)
    expect((await denyRows(partner.uid, "conflict.run")).map((r) => r.reason)).toEqual(["screening_unavailable", "screening_unavailable", "screening_unavailable"])
    const jobs = await reindexJobs(firmId)
    expect(jobs.map((d) => d.id)).toEqual([jobIdFor(firmId, NAME_REINDEX_JOB_TYPE, `${NAME_REINDEX_JOB_TYPE}:stale:${pktMinuteKey(at)}`)])
    expect(jobs[0].data()).toMatchObject({ createdBy: "system", classification: "internal", matterId: null, status: "queued" })

    expect(await runReindexJob(firmId)).toBe("done")
    const state = await readRegistryState(firmId)
    expect(state.nameIndex).toMatchObject({ schema: NAME_INDEX_SCHEMA, version: state.version })
    const out = await runCheck({ token: partner.token, data } as never)
    expect(out.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    expect(out.hits).toEqual([expect.objectContaining({ subjectIndex: 1, matchedName: "Haris Qalbani", basis: "name" })])
  })

  it("a firm with no counter and no client or opposing party screens on its empty index (no refusal, no job)", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken(claims(firmId))
    const out = await runCheck({ token: partner.token, data: { firmId, client: { name: "Bashir Ahmed" }, opposingParties: [{ name: "Haris Qalbani" }] } } as never)
    expect(out.result).toBe("CLEAR")
    expect(await reindexJobs(firmId)).toHaveLength(0)
    // Its first registration creates the index current.
    await registerClient({ token: partner.token, data: { firmId, name: "Zubair Hashmi", type: "individual", primaryMobile: nextMobile(), classification: "internal" } } as never)
    expect((await readRegistryState(firmId)).nameIndex).toMatchObject({ schema: NAME_INDEX_SCHEMA, version: 1, chunk: 0 })
  })

  it("stale: a registry version moved without the index (an old instance's write) → runConflictCheck and openMatter refuse, nothing written; the job heals it", async () => {
    const { firmId, partner, client } = await setup()
    const cleared = await check(partner.token, firmId, client.clientId)
    expect(cleared.result).toBe("CLEAR")
    // What a pre-F37 instance does during a rolling deploy: bump the version, not the index mirror.
    await registryVersionRef(firmId).set({ version: FieldValue.increment(1) }, { merge: true })
    expectKind(await apiErrorOf(check(partner.token, firmId, client.clientId)), "unavailable", "screening_unavailable")
    expectKind(await apiErrorOf(open(partner.token, firmId, cleared.checkId)), "unavailable", "screening_unavailable")
    expect(await rows("matters", firmId)).toHaveLength(0)
    expect((await adminDb().collection("conflict_checks").doc(cleared.checkId).get()).data()).toMatchObject({ boundMatterId: null, stale: false })
    expect((await denyRows(partner.uid, "matter.open")).map((r) => r.reason)).toEqual(["screening_unavailable"])
    expect(await reindexJobs(firmId)).toHaveLength(1)

    expect(await runReindexJob(firmId)).toBe("done")
    const opened = await open(partner.token, firmId, cleared.checkId)
    expect(opened.matterNo).toMatch(/^NHS\/\d{4}\/0001$/)
  })

  it("another schema → refused until reconciled", async () => {
    const { firmId, partner, client } = await setup()
    await registryVersionRef(firmId).set({ nameIndex: { schema: NAME_INDEX_SCHEMA + 98 } }, { merge: true })
    expectKind(await apiErrorOf(check(partner.token, firmId, client.clientId)), "unavailable", "screening_unavailable")
    await reconcileNameIndex(firmId)
    expect((await check(partner.token, firmId, client.clientId)).result).toBe("CLEAR")
  })

  // PR #80 review: the job rebuilds a damaged index (it used to fail permanently with name_index_corrupt and wait for an
  // operator). f37-index-integrity.emu.test.ts covers every kind of damage through both routes.
  it("corrupt: a malformed chunk, a missing chunk below the pointer, or another firm's chunk → refused; the job rebuilds the index", async () => {
    const a = await setup()
    await nameIndexChunkRef(a.firmId, 0).set({ names: "not-an-array" }, { merge: true })
    expectKind(await apiErrorOf(check(a.partner.token, a.firmId, a.client.clientId)), "unavailable", "screening_unavailable")
    expect(await runReindexJob(a.firmId)).toBe("done")
    expect((await check(a.partner.token, a.firmId, a.client.clientId)).result).toBe("CLEAR")

    const b = await setup()
    await registryVersionRef(b.firmId).set({ nameIndex: { chunk: 1, bytes: 10 } }, { merge: true })
    await nameIndexChunkRef(b.firmId, 0).delete()
    expectKind(await apiErrorOf(check(b.partner.token, b.firmId, b.client.clientId)), "unavailable", "screening_unavailable")
    expect(await runReindexJob(b.firmId)).toBe("done")
    expect((await check(b.partner.token, b.firmId, b.client.clientId)).result).toBe("CLEAR")

    const c = await setup()
    await nameIndexChunkRef(c.firmId, 0).set({ firmId: b.firmId }, { merge: true })
    expectKind(await apiErrorOf(check(c.partner.token, c.firmId, c.client.clientId)), "unavailable", "screening_unavailable")
    expect(await runReindexJob(c.firmId)).toBe("done")
    expect((await check(c.partner.token, c.firmId, c.client.clientId)).result).toBe("CLEAR")
  })
})

describe.skipIf(!EMULATORS)("F37: a registry write racing a matter opening is caught", () => {
  it("a client fuzzily matching the opposing party (no shared token) registered between pre-screen and transaction → the round redoes, re-screens through the index, 409 check_stale", async () => {
    const { firmId, partner, client } = await setup()
    const cleared = await check(partner.token, firmId, client.clientId, "Haris Qalbani")
    expect(cleared.result).toBe("CLEAR")
    const rounds: number[] = []
    openMatterTestSeam.afterPreScreen = async (round) => {
      rounds.push(round)
      if (round === 1) {
        // "harris qalbany" shares no token with "haris qalbani"; its token-set ratio is 24/27 ≈ 0.89.
        await registerClient({ token: partner.token, data: { firmId, name: "Harris Qalbany", type: "individual", primaryMobile: nextMobile(), classification: "internal" } } as never)
      }
    }
    try {
      expectKind(await apiErrorOf(open(partner.token, firmId, cleared.checkId)), "failed-precondition", "check_stale")
    } finally {
      delete openMatterTestSeam.afterPreScreen
    }
    expect(rounds).toEqual([1, 2])
    expect((await adminDb().collection("conflict_checks").doc(cleared.checkId).get()).data()).toMatchObject({ stale: true, boundMatterId: null })
    expect(await rows("matters", firmId)).toHaveLength(0)
    // The racing client reached the screen only through the name index (no key or entity in common).
    const subjects = [
      { role: "client" as const, name: "Tariq Zarvani", keys: {}, clientId: client.clientId },
      { role: "opposing" as const, name: "Haris Qalbani", keys: {} },
    ]
    const load = await loadScreeningRegistry(firmId, subjects, [client.entityId, undefined], new Date())
    expect((await readIndexedNames(firmId)).names.has("Harris Qalbany")).toBe(true)
    expect(load.registry.candidates.map((c) => c.name).sort()).toEqual(["Harris Qalbany", "Tariq Zarvani"])
  })
})

describe.skipIf(!EMULATORS)("F37: cross-firm isolation (G-2)", () => {
  it("another firm's client with the same name, CNIC, phone and entity id is never a candidate; the loader reads only this firm's chunks", async () => {
    const a = await setup()
    const b = await setup()
    const cnic = "4210199999991"
    await registerClient({ token: b.partner.token, data: { firmId: b.firmId, name: "Haris Qalbani", type: "individual", primaryMobile: "03029999991", cnic, classification: "internal" } } as never)
    // Firm B's opposing party carrying firm A's client entity id.
    await adminDb().collection("matter_parties").add({ firmId: b.firmId, matterId: null, role: "opposing", name: "Tariq Zarvani", keys: { cnic }, entityId: a.client.entityId, classification: "internal" })
    await reconcileNameIndex(b.firmId)
    const out = await runCheck({
      token: a.partner.token,
      data: { firmId: a.firmId, client: { clientId: a.client.clientId }, opposingParties: [{ name: "Haris Qalbani", keys: { cnic, phone: "03029999991" } }] },
    } as never)
    expect(out.result).toBe("CLEAR")
    const subjects = [
      { role: "client" as const, name: "Tariq Zarvani", keys: {}, clientId: a.client.clientId },
      { role: "opposing" as const, name: "Haris Qalbani", keys: { cnic, phone: "+923029999991" } },
    ]
    const load = await loadScreeningRegistry(a.firmId, subjects, [a.client.entityId, undefined], new Date())
    expect(load.registry.candidates.map((c) => c.candidateId)).toEqual([`client:${a.client.clientId}`])
    expect([...(await readIndexedNames(a.firmId)).names]).toEqual(["Tariq Zarvani"])
    // Firm B's own screen finds its own party (and its own same-named client), from its own index only.
    const bHits = (await runCheck({ token: b.partner.token, data: { firmId: b.firmId, client: { name: "Tariq Zarvani" }, opposingParties: [{ name: "Zzz Qqq" }] } } as never)).hits
    expect(bHits).toContainEqual(expect.objectContaining({ hitRole: "opposing", matchedName: "Tariq Zarvani", outcome: "POSSIBLE_CANDIDATE_REVIEW" }))
    expect(bHits.every((h) => h.matterId !== a.client.clientId)).toBe(true)
  })
})

describe.skipIf(!EMULATORS)("F37: what the candidate loader reads", () => {
  it("exactly the counter (version and index state), the firm doc, the transliteration map, the index chunks and the candidates' clients, parties, matters and links", async () => {
    const { firmId, partner, client } = await setup()
    await adminDb().collection("matters").add({ firmId, clientId: client.clientId, matterNo: "NHS/2099/0001", status: "live", classification: "confidential" })
    await adminDb().collection("matter_parties").add({ firmId, matterId: "m-x", role: "opposing", name: "Haris Qalbani", keys: {}, entityId: client.entityId, classification: "internal" })
    await reconcileNameIndex(firmId)
    const subjects = [
      { role: "client" as const, name: "Tariq Zarvani", keys: {}, clientId: client.clientId },
      { role: "opposing" as const, name: "Haris Qalbani", keys: { cnic: "4210100000001" } },
    ]
    const reads = await registryRecorder.readsDuring(() => loadScreeningRegistry(firmId, subjects, [client.entityId, undefined], new Date()))
    expect([...reads].sort()).toEqual(["clients", "conflict_name_index", "counters", "entity_links", "firms", "matter_parties", "matters", "transliteration_map"])
    expect(partner.uid).toBeTruthy()
  })

  it("a party's matter id that is not a document id is never read; another firm's matter is not used", async () => {
    const { firmId } = await setup()
    const foreign = await adminDb().collection("matters").add({ firmId: "other-firm", clientId: "x", matterNo: "OTHER/1", status: "live", classification: "public" })
    await adminDb().collection("matter_parties").add({ firmId, matterId: "bad/id", role: "opposing", name: "Haris Qalbani", keys: {}, classification: "internal" })
    await adminDb().collection("matter_parties").add({ firmId, matterId: foreign.id, role: "opposing", name: "Haris Qalbani", keys: {}, classification: "internal", matterClassification: "confidential", matterStatus: "closed" })
    await reconcileNameIndex(firmId)
    const subjects = [{ role: "client" as const, name: "Haris Qalbani", keys: {} }, { role: "opposing" as const, name: "Zzz Qqq", keys: {} }]
    const load = await loadScreeningRegistry(firmId, subjects, [undefined, undefined], new Date())
    const parties = load.registry.candidates.filter((c) => c.role === "opposing")
    expect(parties).toHaveLength(2)
    for (const p of parties) expect(p.matterNo).toBeNull()
    expect(parties.find((p) => p.matterId === foreign.id)).toMatchObject({ matterClassification: "confidential", matterStatus: "closed" })
  })
})

describe.skipIf(!EMULATORS)("F37: the reconciliation", () => {
  it("is read-only on a current index with nothing missing; repairs drift and bumps; refuses to mark over a write that skipped the index", async () => {
    const { firmId, partner } = await setup()
    const before = await readRegistryState(firmId)
    expect(await reconcileNameIndex(firmId)).toEqual({ names: 1, added: 0, marked: false, rebuilt: false, rounds: 1 })
    expect(await readRegistryState(firmId)).toEqual(before)

    // Drift: a party written out of band while the index reads current.
    await adminDb().collection("matter_parties").add({ firmId, matterId: null, role: "opposing", name: "Haris Qalbani", keys: {}, classification: "internal" })
    expect(await reconcileNameIndex(firmId)).toEqual({ names: 2, added: 1, marked: false, rebuilt: false, rounds: 1 })
    const after = await readRegistryState(firmId)
    expect(after.version).toBe(before.version + 1)
    expect(after.nameIndex.version).toBe(after.version)

    // A stale index marked current once every write since the scan kept the mirror.
    await registryVersionRef(firmId).set({ version: FieldValue.increment(1) }, { merge: true })
    expect(await reconcileNameIndex(firmId)).toMatchObject({ added: 0, marked: true })
    const marked = await readRegistryState(firmId)
    expect(marked.nameIndex).toMatchObject({ schema: NAME_INDEX_SCHEMA, version: marked.version })
    expect(partner.uid).toBeTruthy()
  })

  it("the job's payload is a PKT day or hour key, nothing else", () => {
    expect(nameReindexHandler.parse({ period: "2099-01-02" })).toEqual({ period: "2099-01-02" })
    expect(nameReindexHandler.parse({ period: "2099-01-02T13" })).toEqual({ period: "2099-01-02T13" })
    for (const bad of [null, [], {}, { period: 1 }, { period: "2099-1-2" }, { period: "2099-01-02", extra: 1 }]) {
      expect(() => nameReindexHandler.parse(bad)).toThrow(expect.objectContaining({ code: "invalid_payload", permanent: true }))
    }
    expect(pktHourKey(Date.parse("2099-01-02T19:30:00Z"))).toBe("2099-01-03T00")
    expect(pktMinuteKey(Date.parse("2099-01-02T19:30:59Z"))).toBe("2099-01-03T00:30")
    expect(nameReindexHandler.parse({ period: "2099-01-03T00:30" })).toEqual({ period: "2099-01-03T00:30" })
    expect(() => nameReindexHandler.parse({ period: "2099-01-03T00:3" })).toThrow(expect.objectContaining({ code: "invalid_payload" }))
    // No failure is permanent: a damaged index is rebuilt; racing writes make the run retry (PR #80 review).
    expect(Object.keys(nameReindexHandler.errorCodes)).toEqual(["reconcile_contended"])
    expect(Timestamp.now()).toBeTruthy()
  })
})
