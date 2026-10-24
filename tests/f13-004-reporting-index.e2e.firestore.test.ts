// Audit F13 FA-F13-004 (reporting-index slice): the Next repository reads `matter_client_search_index` rows through
// one validator, not a blind `getById<MatterClientSearchIndexRow>` cast. A malformed stored row is denied (thrown,
// never served from this process's cache) and a refused write leaves storage unchanged. Firestore emulator.
import { describe, expect, it, vi } from "vitest"
import { GET as reportingGet } from "@/app/api/d1/reporting/route"
import { createFirestoreRepositories } from "@/platform/persistence/firestoreSpineRepositories"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import type { MatterClientSearchIndexRow } from "@/platform/spine/store"
import { adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS } from "@/tests/helpers/emulator-require"
import { uniq } from "@/functions/test/emu"

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const repo = () => createFirestoreRepositories(adminDb() as never)

function good(firmId: string, id: string): MatterClientSearchIndexRow {
  return {
    id,
    firmId,
    rowType: "matter",
    referenceId: "mat_1",
    classification: "internal",
    label: "Indexed",
    detail: "",
    linkedMatterId: "mat_1",
    linkedClientId: "client_1",
    status: "engagement_unconfirmed:pending",
    tags: ["indexed"],
    updatedAt: 1,
  }
}

async function stored(row: Record<string, unknown>): Promise<string> {
  const id = uniq("idx")
  await adminDb().collection("matter_client_search_index").doc(id).set(row)
  return id
}

function matterDoc(firmId: string, matterId: string, title: string): Record<string, unknown> {
  return {
    firmId,
    clientId: "client_1",
    title,
    classification: "internal",
    status: "engagement_unconfirmed",
    stage: "pre_filing",
    caseNumberStatus: "pending",
    courtId: "SHC",
    caseNumber: null,
    matterNo: null,
    conflictCheckId: null,
    createdBy: "partner_idx",
  }
}

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F13 FA-F13-004: the search index is read through the validator", () => {
  it("a well-formed row reads back, and the document id wins over a stored id field", async () => {
    const firmId = uniq("f13ri")
    const id = await stored({ ...good(firmId, "forged"), id: "forged" })
    const row = await repo().reportingIndex.get(id, firmId)
    expect(row).toMatchObject({ id, firmId, label: "Indexed", detail: "", rowType: "matter" })
  })

  it.each([
    ["classification as a number", { classification: 1 }],
    ["an unknown classification", { classification: "top-secret" }],
    ["an unknown rowType", { rowType: "both" }],
    ["detail null", { detail: null }],
    ["detail as a number", { detail: 12 }],
    ["tags as a string", { tags: "indexed" }],
    ["a non-string tag", { tags: ["indexed", 1] }],
    ["label as a number", { label: 5 }],
    ["an empty referenceId", { referenceId: "" }],
    ["linkedMatterId absent", { linkedMatterId: undefined }],
    ["an empty linkedMatterId", { linkedMatterId: "" }],
    ["linkedClientId as a number", { linkedClientId: 4 }],
    ["status as a number", { status: 1 }],
    ["updatedAt as a string", { updatedAt: "1" }],
    // FA-F13-020: these fail the firm equality check inside getById, which returns null before the reader runs.
    ["firmId as a number", { firmId: 12 }],
    ["firmId null", { firmId: null }],
    ["firmId as a boolean", { firmId: true }],
    ["an empty firmId", { firmId: "" }],
    ["a whitespace firmId", { firmId: "   " }],
  ])("a row with %s is refused by get and upsert, and left out of listByFirm", async (_label, patch) => {
    const firmId = uniq("f13ri")
    const row: Record<string, unknown> = { ...good(firmId, "pending"), ...patch }
    for (const key of Object.keys(row)) if (row[key] === undefined) delete row[key]
    const id = await stored(row)
    const okId = await stored(good(firmId, "ok"))
    await expect(repo().reportingIndex.get(id, firmId)).rejects.toThrow(/malformed/)
    await expect(repo().reportingIndex.upsert(good(firmId, id))).rejects.toThrow(/malformed/)
    const listed = (await repo().reportingIndex.listByFirm(firmId)).map((item) => item.id)
    expect(listed).toEqual([okId])
  })

  it("an upsert of a malformed row is refused before it writes: nothing is created", async () => {
    const firmId = uniq("f13ri")
    const id = uniq("idx")
    await expect(repo().reportingIndex.upsert({ ...good(firmId, id), rowType: "both" } as never)).rejects.toThrow(/malformed/)
    expect((await adminDb().collection("matter_client_search_index").doc(id).get()).exists).toBe(false)
  })

  it("an upsert whose result would be malformed is refused before it writes: storage is unchanged", async () => {
    const firmId = uniq("f13ri")
    const id = uniq("idx")
    await repo().reportingIndex.upsert(good(firmId, id))
    await expect(repo().reportingIndex.upsert({ ...good(firmId, id), label: 9 } as never)).rejects.toThrow(/malformed/)
    expect(await adminDb().collection("matter_client_search_index").doc(id).get().then((doc) => doc.data())).toMatchObject({
      label: "Indexed",
      classification: "internal",
    })
  })

  it("an upsert that would repair a malformed row is still refused: the stored row is checked before the write", async () => {
    const firmId = uniq("f13ri")
    const id = await stored({ ...good(firmId, "pending"), detail: null })
    await expect(repo().reportingIndex.upsert(good(firmId, id))).rejects.toThrow(/malformed/)
    expect(await adminDb().collection("matter_client_search_index").doc(id).get().then((doc) => doc.data())).toMatchObject({
      detail: null,
      label: "Indexed",
    })
  })

  it("a row owned by another firm is null, including when the rest of that row is malformed", async () => {
    const firmId = uniq("f13ri")
    const other = uniq("f13ri")
    const foreignId = await stored(good(other, "foreign"))
    const foreignBadId = await stored({ ...good(other, "foreign-bad"), detail: null })
    expect(await repo().reportingIndex.get(foreignId, firmId)).toBeNull()
    expect(await repo().reportingIndex.get(foreignBadId, firmId)).toBeNull()
    expect(await adminDb().collection("matter_client_search_index").doc(foreignBadId).get().then((doc) => doc.data())).toMatchObject({
      firmId: other,
      detail: null,
    })
  })

  it("a get of a malformed row throws (distinguishable from absence), and an absent row is null", async () => {
    const firmId = uniq("f13ri")
    const id = await stored({ ...good(firmId, "pending"), rowType: "both" })
    await expect(repo().reportingIndex.get(id, firmId)).rejects.toThrow(/malformed/)
    expect(await repo().reportingIndex.get(uniq("noidx"), firmId)).toBeNull()
  })

  it("a search does not republish a malformed index row or serve this process's cached copy", async () => {
    resetRuntimeStoreForTests()
    process.env.SIKANDER_PERSISTENCE_MODE = "firestore"
    setFirestorePersistenceForTests(adminDb())
    try {
      const firmId = uniq("f13ri")
      const actorId = uniq("partner")
      const badMatter = uniq("mat")
      const healthyMatter = uniq("mat")
      const badTitle = `bad-title-${badMatter}`
      const healthyTitle = `healthy-title-${healthyMatter}`
      const indexId = `matter:${badMatter}`
      getRuntimeStore().users.set(actorId, {
        id: actorId,
        firmId,
        role: "partner",
        clearanceLevel: "privileged-restricted",
        active: true,
      })
      await adminDb().collection("matters").doc(badMatter).set(matterDoc(firmId, badMatter, badTitle))
      await adminDb().collection("matters").doc(healthyMatter).set(matterDoc(firmId, healthyMatter, healthyTitle))
      await adminDb().collection("matter_client_search_index").doc(indexId).set({
        ...good(firmId, indexId),
        referenceId: badMatter,
        linkedMatterId: badMatter,
        label: "MALFORMED STORED",
        tags: "not-an-array",
      })
      getRuntimeStore().matterClientSearchIndex.set(indexId, {
        ...good(firmId, indexId),
        referenceId: badMatter,
        linkedMatterId: badMatter,
        label: "STALE CACHE LABEL",
      })

      const res = await reportingGet(new Request(`http://127.0.0.1/api/d1/reporting?actorId=${actorId}&limit=50&cursor=0`))
      expect(res.status).toBe(200)
      const body = await res.json() as { items: Array<{ label: string; id: string }> }
      const labels = body.items.map((item) => item.label)
      expect(labels).toContain(healthyTitle)
      expect(labels).not.toContain(badTitle)
      expect(labels).not.toContain("MALFORMED STORED")
      expect(labels).not.toContain("STALE CACHE LABEL")
      expect(getRuntimeStore().matterClientSearchIndex.has(indexId)).toBe(false)
      expect(await adminDb().collection("matter_client_search_index").doc(indexId).get().then((doc) => doc.data())).toMatchObject({
        label: "MALFORMED STORED",
        tags: "not-an-array",
      })
    } finally {
      delete process.env.SIKANDER_PERSISTENCE_MODE
      setFirestorePersistenceForTests(null)
    }
  })
})
