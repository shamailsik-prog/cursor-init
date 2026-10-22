// Audit F13 FA-F13-004 (documents slice): the Next repository reads `documents` rows through one validator, not a
// blind `getById<DocumentRecord>` cast. Firestore emulator.
import { describe, expect, it } from "vitest"
import { createFirestoreRepositories } from "@/platform/persistence/firestoreSpineRepositories"
import { adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS } from "@/tests/helpers/emulator-require"
import { uniq } from "@/functions/test/emu"

const repo = () => createFirestoreRepositories(adminDb() as never)

const good = (firmId: string): Record<string, unknown> => ({
  firmId, matterId: null, contentHash: "sha256:ab", sourceChannel: "web", classification: "internal",
  storagePath: "firm/obj", isImmutable: true, byteSize: 12, mimeType: "application/pdf", objectVersion: 1,
  uploadedBy: "u_up", objectBytesStatus: "available",
})

async function stored(row: Record<string, unknown>): Promise<string> {
  const id = uniq("doc")
  await adminDb().collection("documents").doc(id).set(row)
  return id
}

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F13 FA-F13-004: documents are read through the validator", () => {
  it("a well-formed row reads back, and the document id wins over a stored id field", async () => {
    const firmId = uniq("f13d4firm")
    const id = await stored({ ...good(firmId), id: "forged" })
    const row = await repo().documents.get(id, firmId)
    expect(row).toMatchObject({ id, firmId, byteSize: 12, objectBytesStatus: "available" })
  })

  it.each([
    ["byteSize as a string", { byteSize: "12" }],
    ["a negative byteSize", { byteSize: -1 }],
    ["an unknown sourceChannel", { sourceChannel: "fax" }],
    ["an unknown classification", { classification: "top-secret" }],
    ["isImmutable as a string", { isImmutable: "yes" }],
    ["a non-integer objectVersion", { objectVersion: 1.5 }],
    ["matterId absent (never read as the loose vault)", { matterId: undefined }],
    ["matterId as a number", { matterId: 7 }],
    ["an empty uploadedBy", { uploadedBy: "" }],
    ["storagePath absent", { storagePath: undefined }],
    ["an unknown objectBytesStatus", { objectBytesStatus: "maybe" }],
  ])("a row with %s is refused by get, update and listByFirm", async (_label, patch) => {
    const firmId = uniq("f13d4firm")
    const row: Record<string, unknown> = { ...good(firmId), ...patch }
    for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k]
    const id = await stored(row)
    const okId = await stored(good(firmId))
    await expect(repo().documents.get(id, firmId)).rejects.toThrow(/malformed/)
    await expect(repo().documents.update(id, firmId, { mimeType: "application/pdf" })).rejects.toThrow(/malformed/)
    const listed = (await repo().documents.listByFirm(firmId)).map((d) => d.id)
    expect(listed).toEqual([okId])
  })

  it("a row with no objectBytesStatus reads as missing (bytes unverified), never available", async () => {
    const firmId = uniq("f13d4firm")
    const row = good(firmId)
    delete row.objectBytesStatus
    const id = await stored(row)
    expect((await repo().documents.get(id, firmId))?.objectBytesStatus).toBe("missing")
  })
  it("an update of a malformed row is refused before it writes: storage is unchanged (Codex P2)", async () => {
    const firmId = uniq("f13d4firm")
    const id = await stored({ ...good(firmId), byteSize: "12" })
    await expect(repo().documents.update(id, firmId, { classification: "privileged-restricted", matterId: "m_x" })).rejects.toThrow(/malformed/)
    expect(await adminDb().collection("documents").doc(id).get().then((d) => d.data())).toMatchObject({ classification: "internal", matterId: null })
  })

  it("an update whose result would be malformed is refused before it writes: storage is unchanged (Codex P2)", async () => {
    const firmId = uniq("f13d4firm")
    const id = await stored(good(firmId))
    await expect(repo().documents.update(id, firmId, { byteSize: "big" as never, classification: "confidential" })).rejects.toThrow(/malformed/)
    expect(await adminDb().collection("documents").doc(id).get().then((d) => d.data())).toMatchObject({ byteSize: 12, classification: "internal" })
  })

  it("a get of a malformed row throws (distinguishable from absence), and an absent row is null", async () => {
    const firmId = uniq("f13d4firm")
    const id = await stored({ ...good(firmId), sourceChannel: "fax" })
    await expect(repo().documents.get(id, firmId)).rejects.toThrow(/malformed/)
    expect(await repo().documents.get(uniq("nodoc"), firmId)).toBeNull()
  })
  it("an update that would repair a malformed row is still refused: the stored row is checked before the merge (Codex P2)", async () => {
    const firmId = uniq("f13d4firm")
    const id = await stored({ ...good(firmId), byteSize: "12" })
    await expect(repo().documents.update(id, firmId, { byteSize: 12, classification: "confidential" })).rejects.toThrow(/malformed/)
    expect(await adminDb().collection("documents").doc(id).get().then((d) => d.data())).toMatchObject({ byteSize: "12", classification: "internal" })
  })
})
