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

  it("FA-F13-026: a non-string or blank stored firmId throws before the firm gate", async () => {
    const firmId = uniq("f13d4firm")
    for (const badFirm of [12, null, "", "   "] as const) {
      const id = await stored({ ...good(firmId), firmId: badFirm })
      await expect(repo().documents.get(id, firmId)).rejects.toMatchObject({
        name: "DocumentMalformedError",
        documentId: id,
      })
    }
    const foreignId = await stored(good(uniq("other")))
    expect(await repo().documents.get(foreignId, firmId)).toBeNull()
  })
  it("an update that would repair a malformed row is still refused: the stored row is checked before the merge (Codex P2)", async () => {
    const firmId = uniq("f13d4firm")
    const id = await stored({ ...good(firmId), byteSize: "12" })
    await expect(repo().documents.update(id, firmId, { byteSize: 12, classification: "confidential" })).rejects.toThrow(/malformed/)
    expect(await adminDb().collection("documents").doc(id).get().then((d) => d.data())).toMatchObject({ byteSize: "12", classification: "internal" })
  })
})

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F13 FA-F13-028: documents.create validates before it writes", () => {
  it("a malformed create throws and the document is not created", async () => {
    const firmId = uniq("f13d21firm")
    const id = uniq("doc")
    await expect(repo().documents.create({ ...good(firmId), id, byteSize: "12" } as never)).rejects.toMatchObject({
      name: "DocumentMalformedError",
      documentId: id,
    })
    expect((await adminDb().collection("documents").doc(id).get()).exists).toBe(false)
  })

  it("a blank id is refused and nothing is written", async () => {
    const firmId = uniq("f13d21firm")
    await expect(repo().documents.create({ ...good(firmId), id: "   " } as never)).rejects.toMatchObject({
      name: "DocumentMalformedError",
      documentId: "unknown",
    })
  })

  it("a create with no objectBytesStatus stores the canonical missing status", async () => {
    const firmId = uniq("f13d21firm")
    const id = uniq("doc")
    const row: Record<string, unknown> = { ...good(firmId), id }
    delete row.objectBytesStatus
    await repo().documents.create(row as never)
    expect((await adminDb().collection("documents").doc(id).get()).data()).toMatchObject({
      id,
      objectBytesStatus: "missing",
      byteSize: 12,
    })
  })
})

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F13 FA-F13-029: listByFirm reports dropped rows, and the bytes backfill stamps only the missing status", () => {
  it("listByFirm keeps the valid row and names the invalid one", async () => {
    const firmId = uniq("f13d22firm")
    const badId = await stored({ ...good(firmId), byteSize: "12" })
    const okId = await stored(good(firmId))
    const otherFirm = uniq("f13d22other")
    await stored({ ...good(otherFirm), byteSize: "nope" })
    const listed = await repo().documents.listByFirm(firmId)
    expect(listed.map((row) => row.id)).toEqual([okId])
    expect((listed as { droppedDocuments?: { id: string; reason: string }[] }).droppedDocuments).toEqual([
      { id: badId, reason: "byteSize" },
    ])
  })

  it("a pre-status row is stamped missing and a malformed row is reported, not rewritten", async () => {
    const firmId = uniq("f13d22firm")
    const legacy = good(firmId)
    delete legacy.objectBytesStatus
    const legacyId = await stored(legacy)
    const badId = await stored({ ...good(firmId), byteSize: "12" })
    const mod = await import("@/platform/persistence/documentBytesBackfill")
    const admin = await import("@/scripts/lib/documentBytesBackfillAdmin")
    const rows = await admin.readDocumentRows(adminDb() as never)
    const plan = mod.planDocumentBytesBackfill(rows.filter((row) => row.data.firmId === firmId))
    expect(plan.stamp).toContainEqual({ id: legacyId, patch: { objectBytesStatus: "missing" } })
    expect(plan.malformed).toContainEqual({ id: badId, path: `documents/${badId}`, reason: "byteSize" })
    expect(plan.stamp.map((row) => row.id)).not.toContain(badId)
    const res = await mod.applyDocumentBytesBackfill(admin.adminDocumentBytesBackfillStore(adminDb() as never), plan)
    expect(res.applied).toContain(`documents/${legacyId}`)
    expect(res.applied).not.toContain(`documents/${badId}`)
    expect((await adminDb().collection("documents").doc(legacyId).get()).data()).toMatchObject({ objectBytesStatus: "missing" })
    expect((await adminDb().collection("documents").doc(badId).get()).data()).toMatchObject({ byteSize: "12", objectBytesStatus: "available" })
  })

  it("the document-bytes dry-run names the row and writes nothing", async () => {
    const { execFileSync } = await import("node:child_process")
    const firmId = uniq("f13d22firm")
    const legacy = good(firmId)
    delete legacy.objectBytesStatus
    const id = await stored(legacy)
    const out = execFileSync("npm", ["run", "-s", "backfill:document-bytes", "--", "--project", process.env.GCLOUD_PROJECT ?? "demo-sikander"], {
      env: { ...process.env },
      encoding: "utf8",
    })
    expect(out).toContain("[backfill-document-bytes] DRY-RUN")
    expect(out).toContain(`[backfill-document-bytes] documents/${id} objectBytesStatus`)
    expect((await adminDb().collection("documents").doc(id).get()).data()?.objectBytesStatus).toBeUndefined()
  })
})
