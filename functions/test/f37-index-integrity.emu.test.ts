import { describe, expect, it } from "vitest"
import { FieldValue, type UpdateData, type DocumentData } from "firebase-admin/firestore"
import { adminDb } from "../src/admin"
import { nameBytes, nameIndexChunkRef, NAME_INDEX_SCHEMA, reconcileNameIndex } from "../src/d1/conflict/nameIndex"
import { NAME_REINDEX_JOB_TYPE } from "../src/d1/conflict/reindexJob"
import { readRegistryState, registryVersionRef } from "../src/d1/registryVersion"
import { runJobTask } from "../src/p2/worker"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { apiErrorOf, expectKind, viaApi } from "./api"
import { FakeClock, readJob, testDeps } from "./jobs"

/**
 * Audit F37, the integrity of the name index (PR #80 review, thread 4306418755). A screen may trust the index only
 * when its state on the counter doc is whole (`schema`, `version`, `chunk`, `bytes`) and every chunk from 0 to
 * `chunk` is there and well formed: otherwise names in an unread chunk would be missing and a conflicting subject
 * would screen CLEAR. Each case builds a valid multi-chunk index (the layout the placement makes past 512 KiB per
 * chunk), shows it screens correctly, damages it one way, and then, through the real routes, expects
 * runConflictCheck and openMatter to refuse with 503 screening_unavailable and write nothing; the reindex job, run
 * through the real P2 worker, rebuilds the index and the same calls succeed, finding the conflict.
 *
 * Synthetic data only.
 */

type Check = { checkId: string; result: string; hits: Array<Record<string, unknown>> }
const registerClient = viaApi<{ clientId: string; entityId: string }>("registerClient")
const runCheck = viaApi<Check>("runConflictCheck")
const openMatter = viaApi<{ matterId: string; matterNo: string }>("openMatter")

const SUBJECT_CLIENT = "Tariq Zarvani"
/** The firm's client that conflicts with the opposing subject; each case puts it in a chunk the damage hides. */
const CONFLICT = "Haris Qalbani"

let mobileSeq = 0
const nextMobile = () => `0303${String(5000000 + ++mobileSeq)}`

const rows = async (collection: string, firmId: string) => (await adminDb().collection(collection).where("firmId", "==", firmId).get()).docs
const reindexJobs = async (firmId: string) => (await rows("jobs", firmId)).filter((d) => d.data().jobType === NAME_REINDEX_JOB_TYPE)

type Firm = { firmId: string; token: string; clientId: string; clearedCheckId: string }

const screenConflict = (f: Firm) =>
  runCheck({ token: f.token, data: { firmId: f.firmId, client: { clientId: f.clientId }, opposingParties: [{ name: CONFLICT }] } } as never)
const open = (f: Firm) =>
  openMatter({ token: f.token, data: { firmId: f.firmId, conflictCheckId: f.clearedCheckId, title: "Recovery suit", classification: "confidential" } } as never)

/**
 * A firm whose current name index holds `layout[n]` in chunk n. The subject client registers through the route; the
 * other names are clients written out of band and indexed by the production reconciliation; the names are then laid
 * out over the chunks with the state pointing at the last one, as the placement leaves a multi-chunk index.
 */
async function indexedFirm(layout: string[][]): Promise<Firm> {
  const firmId = uniq("f37i")
  await adminDb().collection("firms").doc(firmId).set({ name: "F37 integrity firm", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
  const partner = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
  const client = await registerClient({
    token: partner.token,
    data: { firmId, name: SUBJECT_CLIENT, type: "individual", primaryMobile: nextMobile(), classification: "internal" },
  } as never)
  for (const name of layout.flat()) {
    if (name !== SUBJECT_CLIENT) await adminDb().collection("clients").add({ firmId, canonicalName: name, type: "individual", classification: "internal" })
  }
  await reconcileNameIndex(firmId)

  const db = adminDb()
  const batch = db.batch()
  layout.forEach((names, n) =>
    batch.set(nameIndexChunkRef(firmId, n), { firmId, chunk: n, kind: "conflict_name_index", classification: "privileged-restricted", names })
  )
  const last = layout.length - 1
  batch.update(registryVersionRef(firmId), { "nameIndex.chunk": last, "nameIndex.bytes": layout[last].reduce((s, x) => s + nameBytes(x), 0) })
  await batch.commit()

  const f: Firm = { firmId, token: partner.token, clientId: client.clientId, clearedCheckId: "" }
  const cleared = await runCheck({ token: f.token, data: { firmId, client: { clientId: f.clientId }, opposingParties: [{ name: "Zzz Qqq" }] } } as never)
  expect(cleared.result).toBe("CLEAR")
  f.clearedCheckId = cleared.checkId
  // The layout is a valid current index: the conflicting name is found in whichever chunk holds it.
  expect((await screenConflict(f)).hits).toContainEqual(expect.objectContaining({ subjectIndex: 1, matchedName: CONFLICT }))
  return f
}

const damageState = (f: Firm, update: UpdateData<DocumentData>) => registryVersionRef(f.firmId).update(update)

/** Runs the firm's enqueued reindex job through the real P2 worker; returns its outcome. */
async function runReindexJob(firmId: string): Promise<string> {
  const [job] = await reindexJobs(firmId)
  expect(job).toBeDefined()
  return runJobTask({ jobId: job.id, seq: (await readJob(job.id)).dispatchSeq }, testDeps(new FakeClock(Date.now() + 60_000)))
}

/** The damaged index refuses both screens and writes nothing; the job rebuilds it and both calls then succeed. */
async function expectRefusedThenHealed(f: Firm): Promise<void> {
  const checksBefore = (await rows("conflict_checks", f.firmId)).length
  expectKind(await apiErrorOf(screenConflict(f)), "unavailable", "screening_unavailable")
  expectKind(await apiErrorOf(open(f)), "unavailable", "screening_unavailable")
  expect(await rows("conflict_checks", f.firmId)).toHaveLength(checksBefore)
  expect(await rows("matters", f.firmId)).toHaveLength(0)
  expect((await adminDb().collection("conflict_checks").doc(f.clearedCheckId).get()).data()).toMatchObject({ boundMatterId: null, stale: false })
  expect(await reindexJobs(f.firmId)).toHaveLength(1)

  expect(await runReindexJob(f.firmId)).toBe("done")
  const state = await readRegistryState(f.firmId)
  expect(state.nameIndex).toMatchObject({ schema: NAME_INDEX_SCHEMA, version: state.version, valid: true })
  expect((await screenConflict(f)).hits).toContainEqual(expect.objectContaining({ subjectIndex: 1, matchedName: CONFLICT }))
  expect((await open(f)).matterNo).toMatch(/^NHS\/\d{4}\/0001$/)
}

describe.skipIf(!EMULATORS)("F37: a damaged name index is never read as complete (503, nothing written) and the job rebuilds it", () => {
  it("the state lacks `chunk`: the pointer is unknown, so the later chunks cannot be read", async () => {
    const f = await indexedFirm([[SUBJECT_CLIENT, "Zubair Hashmi", "Kamran Akmal"], ["Sana Mir"], [CONFLICT, "Bilal Asif"]])
    await damageState(f, { "nameIndex.chunk": FieldValue.delete() })
    await expectRefusedThenHealed(f)
  }, 120_000)

  it("the state lacks `bytes`", async () => {
    const f = await indexedFirm([[SUBJECT_CLIENT, "Zubair Hashmi", "Kamran Akmal"], ["Sana Mir"], [CONFLICT, "Bilal Asif"]])
    await damageState(f, { "nameIndex.bytes": FieldValue.delete() })
    await expectRefusedThenHealed(f)
  }, 120_000)

  it("chunk 0 is missing", async () => {
    const f = await indexedFirm([[CONFLICT, SUBJECT_CLIENT], ["Zubair Hashmi"], ["Kamran Akmal"]])
    await nameIndexChunkRef(f.firmId, 0).delete()
    await expectRefusedThenHealed(f)
  }, 120_000)

  it("chunk 0 is missing and the state says the index is empty (chunk 0, 0 bytes) while the firm has names", async () => {
    const f = await indexedFirm([[CONFLICT, SUBJECT_CLIENT]])
    await nameIndexChunkRef(f.firmId, 0).delete()
    await damageState(f, { "nameIndex.bytes": 0 })
    await expectRefusedThenHealed(f)
  }, 120_000)

  it("a middle chunk is missing", async () => {
    const f = await indexedFirm([[SUBJECT_CLIENT, "Zubair Hashmi"], [CONFLICT], ["Kamran Akmal"]])
    await nameIndexChunkRef(f.firmId, 1).delete()
    await expectRefusedThenHealed(f)
  }, 120_000)

  describe("a chunk with a malformed body", () => {
    const layout = [[SUBJECT_CLIENT, "Zubair Hashmi"], [CONFLICT, "Kamran Akmal"]]
    const cases: Array<[string, (f: Firm) => DocumentData]> = [
      ["names is not an array", () => ({ names: "not-an-array" })],
      ["names holds a non-string", () => ({ names: [CONFLICT, 7] })],
      ["names is empty while the state counts bytes in it", () => ({ names: [] })],
      ["the chunk number is not the document's", () => ({ chunk: 9 })],
      ["the chunk belongs to another firm", () => ({ firmId: uniq("f37other") })],
    ]
    for (const [what, body] of cases) {
      it(what, async () => {
        const f = await indexedFirm(layout)
        await nameIndexChunkRef(f.firmId, 1).update(body(f))
        await expectRefusedThenHealed(f)
      }, 120_000)
    }
  })
})
