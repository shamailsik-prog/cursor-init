import { afterAll, describe, expect, it } from "vitest"
import { DocumentReference, FieldValue, Transaction, type DocumentData } from "firebase-admin/firestore"
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
 * Audit F37 re-audit at 2b6ef08 (FAIL 6.5/10): the findings that let a screen answer CLEAR while a conflicting
 * name is in the registry, each driven through the real routes (runConflictCheck, openMatter) on the emulator.
 *
 * - FA-D1C-001: an index whose pointer understates its chunks (lowered by an out-of-band edit, with or without a gap,
 *   or a chunk beyond the pointer) must refuse, not read a partial index as complete.
 * - FA-D1C-002: a client or opposing party written outside functions/src (a rename, an insert, a role flip, a move
 *   between firms) must make the screen refuse until the index is rebuilt. The Firestore triggers that notice those
 *   writes are delivered here in process, as the platform would deliver them (the functions-emulator pipeline test
 *   measures the real delivery); on a tree without the triggers nothing is delivered.
 * - FA-D1C-003: a rebuild that completes between a screen's counter read and its chunk read must not give CLEAR.
 * - FA-D1C-004: a name removed from inside an otherwise valid chunk must make the screen refuse.
 *
 * Synthetic data only; every document a test creates is deleted afterwards.
 */

type Check = { checkId: string; result: string; hits: Array<Record<string, unknown>> }
const registerClient = viaApi<{ clientId: string; entityId: string }>("registerClient")
const runCheck = viaApi<Check>("runConflictCheck")
const openMatter = viaApi<{ matterId: string; matterNo: string }>("openMatter")
const closeMatter = viaApi<unknown>("closeMatter")

const SUBJECT = "Tariq Zarvani"
const CONFLICT = "Haris Qalbani"

let mobileSeq = 0
const nextMobile = () => `0304${String(6000000 + ++mobileSeq)}`

const created = { firms: [] as string[], uids: [] as string[] }
afterAll(async () => {
  if (EMULATORS) await deleteFirmData(created.firms, created.uids)
}, 600_000)

type Firm = { firmId: string; token: string; uid: string; clientId: string; clearedCheckId: string; clients: Record<string, string> }

async function newFirm(): Promise<Pick<Firm, "firmId" | "token" | "uid">> {
  const firmId = uniq("f37fu")
  created.firms.push(firmId)
  await adminDb().collection("firms").doc(firmId).set({ name: "F37 follow-up firm", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
  const partner = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
  created.uids.push(partner.uid)
  return { firmId, token: partner.token, uid: partner.uid }
}

/** A firm whose clients `names` (and the subject client) were registered through the route, with a cleared check. */
async function registeredFirm(names: readonly string[] = []): Promise<Firm> {
  const base = await newFirm()
  const clients: Record<string, string> = {}
  for (const name of [SUBJECT, ...names]) {
    const c = await registerClient({ token: base.token, data: { firmId: base.firmId, name, type: "individual", primaryMobile: nextMobile(), classification: "internal" } } as never)
    clients[name] = c.clientId
  }
  const f: Firm = { ...base, clientId: clients[SUBJECT], clients, clearedCheckId: "" }
  const cleared = await runCheck({ token: f.token, data: { firmId: f.firmId, client: { clientId: f.clientId }, opposingParties: [{ name: "Zzz Qqq" }] } } as never)
  expect(cleared.result).toBe("CLEAR")
  f.clearedCheckId = cleared.checkId
  return f
}

/** The subject client against an opposing party named CONFLICT: a hit when CONFLICT is one of the firm's clients. */
const screenAsOpposing = (f: Firm) =>
  runCheck({ token: f.token, data: { firmId: f.firmId, client: { clientId: f.clientId }, opposingParties: [{ name: CONFLICT }] } } as never)
/** A prospective client named CONFLICT: a hit when CONFLICT is an opposing party of the firm (adverse history). */
const screenAsProspect = (f: Firm) =>
  runCheck({ token: f.token, data: { firmId: f.firmId, client: { name: CONFLICT }, opposingParties: [{ name: "Zzz Qqq" }] } } as never)
const open = (f: Firm) =>
  openMatter({ token: f.token, data: { firmId: f.firmId, conflictCheckId: f.clearedCheckId, title: "Recovery suit", classification: "confidential" } } as never)

const hitsConflict = (c: Check) => c.hits.some((h) => h.matchedName === CONFLICT && h.outcome !== "NONE")
const rows = async (collection: string, firmId: string) => (await adminDb().collection(collection).where("firmId", "==", firmId).get()).docs
const reindexJobs = async (firmId: string) => (await rows("jobs", firmId)).filter((d) => d.data().jobType === NAME_REINDEX_JOB_TYPE)

async function runReindexJob(firmId: string): Promise<string> {
  const [job] = await reindexJobs(firmId)
  expect(job).toBeDefined()
  return runJobTask({ jobId: job.id, seq: (await readJob(job.id)).dispatchSeq }, testDeps(new FakeClock(Date.now() + 60_000)))
}

/** Both routes refuse (503) and write nothing; the reindex job, run through the real P2 worker, rebuilds the index; then the conflict is found and the matter opens. */
async function expectRefusedThenHealed(f: Firm, screen: (f: Firm) => Promise<Check>): Promise<void> {
  const checksBefore = (await rows("conflict_checks", f.firmId)).length
  expectKind(await apiErrorOf(screen(f)), "unavailable", "screening_unavailable")
  expectKind(await apiErrorOf(open(f)), "unavailable", "screening_unavailable")
  expect(await rows("conflict_checks", f.firmId)).toHaveLength(checksBefore)
  expect(await rows("matters", f.firmId)).toHaveLength(0)
  expect((await adminDb().collection("conflict_checks").doc(f.clearedCheckId).get()).data()).toMatchObject({ boundMatterId: null, stale: false })
  expect((await reindexJobs(f.firmId)).length).toBeGreaterThanOrEqual(1)

  expect(await runReindexJob(f.firmId)).toBe("done")
  expect(hitsConflict(await screen(f))).toBe(true)
  expect((await open(f)).matterNo).toMatch(/^NHS\/\d{4}\/0001$/)
}

/** Lays the firm's indexed names out over chunks (`layout[n]` in chunk n), as the placement leaves a large firm's index. */
async function layOut(f: Firm, layout: string[][]): Promise<void> {
  const db = adminDb()
  const base = (await nameIndexChunkRef(f.firmId, 0).get()).data() ?? {}
  const batch = db.batch()
  layout.forEach((names, n) => batch.set(nameIndexChunkRef(f.firmId, n), { ...base, firmId: f.firmId, chunk: n, names }))
  const last = layout.length - 1
  batch.update(registryVersionRef(f.firmId), { "nameIndex.chunk": last, "nameIndex.bytes": layout[last].reduce((s, x) => s + Buffer.byteLength(x, "utf8") + 1, 0) })
  await batch.commit()
  expect(hitsConflict(await screenAsOpposing(f))).toBe(true)
}

type Triggers = {
  registryRowWritten(collection: string, docId: string, before: DocumentData | undefined, after: DocumentData | undefined, nowMs: number): Promise<unknown>
  nameIndexChunkWritten(chunkId: string, before: DocumentData | undefined, after: DocumentData | undefined, nowMs: number): Promise<unknown>
}

/** The F37 registry triggers' handlers, when this tree has them; null on a tree without them. */
async function triggers(): Promise<Triggers | null> {
  try {
    // A variable path, so a tree without the module still loads this file (and screens without the triggers).
    const path = "../src/d1/conflict/registryTriggers"
    const m = (await import(/* @vite-ignore */ path)) as Partial<Triggers>
    return typeof m.registryRowWritten === "function" && typeof m.nameIndexChunkWritten === "function" ? (m as Triggers) : null
  } catch {
    return null
  }
}

/**
 * Applies a write outside functions/src and delivers the document event the platform delivers to the F37 triggers.
 * A trigger that breaks the index also enqueues its rebuild, before any screen asks (when the tree has triggers).
 */
async function outOfBand(ref: DocumentReference, write: () => Promise<unknown>, firmId?: string): Promise<void> {
  const before = (await ref.get()).data()
  await write()
  const after = (await ref.get()).data()
  const t = await triggers()
  if (!t) return
  if (ref.parent.id === "conflict_name_index") await t.nameIndexChunkWritten(ref.id, before, after, Date.now())
  else await t.registryRowWritten(ref.parent.id, ref.id, before, after, Date.now())
  if (firmId !== undefined) expect((await reindexJobs(firmId)).length).toBeGreaterThanOrEqual(1)
}

describe.skipIf(!EMULATORS)("FA-D1C-001: an index pointer that understates the chunks is never read as complete", () => {
  it("the pointer lowered from chunk 1 to chunk 0 (the conflict in chunk 1): 503, nothing written; the job rebuilds", async () => {
    const f = await registeredFirm([CONFLICT])
    await layOut(f, [[SUBJECT], [CONFLICT]])
    await registryVersionRef(f.firmId).update({ "nameIndex.chunk": 0 })
    await expectRefusedThenHealed(f, screenAsOpposing)
  }, 180_000)

  it("the pointer lowered from chunk 2 to chunk 0 with chunk 1 deleted (a gap above the pointer, the conflict in chunk 2)", async () => {
    const f = await registeredFirm(["Zubair Hashmi", CONFLICT])
    await layOut(f, [[SUBJECT], ["Zubair Hashmi"], [CONFLICT]])
    await registryVersionRef(f.firmId).update({ "nameIndex.chunk": 0, "nameIndex.bytes": Buffer.byteLength(SUBJECT) + 1 })
    await nameIndexChunkRef(f.firmId, 1).delete()
    await expectRefusedThenHealed(f, screenAsOpposing)
  }, 180_000)

  it("a chunk written beyond the pointer, holding the only copy of the conflicting name", async () => {
    const f = await registeredFirm([CONFLICT])
    const chunk0 = (await nameIndexChunkRef(f.firmId, 0).get()).data() ?? {}
    await nameIndexChunkRef(f.firmId, 0).update({ names: FieldValue.arrayRemove(CONFLICT) })
    await nameIndexChunkRef(f.firmId, 3).set({ ...chunk0, chunk: 3, names: [CONFLICT] })
    await expectRefusedThenHealed(f, screenAsOpposing)
  }, 180_000)
})

describe.skipIf(!EMULATORS)("FA-D1C-002: registry writes made outside functions/src make the screen refuse until the index is rebuilt", () => {
  it("O1: a registered client renamed by the Admin SDK to the conflicting name", async () => {
    const f = await registeredFirm(["Zubair Hashmi"])
    const ref = adminDb().collection("clients").doc(f.clients["Zubair Hashmi"])
    await outOfBand(ref, () => ref.update({ canonicalName: CONFLICT }), f.firmId)
    await expectRefusedThenHealed(f, screenAsOpposing)
  }, 180_000)

  it("O2: a client inserted out of band into an active firm", async () => {
    const f = await registeredFirm()
    const ref = adminDb().collection("clients").doc()
    await outOfBand(ref, () => ref.set({ firmId: f.firmId, canonicalName: CONFLICT, type: "individual", classification: "internal", primaryMobile: "+923031234567" }))
    await expectRefusedThenHealed(f, screenAsOpposing)
  }, 180_000)

  it("O3: an opposing party inserted out of band, screened against a prospective client of that name", async () => {
    const f = await registeredFirm()
    const ref = adminDb().collection("matter_parties").doc()
    await outOfBand(ref, () => ref.set({ firmId: f.firmId, matterId: null, role: "opposing", name: CONFLICT, keys: {}, classification: "internal" }))
    await expectRefusedThenHealed(f, screenAsProspect)
  }, 180_000)

  it("O5: a client-role party flipped out of band to opposing", async () => {
    const f = await registeredFirm()
    const ref = adminDb().collection("matter_parties").doc()
    await outOfBand(ref, () => ref.set({ firmId: f.firmId, matterId: null, role: "client", name: CONFLICT, keys: {}, classification: "internal" }))
    await outOfBand(ref, () => ref.update({ role: "opposing" }))
    await expectRefusedThenHealed(f, screenAsProspect)
  }, 180_000)

  it("O6: a client moved out of band from another firm into this one", async () => {
    const f = await registeredFirm()
    const other = await registeredFirm([CONFLICT])
    const ref = adminDb().collection("clients").doc(other.clients[CONFLICT])
    await outOfBand(ref, () => ref.update({ firmId: f.firmId }))
    await expectRefusedThenHealed(f, screenAsOpposing)
  }, 180_000)
})

describe.skipIf(!EMULATORS)("FA-D1C-002, stale stamps: a stamp older than a rebuild that dropped its name is not trusted", () => {
  /** Damages the index (chunk 0 carries another chunk number), lets a screen refuse it, and rebuilds it: the reset drops every name no row holds. */
  async function resetAndRebuild(f: Firm): Promise<void> {
    const chunk0 = nameIndexChunkRef(f.firmId, 0)
    await outOfBand(chunk0, () => chunk0.update({ chunk: 7 }))
    expectKind(await apiErrorOf(screenAsOpposing(f)), "unavailable", "screening_unavailable")
    expect(await reconcileNameIndex(f.firmId)).toMatchObject({ rebuilt: true, marked: true })
  }

  /** Both routes refuse until the reconciliation rebuilds the index; then the conflict is found and the matter opens. */
  async function expectRefusedThenRebuilt(f: Firm): Promise<void> {
    expectKind(await apiErrorOf(screenAsOpposing(f)), "unavailable", "screening_unavailable")
    expectKind(await apiErrorOf(open(f)), "unavailable", "screening_unavailable")
    expect(await rows("matters", f.firmId)).toHaveLength(0)
    expect(await reconcileNameIndex(f.firmId)).toMatchObject({ marked: true })
    expect(hitsConflict(await screenAsOpposing(f))).toBe(true)
    expect((await open(f)).matterNo).toMatch(/^NHS\/\d{4}\/0001$/)
  }

  it("O7: a client deleted, the index rebuilt without its name, then the row restored out of band (a backup import)", async () => {
    const f = await registeredFirm([CONFLICT])
    const ref = adminDb().collection("clients").doc(f.clients[CONFLICT])
    const saved = (await ref.get()).data()
    expect(saved?.nameIndexed).toMatchObject({ firmId: f.firmId, name: CONFLICT })
    await outOfBand(ref, () => ref.delete())
    await resetAndRebuild(f)
    expect(hitsConflict(await screenAsOpposing(f))).toBe(false)
    await outOfBand(ref, () => ref.set(saved as DocumentData))
    await expectRefusedThenRebuilt(f)
  }, 180_000)

  it("O8: a client renamed out of band, the index rebuilt, then renamed back to the name its stamp records", async () => {
    const f = await registeredFirm([CONFLICT])
    const ref = adminDb().collection("clients").doc(f.clients[CONFLICT])
    await outOfBand(ref, () => ref.update({ canonicalName: "Zubair Hashmi" }))
    await reconcileNameIndex(f.firmId)
    await resetAndRebuild(f)
    expect(hitsConflict(await screenAsOpposing(f))).toBe(false)
    await outOfBand(ref, () => ref.update({ canonicalName: CONFLICT }))
    await expectRefusedThenRebuilt(f)
  }, 180_000)
})

describe.skipIf(!EMULATORS)("FA-D1C-003: a rebuild completing between a screen's counter read and its chunk read never gives CLEAR", () => {
  it("the index is damaged and rebuilt into two chunks right after the screen reads the counter: the screen finds the conflict or refuses", async () => {
    const f = await registeredFirm([CONFLICT])
    expect(hitsConflict(await screenAsOpposing(f))).toBe(true)
    // 1,450 long names (about 381 bytes each, 552 KB) written out of band and sorting before the conflict, not yet
    // indexed: the screen reads a one-chunk index, and a rebuild needs two chunks and leaves the conflict in chunk 1.
    const db = adminDb()
    for (let b = 0; b < 1450; b += 450) {
      const batch = db.batch()
      for (let i = b; i < Math.min(b + 450, 1450); i++) {
        batch.set(db.collection("clients").doc(), { firmId: f.firmId, canonicalName: `Aaaa${String(i).padStart(5, "0")} ${"x".repeat(370)}`, type: "individual", classification: "internal" })
      }
      await batch.commit()
    }

    // Right after the screen's read of the registry counter (outside or inside a transaction), the index is damaged
    // and the reindex rebuilds it.
    const counterPath = registryVersionRef(f.firmId).path
    const refProto = DocumentReference.prototype as unknown as { get: (...a: unknown[]) => Promise<unknown> }
    const txProto = Transaction.prototype as unknown as { get: (...a: unknown[]) => Promise<unknown> }
    const refGet = refProto.get
    const txGet = txProto.get
    let armed = true
    let rebuilt = ""
    const inject = async () => {
      armed = false
      await nameIndexChunkRef(f.firmId, 0).update({ chunk: 99 })
      rebuilt = JSON.stringify(await reconcileNameIndex(f.firmId))
    }
    refProto.get = async function (this: DocumentReference, ...args: unknown[]) {
      const out = await refGet.apply(this, args)
      if (armed && this.path === counterPath) await inject()
      return out
    }
    txProto.get = async function (this: Transaction, ...args: unknown[]) {
      const out = await txGet.apply(this, args)
      if (armed && args[0] instanceof DocumentReference && args[0].path === counterPath) await inject()
      return out
    }
    let during: string
    try {
      const c = await screenAsOpposing(f)
      during = `${c.result}${hitsConflict(c) ? "+HIT" : ""}`
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      during = `ERR ${err.status} ${err.code}`
    } finally {
      refProto.get = refGet
      txProto.get = txGet
    }
    console.log(`F37-FU heal race: during=${during} rebuild=${rebuilt}`)
    expect(rebuilt).toContain('"rebuilt":true')
    expect(during === "ERR 503 screening_unavailable" || during.endsWith("+HIT")).toBe(true)
    expect(hitsConflict(await screenAsOpposing(f))).toBe(true)
  }, 600_000)
})

describe.skipIf(!EMULATORS)("FA-D1C-003: a reset and a partial rebuild between the counter read and the chunk read never give CLEAR", () => {
  it("the index is reset and its chunk 0 rewritten with part of the names (a rebuild's first batch) right after the screen reads the counter", async () => {
    const f = await registeredFirm([CONFLICT])
    expect(hitsConflict(await screenAsOpposing(f))).toBe(true)
    const counterPath = registryVersionRef(f.firmId).path
    const refProto = DocumentReference.prototype as unknown as { get: (...a: unknown[]) => Promise<unknown> }
    const txProto = Transaction.prototype as unknown as { get: (...a: unknown[]) => Promise<unknown> }
    const refGet = refProto.get
    const txGet = txProto.get
    let armed = true
    // What a reset and the first append batch of the rebuild leave: chunk 0 holding only some names, the state reset
    // (no schema, pointer 0, the batch's bytes) with the registry version moved. Every chunk check passes against the
    // counter the screen already read; only a read of both at one snapshot keeps them consistent.
    const inject = async () => {
      armed = false
      const chunk0 = (await nameIndexChunkRef(f.firmId, 0).get()).data() ?? {}
      const before = (await registryVersionRef(f.firmId).get()).data()?.version as number
      const batch = adminDb().batch()
      batch.set(nameIndexChunkRef(f.firmId, 0), { ...chunk0, names: [SUBJECT] })
      batch.update(registryVersionRef(f.firmId), { version: before + 1, nameIndex: { version: before + 1, chunk: 0, bytes: Buffer.byteLength(SUBJECT) + 1 } })
      await batch.commit()
    }
    refProto.get = async function (this: DocumentReference, ...args: unknown[]) {
      const out = await refGet.apply(this, args)
      if (armed && this.path === counterPath) await inject()
      return out
    }
    txProto.get = async function (this: Transaction, ...args: unknown[]) {
      const out = await txGet.apply(this, args)
      if (armed && args[0] instanceof DocumentReference && args[0].path === counterPath) await inject()
      return out
    }
    let during: string
    try {
      const c = await screenAsOpposing(f)
      during = `${c.result}${hitsConflict(c) ? "+HIT" : ""}`
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      during = `ERR ${err.status} ${err.code}`
    } finally {
      refProto.get = refGet
      txProto.get = txGet
    }
    console.log(`F37-FU partial rebuild race: during=${during}`)
    expect(armed).toBe(false)
    expect(during === "ERR 503 screening_unavailable" || during.endsWith("+HIT")).toBe(true)
    // The (schema-less) state refuses until the reconciliation rebuilds it whole.
    expectKind(await apiErrorOf(screenAsOpposing(f)), "unavailable", "screening_unavailable")
    await reconcileNameIndex(f.firmId)
    expect(hitsConflict(await screenAsOpposing(f))).toBe(true)
  }, 180_000)
})

describe.skipIf(!EMULATORS)("FA-D1C-004: a name removed from inside an otherwise valid chunk makes the screen refuse", () => {
  it("CT2: the conflicting name removed from chunk 0 out of band", async () => {
    const f = await registeredFirm([CONFLICT])
    const ref = nameIndexChunkRef(f.firmId, 0)
    await outOfBand(ref, () => ref.update({ names: FieldValue.arrayRemove(CONFLICT) }), f.firmId)
    await expectRefusedThenHealed(f, screenAsOpposing)
  }, 180_000)
})

describe.skipIf(!EMULATORS)("FA-D1C-002 controls: the product writers and deletions do not trip the triggers", () => {
  it("registerClient, openMatter's parties and closeMatter's party updates leave the index current; a deletion leaves it current", async () => {
    const f = await registeredFirm(["Zubair Hashmi"])
    const t = await triggers()
    const deliver = async (ref: DocumentReference, before: DocumentData | undefined) => {
      if (t) await t.registryRowWritten(ref.parent.id, ref.id, before, (await ref.get()).data(), Date.now())
    }
    const clientRef = adminDb().collection("clients").doc(f.clients["Zubair Hashmi"])
    await deliver(clientRef, undefined)
    const check = await runCheck({ token: f.token, data: { firmId: f.firmId, client: { clientId: f.clientId }, opposingParties: [{ name: "Omer Daryani" }] } } as never)
    const opened = await openMatter({ token: f.token, data: { firmId: f.firmId, conflictCheckId: check.checkId, title: "Recovery suit", classification: "confidential" } } as never)
    const parties = (await rows("matter_parties", f.firmId)).filter((d) => d.data().matterId === opened.matterId)
    for (const p of parties) await deliver(p.ref, undefined)
    const beforeClose = new Map(parties.map((p) => [p.id, p.data()]))
    await closeMatter({ token: f.token, data: { firmId: f.firmId, matterId: opened.matterId, reason: "Settled between the parties out of court." } } as never)
    for (const p of parties) await deliver(p.ref, beforeClose.get(p.id))
    const state = await readRegistryState(f.firmId)
    expect(state.nameIndex.version).toBe(state.version)
    expect(state.nameIndex.schema).not.toBeNull()

    // A deleted client's name may stay in the index (it finds no row, so no hit); the index stays current.
    const before = (await clientRef.get()).data()
    await clientRef.delete()
    if (t) await t.registryRowWritten("clients", clientRef.id, before, undefined, Date.now())
    const after = await readRegistryState(f.firmId)
    expect(after.nameIndex.version).toBe(after.version)
    expect((await screenAsOpposing(f)).result).toBe("CLEAR")
  }, 180_000)
})
