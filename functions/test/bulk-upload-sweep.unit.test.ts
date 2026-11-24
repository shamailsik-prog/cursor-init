import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  chunkFirestoreWrites,
  putStagingChunk,
  readStagingChunks,
  resetUploadStagingForTests,
  setStagingWrittenAtForTests,
  stagingDeletionAck,
  stagingDeleteCountsAsGone,
} from "@/platform/documents/uploadStagingStore"
import { resetDocumentObjectStoreForTests } from "@/platform/documents/documentObjectStore"
import { BULK_UPLOAD_STAGING_TTL_MS } from "@/services/d1-6/bulkUpload"
import { runBulkUploadStagingSweep } from "../src/d1/bulkUploadSweep"
import { documentObjectTestKey } from "./documentObjectTestKey"

describe("bulk upload staging sweep", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    resetDocumentObjectStoreForTests()
    resetUploadStagingForTests()
  })

  it("builds the document-object fixture at runtime as 32 varied bytes", () => {
    const raw = documentObjectTestKey()
    expect(raw).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(Buffer.from(raw, "hex")).size).toBeGreaterThan(1)
  })

  it("the schedule is registered and does not list storage while the flag is off", async () => {
    vi.stubEnv("SIKANDER_FLAG_D1_BULK_UPLOAD", "false")
    vi.stubEnv("SIKANDER_DOCUMENT_OBJECT_ENCRYPTION_KEY", documentObjectTestKey())
    const bytes = Buffer.from("aged-staging")
    await putStagingChunk({ firmId: "firmA", matterId: "m1", sessionId: "ups_old", fileIdx: 0, chunkIdx: 1, bytes })
    setStagingWrittenAtForTests("fs://upload-staging/firmA/m1/ups_old/0/1", 1)
    const result = await runBulkUploadStagingSweep(BULK_UPLOAD_STAGING_TTL_MS + 5)
    expect(result).toEqual({ objects: 0, sessions: 0, skipped: true })
    const still = await readStagingChunks({ firmId: "firmA", matterId: "m1", sessionId: "ups_old", fileIdx: 0, chunkCount: 1 })
    expect(still[0]?.equals(bytes)).toBe(true)
  })

  it("pins the delete statuses, the locked-bucket ack, and the 500-op batch", () => {
    expect(stagingDeleteCountsAsGone(204)).toBe(true)
    expect(stagingDeleteCountsAsGone(404)).toBe(true)
    expect(stagingDeleteCountsAsGone(403)).toBe(false)
    expect(stagingDeleteCountsAsGone(200)).toBe(false)
    expect(stagingDeleteCountsAsGone(null)).toBe(false)
    expect(stagingDeletionAck(true)).toMatchObject({ outcome: "retained", detail: { locked: true } })
    expect(stagingDeletionAck(false).outcome).toBe("purged")
    const batches = chunkFirestoreWrites(Array.from({ length: 501 }, (_, i) => i))
    expect(batches.map((batch) => batch.length)).toEqual([450, 51])
    expect(Math.max(...batches.map((batch) => batch.length))).toBeLessThanOrEqual(500)
  })

  it("keeps upload_sessions when staging shares the locked bucket and still rechecks the hold", () => {
    const src = readFileSync(new URL("../src/retention/saga.ts", import.meta.url), "utf8")
    const holdAt = src.indexOf("staging-hold-")
    const deleteAt = src.indexOf("staging-delete-")
    const sessionsAt = src.indexOf("staging-sessions-")
    expect(holdAt).toBeGreaterThan(-1)
    expect(deleteAt).toBeGreaterThan(holdAt)
    expect(sessionsAt).toBeGreaterThan(deleteAt)
    const destructive = src.slice(deleteAt, sessionsAt)
    expect(destructive.indexOf("assertNoHold")).toBeGreaterThan(-1)
    expect(destructive.indexOf("assertNoHold")).toBeLessThan(destructive.indexOf("deleteStagingObjectsByPrefix"))
    expect(src.slice(holdAt, deleteAt)).not.toContain("deleteStagingObjectsByPrefix")
    expect(src.match(/deleteStagingObjectsByPrefix/g)).toHaveLength(2)
    const purge = src.slice(src.indexOf("async function runPurge"), src.indexOf("async function acknowledge"))
    const ack = src.slice(src.indexOf("async function acknowledge"))
    expect(purge).toContain("if (stagingPlan.deleteBytes)")
    expect(purge).toContain('store.id === "firestore:upload_sessions" && !stagingPlan.deleteSessionRows')
    expect(ack).toContain('store.id === "firestore:upload_sessions" && !stagingPlan.deleteSessionRows')
    expect(ack).toContain("outcome: stagingPlan.ack.outcome")
    expect(purge).not.toContain("if (true)")
  })
})
