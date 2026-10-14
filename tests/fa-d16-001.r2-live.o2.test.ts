/**
 * Architecture open item O-2 ("Cloudflare R2 SigV4 signer — live-bucket test. One test against
 * the production bucket.") and FA-D16-001's "R2 adapter (SigV4, O-2 live test)".
 *
 * SKIPPED unless all four R2_LIVE_* variables are set. It is NOT run in CI and has NOT been run
 * by the change that added it: it needs real R2 credentials, which the repository never holds.
 * Operator run (README.md in platform/documents):
 *
 *   R2_LIVE_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
 *   R2_LIVE_BUCKET=<bucket> R2_LIVE_ACCESS_KEY_ID=<id> R2_LIVE_SECRET_ACCESS_KEY=<secret> \
 *   npm run test:r2-live
 *
 * It writes one encrypted object under firm "o2livetest", reads it from a second store
 * instance, proves R2 refuses an overwrite of the key (If-None-Match: *), and then tries to
 * delete it (a bucket lock rule, if enabled, keeps it: that is logged, not failed).
 */
import { randomBytes, randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import {
  createDocumentObjectStore,
  createR2DocumentObjectBackend,
  DocumentObjectExistsError,
  readR2DocumentObjectConfig,
} from "@/platform/documents/documentObjectStore"
import { newStore } from "@/platform/spine/store"

const live = {
  endpoint: process.env.R2_LIVE_ENDPOINT?.trim(),
  bucket: process.env.R2_LIVE_BUCKET?.trim(),
  accessKeyId: process.env.R2_LIVE_ACCESS_KEY_ID?.trim(),
  secretAccessKey: process.env.R2_LIVE_SECRET_ACCESS_KEY?.trim(),
}
const configured = Boolean(live.endpoint && live.bucket && live.accessKeyId && live.secretAccessKey)

// `npm run test:r2-live` sets R2_LIVE_REQUIRED=1: an operator who asked for the live run gets a
// failure, not a silent skip, when the credentials are missing.
if (process.env.R2_LIVE_REQUIRED === "1" && !configured) {
  throw new Error(
    "test:r2-live needs R2_LIVE_ENDPOINT, R2_LIVE_BUCKET, R2_LIVE_ACCESS_KEY_ID and R2_LIVE_SECRET_ACCESS_KEY"
  )
}

function liveStore() {
  // Validated exactly as production validates SIKANDER_R2_* (https endpoint, bucket name).
  const config = readR2DocumentObjectConfig({
    NODE_ENV: "production",
    SIKANDER_R2_ENDPOINT: live.endpoint,
    SIKANDER_R2_BUCKET: live.bucket,
    SIKANDER_R2_ACCESS_KEY_ID: live.accessKeyId,
    SIKANDER_R2_SECRET_ACCESS_KEY: live.secretAccessKey,
  })
  return createDocumentObjectStore(createR2DocumentObjectBackend(config))
}

const written: string[] = []

afterAll(async () => {
  for (const storagePath of written) {
    try {
      await liveStore().delete(storagePath)
    } catch (err) {
      console.warn(`[O-2] live test object ${storagePath} was not deleted (bucket lock?):`, err)
    }
  }
})

describe.skipIf(!configured)("O-2: document vault against the live Cloudflare R2 bucket", () => {
  it("writes ciphertext with SigV4, reads it from a second instance, and R2 refuses an overwrite", async () => {
    const store = newStore()
    const bytes = Buffer.concat([Buffer.from("%PDF-O-2 live bucket test\n"), randomBytes(1024)])
    const contentHash = store.hashKey("o2livetest", bytes)
    const docId = `doc_${randomUUID()}`
    const result = await liveStore().put({
      store,
      firmId: "o2livetest",
      docId,
      bytes,
      contentHash,
      mimeType: "application/pdf",
    })
    written.push(result.storagePath)
    expect(result.storagePath).toBe(`r2://o2livetest/documents/${docId}/v1`)

    const back = await liveStore().get(store, "o2livetest", result.storagePath, contentHash)
    expect(back.equals(bytes)).toBe(true)

    const other = Buffer.from("must not replace the stored object")
    await expect(
      liveStore().put({
        store,
        firmId: "o2livetest",
        docId,
        bytes: other,
        contentHash: store.hashKey("o2livetest", other),
        mimeType: "application/pdf",
      })
    ).rejects.toBeInstanceOf(DocumentObjectExistsError)
    const still = await liveStore().get(store, "o2livetest", result.storagePath, contentHash)
    expect(still.equals(bytes)).toBe(true)
  })
})
