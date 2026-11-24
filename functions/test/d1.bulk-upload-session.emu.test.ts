import { afterEach, describe, expect, it, vi } from "vitest"
import { resetDocumentObjectStoreForTests } from "@/platform/documents/documentObjectStore"
import { resetUploadStagingForTests } from "@/platform/documents/uploadStagingStore"
import { uploadSessionsOf } from "@/platform/spine/bulkUploadSession"
import { newStore } from "@/platform/spine/store"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import {
  bulkDeclaredHash,
  finaliseFile,
  parseStoredUploadSession,
  startBulkUpload,
  uploadChunk,
  type BulkUploadCaller,
} from "@/services/d1-6/bulkUpload"
import { adminDb } from "../src/admin"
import { documentObjectTestKey } from "./documentObjectTestKey"
import { EMULATORS } from "./emu"

/**
 * The Firestore emulator is the real field-path implementation. A `files.<index>`
 * update turns the array into a map; the transaction write must leave an array
 * that parseStoredUploadSession accepts, including when two instances finalise
 * different files.
 */
const FLAG = "SIKANDER_FLAG_D1_BULK_UPLOAD"
const caller: BulkUploadCaller = { userId: "partner_a", firmId: "firmA" }
const created: string[] = []

function fileOf(bytes: Buffer, store: ReturnType<typeof newStore>, name: string) {
  return {
    name,
    size: bytes.length,
    sha256: bulkDeclaredHash(store, "firmA", bytes),
    classification: "internal" as const,
  }
}

describe.skipIf(!EMULATORS)("upload session file transaction (emulator)", () => {
  afterEach(async () => {
    setFirestorePersistenceForTests(null)
    vi.unstubAllEnvs()
    resetDocumentObjectStoreForTests()
    resetUploadStagingForTests()
    await Promise.all(created.splice(0).map((id) => adminDb().collection("upload_sessions").doc(id).delete()))
  })

  async function withFirestore(): Promise<void> {
    vi.stubEnv(FLAG, "true")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_BACKEND", "memory")
    vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY", documentObjectTestKey())
    setFirestorePersistenceForTests(adminDb())
  }

  it("a chunk write to one of three files leaves an array the parser accepts", async () => {
    await withFirestore()
    const store = newStore()
    const first = Buffer.from("emu-file-a")
    const middle = Buffer.from("emu-file-b")
    const last = Buffer.from("emu-file-c")
    const started = await startBulkUpload(
      store,
      "firmA",
      "m1",
      [
        fileOf(first, store, "a.pdf"),
        fileOf(middle, store, "b.pdf"),
        fileOf(last, store, "c.pdf"),
      ],
      caller
    )
    created.push(started.sessionId)
    await uploadChunk(store, started.sessionId, 1, 1, middle, caller)
    const snap = await adminDb().collection("upload_sessions").doc(started.sessionId).get()
    const data = snap.data()
    expect(data).toBeTruthy()
    expect(Array.isArray(data?.files)).toBe(true)
    const parsed = parseStoredUploadSession(started.sessionId, data as Record<string, unknown>)
    expect(parsed?.files.map((file) => file.name)).toEqual(["a.pdf", "b.pdf", "c.pdf"])
    expect(parsed?.files[0]?.state).toBe("pending")
    expect(parsed?.files[1]?.receivedChunks).toEqual([1])
    expect(parsed?.files[2]?.receivedChunks).toEqual([])
  })

  it("two instances finalising different files both survive on the emulator", async () => {
    await withFirestore()
    const leftStore = newStore()
    const rightStore = newStore()
    const left = Buffer.from("emu-left")
    const right = Buffer.from("emu-right")
    const started = await startBulkUpload(
      leftStore,
      "firmA",
      "m1",
      [fileOf(left, leftStore, "left.pdf"), fileOf(right, leftStore, "right.pdf")],
      caller
    )
    created.push(started.sessionId)
    await uploadChunk(leftStore, started.sessionId, 0, 1, left, caller)
    await uploadChunk(leftStore, started.sessionId, 1, 1, right, caller)
    uploadSessionsOf(rightStore).clear()
    const [first, second] = await Promise.all([
      finaliseFile(leftStore, started.sessionId, 0, caller),
      finaliseFile(rightStore, started.sessionId, 1, caller),
    ])
    const snap = await adminDb().collection("upload_sessions").doc(started.sessionId).get()
    const data = snap.data()
    expect(Array.isArray(data?.files)).toBe(true)
    const parsed = parseStoredUploadSession(started.sessionId, data as Record<string, unknown>)
    expect(parsed?.files.map((file) => file.state)).toEqual(["finalised", "finalised"])
    expect(parsed?.files[0]?.docId).toBe(first.docId)
    expect(parsed?.files[1]?.docId).toBe(second.docId)
  })
})
