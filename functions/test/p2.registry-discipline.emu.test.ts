import { beforeAll, describe, expect, it } from "vitest"
import { FieldPath, type DocumentReference, type Firestore } from "firebase-admin/firestore"
import { adminDb } from "../src/admin"
import { loadRegistry } from "../src/d1/conflict/engine"
import { nameIndexChunkRef, stageRegistryWrite } from "../src/d1/conflict/nameIndex"
import { bumpRegistryVersion, readRegistryStateTx, REGISTRY_SCOPE } from "../src/d1/registryVersion"
import { EMULATORS, uniq } from "./emu"
import { registryRecorder } from "./setup/registryWriteRecorder"

/**
 * Spec P3-20: the registry-version write recorder (test/setup/registryWriteRecorder.ts, a vitest
 * setup file over every functions test) fails any test in which code under functions/src writes a
 * collection that `loadRegistry` reads without bumping the firm's registry version in that write's
 * own transaction. These two tests are selected by exact name by the G-4 Phase 3a gate.
 */

const T0 = Date.parse("2026-10-08T09:00:00.000Z")

describe.skipIf(!EMULATORS)("Registry-version discipline (P3-20)", () => {
  let db: Firestore
  let firmId: string
  let firmRef: DocumentReference
  let clientRef: DocumentReference
  let matterRef: DocumentReference
  let linkRef: DocumentReference

  beforeAll(async () => {
    db = adminDb()
    firmId = uniq("firm")
    firmRef = db.collection("firms").doc(firmId)
    clientRef = db.collection("clients").doc(uniq("client"))
    matterRef = db.collection("matters").doc(uniq("matter"))
    linkRef = db.collection("entity_links").doc(uniq("link"))
    await firmRef.set({ name: "F", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
    await clientRef.set({ firmId, name: "C", classification: "internal" })
    await matterRef.set({ firmId, title: "M", stage: "intake", status: "live", classification: "internal" })
    await linkRef.set({ firmId, state: "candidate", classification: "internal" })
  })

  it("registry discipline: a product transaction that writes a registry collection without bumpRegistryVersion is reported", async () => {
    registryRecorder.attributeTo("functions/src/fake/product.ts:1")
    try {
      await db.runTransaction(async (tx) => tx.update(clientRef, { name: "X" }))
      expect(registryRecorder.take()).toEqual([{ file: "functions/src/fake/product.ts", line: 1, collection: "clients", reason: "no_bump" }])
      await db.runTransaction(async (tx) => {
        tx.update(clientRef, { name: "Y" })
        bumpRegistryVersion(tx, firmId)
      })
      expect(registryRecorder.take()).toEqual([])
      await db.runTransaction(async (tx) => tx.update(matterRef, { stage: "filed" }))
      expect(registryRecorder.take()).toEqual([])
      await db.runTransaction(async (tx) => tx.update(matterRef, { title: "T" }))
      expect(registryRecorder.take().map((v) => v.collection)).toEqual(["matters"])
      await db.runTransaction(async (tx) => tx.set(firmRef, { clientPrefix: "AB" }, { merge: true }))
      expect(registryRecorder.take()).toEqual([])
      await db.runTransaction(async (tx) => tx.set(firmRef, { featureFlags: { L17_2_ENABLED: false } }, { merge: true }))
      expect(registryRecorder.take().map((v) => v.collection)).toEqual(["firms"])
      await linkRef.update({ state: "rejected" })
      expect(registryRecorder.take().map((v) => v.reason)).toEqual(["outside_transaction"])
    } finally {
      registryRecorder.attributeTo(null)
    }
    await db.runTransaction(async (tx) => tx.update(clientRef, { name: "Z" }))
    expect(registryRecorder.take()).toEqual([]) // a test-file write
  })

  it("registry discipline: loadRegistry reads exactly the collections in REGISTRY_SCOPE", async () => {
    const reads = await registryRecorder.readsDuring(() => loadRegistry(firmId, new Date(T0)))
    expect([...reads].sort()).toEqual(Object.keys(REGISTRY_SCOPE).sort())
  })
})

// Edge cases of the recorder's rules (not gate-selected; the gate runs the two tests above by name).
describe.skipIf(!EMULATORS)("Registry-version recorder rules (P3-20)", () => {
  let db: Firestore
  let firmId: string
  let firmRef: DocumentReference
  let matterRef: DocumentReference

  beforeAll(async () => {
    db = adminDb()
    firmId = uniq("firm")
    firmRef = db.collection("firms").doc(firmId)
    matterRef = db.collection("matters").doc(uniq("matter"))
    await firmRef.set({ name: "F", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
    await matterRef.set({ firmId, title: "M", stage: "intake", status: "live", classification: "internal" })
  })

  const asProduct = async (fn: () => Promise<unknown>) => {
    registryRecorder.attributeTo("functions/src/fake/product.ts:7")
    try {
      await fn()
      return registryRecorder.take().map((v) => `${v.collection}:${v.reason}`)
    } finally {
      registryRecorder.attributeTo(null)
    }
  }

  it("a firms create counts only when its data names featureFlags (onboardFirm is not a registry write)", async () => {
    const a = db.collection("firms").doc(uniq("firm"))
    const b = db.collection("firms").doc(uniq("firm"))
    expect(await asProduct(() => db.runTransaction(async (tx) => tx.create(a, { name: "N", plan: "internal" })))).toEqual([])
    expect(await asProduct(() => db.runTransaction(async (tx) => tx.create(b, { name: "N", featureFlags: {} })))).toEqual(["firms:no_bump"])
    expect(await asProduct(() => db.runTransaction(async (tx) => tx.set(matterRef, { stage: "x" })))).toEqual([])
  })

  it("a delete always counts; the bump must name the written row's firm when its data names one", async () => {
    const c1 = db.collection("clients").doc(uniq("client"))
    const c2 = db.collection("clients").doc(uniq("client"))
    await c1.set({ firmId, name: "C" })
    expect(await asProduct(() => db.runTransaction(async (tx) => tx.delete(c1)))).toEqual(["clients:no_bump"])
    expect(await asProduct(() => db.runTransaction(async (tx) => { tx.delete(c2); bumpRegistryVersion(tx, firmId) }))).toEqual([])
    expect(
      await asProduct(() => db.runTransaction(async (tx) => { tx.set(c2, { firmId, name: "C" }); bumpRegistryVersion(tx, "other-firm") }))
    ).toEqual(["clients:no_bump"])
    expect(await asProduct(() => db.runTransaction(async (tx) => { tx.update(c2, { name: "D" }); bumpRegistryVersion(tx, "other-firm") }))).toEqual([])
  })

  it("field paths: varargs, FieldPath and dotted keys use their top-level segment; mergeFields limits a merge set", async () => {
    expect(await asProduct(() => db.runTransaction(async (tx) => tx.update(matterRef, "stage", "filed")))).toEqual([])
    expect(await asProduct(() => db.runTransaction(async (tx) => tx.update(matterRef, new FieldPath("title"), "T")))).toEqual(["matters:no_bump"])
    expect(await asProduct(() => db.runTransaction(async (tx) => tx.update(firmRef, { "featureFlags.L17_2_ENABLED": true })))).toEqual(["firms:no_bump"])
    expect(
      await asProduct(() =>
        db.runTransaction(async (tx) => tx.set(firmRef, { clientPrefix: "Q", featureFlags: { L17_2_ENABLED: true } }, { mergeFields: ["clientPrefix"] }))
      )
    ).toEqual([])
  })

  it("a product registry write through a WriteBatch is outside_transaction; a transaction's own batch is not", async () => {
    const batch = db.batch()
    expect(await asProduct(() => batch.update(matterRef, { title: "B" }).commit())).toEqual(["matters:outside_transaction"])
    expect(
      await asProduct(() => db.runTransaction(async (tx) => { tx.update(matterRef, { title: "C" }); bumpRegistryVersion(tx, firmId) }))
    ).toEqual([])
  })
})

// Audit F37: the conflict name index rules of the recorder (not gate-selected).
describe.skipIf(!EMULATORS)("Registry recorder: the F37 conflict name index", () => {
  let db: Firestore
  let firmId: string

  beforeAll(async () => {
    db = adminDb()
    firmId = uniq("firm")
    await db.collection("firms").doc(firmId).set({ name: "F", plan: "internal" })
  })

  const asProduct = async (fn: () => Promise<unknown>) => {
    registryRecorder.attributeTo("functions/src/fake/product.ts:9")
    try {
      await fn()
      return registryRecorder.take().map((v) => `${v.collection}:${v.reason}`)
    } finally {
      registryRecorder.attributeTo(null)
    }
  }

  it("creating a named client or opposing party needs stageRegistryWrite (an index-aware bump); a bare bump is no_name_index", async () => {
    const client = () => db.collection("clients").doc(uniq("client"))
    const party = () => db.collection("matter_parties").doc(uniq("party"))
    expect(
      await asProduct(() => db.runTransaction(async (tx) => { tx.create(client(), { firmId, canonicalName: "Haris Qalbani" }); bumpRegistryVersion(tx, firmId) }))
    ).toEqual(["clients:no_name_index"])
    expect(
      await asProduct(() => db.runTransaction(async (tx) => { tx.create(party(), { firmId, role: "opposing", name: "Haris Qalbani" }); bumpRegistryVersion(tx, firmId) }))
    ).toEqual(["matter_parties:no_name_index"])
    expect(
      await asProduct(() =>
        db.runTransaction(async (tx) => {
          const state = await readRegistryStateTx(tx, firmId)
          // Staged and stamped (F37 re-audit: the stamp is what the registry trigger and the recorder check).
          tx.create(client(), { firmId, canonicalName: "Haris Qalbani", nameIndexed: { firmId, name: "Haris Qalbani" } })
          tx.create(party(), { firmId, role: "opposing", name: "Omer Daryani", nameIndexed: { firmId, name: "Omer Daryani" } })
          stageRegistryWrite(tx, firmId, state, ["Haris Qalbani", "Omer Daryani"])
        })
      )
    ).toEqual([])
    // A client-role party row is not a name the screen can hit: a bare bump is enough.
    expect(
      await asProduct(() => db.runTransaction(async (tx) => { tx.create(party(), { firmId, role: "client", name: "Omer Daryani" }); bumpRegistryVersion(tx, firmId) }))
    ).toEqual([])
    // The index-aware bump must be for the row's firm.
    expect(
      await asProduct(() =>
        db.runTransaction(async (tx) => {
          const state = await readRegistryStateTx(tx, "other-firm")
          tx.create(client(), { firmId, canonicalName: "X Y" })
          bumpRegistryVersion(tx, firmId)
          stageRegistryWrite(tx, "other-firm", state, [])
        })
      )
    ).toEqual(["clients:no_name_index"])
  })

  it("a write to the name index's chunks is a registry write: it needs a bump in its transaction", async () => {
    expect(
      await asProduct(() => db.runTransaction(async (tx) => tx.set(nameIndexChunkRef(firmId, 0), { firmId, names: ["A"] }, { merge: true })))
    ).toEqual(["conflict_name_index:no_bump"])
    expect(
      await asProduct(() =>
        db.runTransaction(async (tx) => {
          tx.set(nameIndexChunkRef(firmId, 0), { firmId, names: ["A"] }, { merge: true })
          bumpRegistryVersion(tx, firmId)
        })
      )
    ).toEqual([])
  })
})

// F37 re-audit FA-D1C-005: every product write that sets a screened name (a client's canonicalName, an opposing party's
// name, a role flip to opposing, a move between firms; by create, set or update) must stage that exact name for that
// firm in the same transaction and stamp the row's `nameIndexed` with it.
describe.skipIf(!EMULATORS)("Registry recorder: every screened name a product write sets is staged and stamped (F37 re-audit)", () => {
  let db: Firestore
  let firmId: string

  beforeAll(async () => {
    db = adminDb()
    firmId = uniq("firm")
    await db.collection("firms").doc(firmId).set({ name: "F", plan: "internal" })
  })

  const asProduct = async (fn: () => Promise<unknown>) => {
    registryRecorder.attributeTo("functions/src/fake/product.ts:9")
    try {
      await fn()
      return registryRecorder.take().map((v) => `${v.collection}:${v.reason}`)
    } finally {
      registryRecorder.attributeTo(null)
    }
  }
  const stamp = (name: string) => ({ nameIndexed: { firmId, name } })

  it("a rename by update, a create by non-merge set, a role flip and a move between firms, each with a bare bump, are no_name_index", async () => {
    const client = db.collection("clients").doc(uniq("client"))
    await client.set({ firmId, canonicalName: "Zubair Hashmi", ...stamp("Zubair Hashmi") })
    const party = db.collection("matter_parties").doc(uniq("party"))
    await party.set({ firmId, role: "client", name: "Haris Qalbani" })
    const elsewhere = db.collection("clients").doc(uniq("client"))
    await elsewhere.set({ firmId: "other-firm", canonicalName: "Omer Daryani" })

    expect(await asProduct(() => db.runTransaction(async (tx) => { tx.update(client, { canonicalName: "Haris Qalbani" }); bumpRegistryVersion(tx, firmId) }))).toEqual(["clients:no_name_index"])
    expect(
      await asProduct(() => db.runTransaction(async (tx) => { tx.set(db.collection("clients").doc(uniq("client")), { firmId, canonicalName: "Haris Qalbani", ...stamp("Haris Qalbani") }); bumpRegistryVersion(tx, firmId) }))
    ).toEqual(["clients:no_name_index"])
    expect(await asProduct(() => db.runTransaction(async (tx) => { tx.update(party, { role: "opposing" }); bumpRegistryVersion(tx, firmId) }))).toEqual(["matter_parties:no_name_index"])
    expect(await asProduct(() => db.runTransaction(async (tx) => { tx.update(elsewhere, { firmId }); bumpRegistryVersion(tx, firmId) }))).toEqual(["clients:no_name_index"])
  })

  it("a create staged with an empty or another name list is no_name_index; a staged, stamped create passes; an unstamped one is no_name_stamp", async () => {
    const created = (name: string, extra: Record<string, unknown> = {}) =>
      db.runTransaction(async (tx) => {
        const state = await readRegistryStateTx(tx, firmId)
        tx.create(db.collection("clients").doc(uniq("client")), { firmId, canonicalName: name, ...extra })
        return state
      })
    expect(
      await asProduct(() =>
        db.runTransaction(async (tx) => {
          const state = await readRegistryStateTx(tx, firmId)
          tx.create(db.collection("clients").doc(uniq("client")), { firmId, canonicalName: "Haris Qalbani", ...stamp("Haris Qalbani") })
          stageRegistryWrite(tx, firmId, state, [])
        })
      )
    ).toEqual(["clients:no_name_index"])
    expect(
      await asProduct(() =>
        db.runTransaction(async (tx) => {
          const state = await readRegistryStateTx(tx, firmId)
          tx.create(db.collection("clients").doc(uniq("client")), { firmId, canonicalName: "Haris Qalbani", ...stamp("Haris Qalbani") })
          stageRegistryWrite(tx, firmId, state, ["Zubair Hashmi"])
        })
      )
    ).toEqual(["clients:no_name_index"])
    expect(
      await asProduct(() =>
        db.runTransaction(async (tx) => {
          const state = await readRegistryStateTx(tx, firmId)
          tx.create(db.collection("clients").doc(uniq("client")), { firmId, canonicalName: "Haris Qalbani" })
          stageRegistryWrite(tx, firmId, state, ["Haris Qalbani"])
        })
      )
    ).toEqual(["clients:no_name_stamp"])
    expect(
      await asProduct(() =>
        db.runTransaction(async (tx) => {
          const state = await readRegistryStateTx(tx, firmId)
          tx.create(db.collection("clients").doc(uniq("client")), { firmId, canonicalName: "Haris Qalbani", ...stamp("Haris Qalbani") })
          tx.create(db.collection("matter_parties").doc(uniq("party")), { firmId, role: "opposing", name: "Omer Daryani", ...stamp("Omer Daryani") })
          stageRegistryWrite(tx, firmId, state, ["Haris Qalbani", "Omer Daryani"])
        })
      )
    ).toEqual([])
    // Updates that leave every screened field alone (closeMatter's matterStatus) need nothing.
    const party = db.collection("matter_parties").doc(uniq("party"))
    await party.set({ firmId, role: "opposing", name: "Omer Daryani", matterStatus: "live" })
    expect(await asProduct(() => db.runTransaction(async (tx) => { tx.update(party, { matterStatus: "closed" }); bumpRegistryVersion(tx, firmId) }))).toEqual([])
    expect(created).toBeTruthy()
  })
})

