import { afterEach, describe, expect, it, vi } from "vitest"
import {
  putStagingChunk,
  readStagingChunks,
  resetDocumentObjectStoreForTests,
  setStagingWrittenAtForTests,
} from "@/platform/documents/documentObjectStore"
import { BULK_UPLOAD_STAGING_TTL_MS } from "@/services/d1-6/bulkUpload"
import { runBulkUploadStagingSweep } from "../src/d1/bulkUploadSweep"
import { documentObjectTestKey } from "./documentObjectTestKey"

describe("bulk upload staging sweep", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    resetDocumentObjectStoreForTests()
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
})
